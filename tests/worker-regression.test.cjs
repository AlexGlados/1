const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { webcrypto } = require('node:crypto');
const { test } = require('node:test');
const vm = require('node:vm');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MONITOR_KEY = 'shkolkovo.monitor.v2';
const CHAT_URL = 'https://1.shkolkovo.online/chat';
const TASK_ALARM = 'shkolkovo.tasks';
const ORIGIN = 'chrome-extension://regression/';
const START = Date.UTC(2026, 10, 27, 10, 18);
const { version } = require('../chrome/manifest.json');
const event = () => ({ addListener(listener) { this.emit = listener; } });

async function settle() {
  for (let turn = 0; turn < 20; turn++) await new Promise(setImmediate);
}

function fixture() {
  let now = START;
  let documentId = 'doc';
  let nextTab = 2;
  const values = {};
  const session = { 'shkolkovo.browserSession': 'fixture-boot' };
  const notifications = {};
  const reads = [];
  const created = [];
  const removed = [];
  const alarms = new Map();
  const tab = { id: 1, windowId: 1, status: 'complete', active: false, autoDiscardable: false };
  const tabs = new Map([[tab.id, tab]]);
  const controls = {
    failAlarm: false, failStorage: false, ping: true, connection: 'offline',
    schedule: async () => ({ names: ['Иван Петров'], directory: ['Иван Петров'] }),
    downloadName: 'C:\\Downloads\\logs\\renamed-shift.log'
  };
  function storage(target) {
    return {
      get: async key => ({ [key]: structuredClone(target[key]) }),
      set: async update => {
        if (controls.failStorage && Object.hasOwn(update, MONITOR_KEY)) {
          controls.failStorage = false;
          throw new Error('storage failed');
        }
        Object.assign(target, structuredClone(update));
      }
    };
  }
  const chrome = {
    runtime: { id: 'regression', getManifest: () => ({ version }), getURL: file => ORIGIN + file,
      onMessage: event(), onInstalled: event(), onStartup: event() },
    storage: { local: storage(values), session: storage(session) },
    alarms: {
      onAlarm: event(),
      get: async name => alarms.get(name),
      clear: async name => alarms.delete(name),
      create: async (name, properties) => {
        if (name === TASK_ALARM && controls.failAlarm) {
          controls.failAlarm = false;
          throw new Error('alarm failed');
        }
        alarms.set(name, { ...properties, scheduledTime: properties.when });
      }
    },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      get: async id => {
        if (!tabs.has(id)) throw new Error('tab missing');
        return { ...tabs.get(id) };
      },
      create: async options => {
        const tab = { id: nextTab++, windowId: 1, status: 'loading', autoDiscardable: true, ...options };
        tabs.set(tab.id, tab);
        created.push(tab.id);
        return { ...tab };
      },
      remove: async id => {
        tabs.delete(id);
        removed.push(id);
      },
      update: async (id, fields) => {
        controls.lastTabUpdate = fields;
        return Object.assign(tabs.get(id), fields);
      },
      sendMessage: async (_, request) => {
        if (request.type === 'monitor:ping') return controls.ping ? { ok: true } : null;
        if (request.type === 'monitor:snapshot') return { connection: controls.connection };
        if (request.type === 'monitor:read') {
          reads.push(request.id);
          if (controls.read) return controls.read(request);
          return { id: request.id, ready: true, startReached: true, complete: true,
            messages: [{ id: 'message', role: 'service', author: 'Сервис', at: request.job.at }] };
        }
        return { ok: true };
      }
    },
    notifications: {
      onClosed: event(), onClicked: event(),
      getAll: async () => ({ ...notifications }),
      create: async (id, detail) => {
        await controls.beforeNotification?.();
        notifications[id] = detail;
        return id;
      }
    },
    downloads: {
      onChanged: event(),
      download: async options => { controls.lastDownload = options; return 1; },
      search: async () => [{ state: 'complete', filename: controls.downloadName }]
    }
  };
  class Clock extends Date {
    static now() { return now; }
  }
  const context = vm.createContext({
    chrome, Date: Clock, URL, crypto: webcrypto, AbortSignal, setTimeout: () => 0, clearTimeout() {},
    queueMicrotask() {}, fetch: async () => ({ ok: false }), console,
    importScripts(...files) { for (const file of files) load(file); }
  });
  function load(file) {
    vm.runInContext(readFileSync(join(__dirname, '../chrome', file), 'utf8'), context, { filename: file });
  }
  load('background.js');
  const schedule = context.ShSchedule;
  context.ShSchedule = {
    ...schedule,
    read: (...args) => controls.useRealSchedule ? schedule.read(...args) : controls.schedule(...args)
  };
  context.ShkolkovoLogFolder = { write: async () => false };
  const state = vm.runInContext(`(() => {
    const state = blank();
    state.scan.curatorName = 'Иван Петров';
    E.start(state.scan, Date.now());
    E.installRoster(state.scan, { generation: state.scan.generation, period: state.scan.period },
      [state.scan.curatorName], null, Date.now());
    Object.assign(state, { tab: 1, lastWatchTab: 1, doc: 'doc', ready: true, boot: 'fixture-boot',
      syncAt: Date.now() + 60_000, pageCheckAt: Date.now() + 60_000 });
    state.scan.startupCutoff = null;
    return state;
  })()`, context);
  values[MONITOR_KEY] = state;
  const dispatch = (sender, message) => new Promise(resolve => {
    assert.equal(chrome.runtime.onMessage.emit(message, { id: 'regression', ...sender }, resolve), true);
  });
  const fromContent = (type, fields) => dispatch({ url: CHAT_URL, tab: { id: 1 }, frameId: 0, documentId },
    { type, session: String(state.scan.generation), observedAt: now, ...fields });
  return {
    state, controls, reads, notifications, created, removed, saved: () => values[MONITOR_KEY],
    advance: delta => { now += delta; },
    plan: () => vm.runInContext('plan()', context),
    popup: type => dispatch({ url: ORIGIN + 'popup.html' }, { type }),
    rows: rows => fromContent('monitor:rows', { rows }),
    report: fields => fromContent('monitor:coverage', fields),
    startupBlock: reason => fromContent('monitor:startup-block', { reason }),
    wake: fields => fromContent('monitor:wake', fields),
    recovery: () => fromContent('monitor:recovery-next'),
    async reload() {
      chrome.tabs.onUpdated.emit(tab.id, { status: 'loading' });
      documentId = 'new-document';
      await fromContent('monitor:hello');
    },
    prepareReport() {
      context.testState = state;
      vm.runInContext("shiftLog.start(testState, Date.now()); shiftLog.finish(testState, Date.now(), 'manual');", context);
    },
    queueOffline() {
      const since = now - 3000;
      state.connection = { status: 'offline', episode: 'offline', since, onlineSeen: true, alerted: true };
      state.outbox.notice = { kind: 'offline', session: String(state.scan.generation), doc: 'doc', since, tab: 1, retryAt: 0 };
    }
  };
}

test('the next pass delivers after a task alarm failure', async () => {
  const f = fixture();
  f.queueOffline();
  f.controls.failAlarm = true;
  await assert.rejects(f.plan(), /alarm failed/);
  assert.deepEqual(Object.keys(f.notifications), []);
  await f.plan();
  await settle();
  assert.deepEqual(Object.keys(f.notifications), ['notice']);
  assert.equal(f.saved().outbox.notice, undefined);
});

const FREE_CHAT_ID = 'id:1__2__3';
const freeRow = (at, signal) => ({
  id: FREE_CHAT_ID, title: 'Fixture', at, signal, precision: 'exact', unread: true
});
const student = (id, at) => ({ id, at, role: 'student', author: 'Fixture' });
const freeHistory = (id, ...messages) => ({ id, identity: '1__2__3', ready: true, startReached: true, complete: true, messages });

for (const role of ['student', 'staff']) {
  test('queued free alert waits for a confirmed new ' + role + ' message', async () => {
    const f = fixture();
    const first = student('first', START);
    const recheck = Promise.withResolvers();
    f.controls.read = ({ id, job }) => job.signal === first.id ? freeHistory(id, first) : recheck.promise;

    await f.rows([freeRow(first.at, first.id)]);
    await f.plan();
    await settle();
    const [queuedId] = Object.keys(f.saved().outbox);
    assert.ok(queuedId);

    f.advance(1000);
    const next = { id: 'next', at: START + 1000, role, author: role === 'staff' ? 'Иван Петров' : 'Fixture' };
    await f.rows([freeRow(next.at, next.id)]);
    await f.plan();
    await settle();
    assert.deepEqual(Object.keys(f.saved().outbox), [queuedId]);
    assert.deepEqual(Object.keys(f.notifications), []);
    assert.equal(f.saved().scan.chats[FREE_CHAT_ID].freeNotifiedEpisode, undefined);

    recheck.resolve(freeHistory(FREE_CHAT_ID, first, next));
    await settle();
    await f.plan();
    await settle();
    assert.deepEqual(Object.keys(f.saved().outbox), []);
    assert.deepEqual(Object.keys(f.notifications), role === 'student' ? [queuedId] : []);
    assert.equal(f.saved().scan.chats[FREE_CHAT_ID].freeNotifiedEpisode, role === 'student' ? 'id:first' : undefined);
  });
}

test('a second student message after a delivered free alert does not repeat the first alert', async () => {
  const f = fixture();
  const first = student('first', START);
  f.controls.read = ({ id }) => freeHistory(id, first);
  await f.rows([freeRow(first.at, first.id)]);
  await f.plan();
  await settle();
  await f.plan();
  await settle();
  const [deliveredId] = Object.keys(f.notifications);
  assert.ok(deliveredId);

  f.advance(1000);
  const next = student('next', START + 1000);
  f.controls.read = ({ id }) => freeHistory(id, first, next);
  await f.rows([freeRow(next.at, next.id)]);
  await f.plan();
  await settle();
  await f.plan();
  await settle();
  assert.deepEqual(Object.keys(f.notifications), [deliveredId]);
  assert.equal(f.saved().notified, 1);
});

test('a pending first free alert keeps the retry and absorbs reminder thresholds on delivery', async () => {
  const f = fixture();
  const first = student('first', START - 4.5 * MINUTE);
  let attempts = 0;
  f.controls.read = ({ id }) => freeHistory(id, first);
  f.controls.beforeNotification = () => {
    if (++attempts === 1) throw new Error('notification failed');
  };
  await f.rows([freeRow(first.at, first.id)]);
  await f.plan();
  await settle();
  const [queuedId] = Object.keys(f.saved().outbox);
  await f.plan();
  await settle();
  assert.equal(f.saved().outbox[queuedId].retryAt, START + MINUTE);

  f.advance(45_000);
  await f.plan();
  await settle();
  assert.equal(attempts, 1);
  assert.deepEqual(Object.keys(f.notifications), []);
  assert.equal(f.saved().scan.chats[FREE_CHAT_ID].freeNotifiedEpisode, undefined);

  f.advance(15_000);
  await f.plan();
  await settle();
  assert.deepEqual(Object.keys(f.notifications), [queuedId]);
  assert.equal(attempts, 2);
  assert.equal(f.saved().scan.chats[FREE_CHAT_ID].remindedMinute, 5);
});

test('a free alert expires at exactly twenty minutes if it has not been delivered', async () => {
  const f = fixture();
  const first = student('first', START - 19.5 * MINUTE);
  f.controls.read = ({ id }) => freeHistory(id, first);
  await f.rows([freeRow(first.at, first.id)]);
  await f.plan();
  await settle();
  assert.equal(Object.keys(f.saved().outbox).length, 1);

  f.advance(30_000);
  await f.plan();
  await settle();
  assert.deepEqual(Object.keys(f.saved().outbox), []);
  assert.deepEqual(Object.keys(f.notifications), []);
});

test('an accepted free alert is recorded once after its first storage write fails', async () => {
  const f = fixture();
  const first = student('first', START);
  let attempts = 0;
  f.controls.read = ({ id }) => freeHistory(id, first);
  f.controls.beforeNotification = () => {
    if (++attempts === 1) f.controls.failStorage = true;
  };
  await f.rows([freeRow(first.at, first.id)]);
  await f.plan();
  await settle();
  const [queuedId] = Object.keys(f.saved().outbox);

  await f.plan();
  await settle();
  assert.deepEqual(Object.keys(f.notifications), [queuedId]);
  assert.ok(f.saved().outbox[queuedId]);
  assert.equal(f.saved().notified, 0);

  await f.plan();
  await settle();
  assert.equal(attempts, 1);
  assert.equal(f.saved().notified, 1);
  assert.equal(f.saved().scan.chats[FREE_CHAT_ID].freeNotifiedEpisode, 'id:first');
  assert.deepEqual(Object.keys(f.saved().outbox), []);
});

test('the next pass delivers after the planner fails to persist its state', async () => {
  const f = fixture();
  f.queueOffline();
  f.state.pageCheckAt = 0;
  f.controls.failStorage = true;
  await assert.rejects(f.plan(), /storage failed/);
  assert.deepEqual(Object.keys(f.notifications), []);
  await f.plan();
  await settle();
  assert.deepEqual(Object.keys(f.notifications), ['notice']);
});

test('the offline episode survives an unknown confirmation and delivers once', async () => {
  const f = fixture();
  f.queueOffline();
  f.state.connection.status = 'unknown';
  f.controls.connection = undefined;
  await f.plan();
  await settle();
  assert.ok(f.saved().outbox.notice.retryAt > START);
  assert.deepEqual(Object.keys(f.notifications), []);
  f.advance(5000);
  f.controls.connection = 'offline';
  await f.plan();
  await settle();
  assert.deepEqual(Object.keys(f.notifications), ['notice']);
  assert.equal(f.saved().outbox.notice, undefined);
});

test('the worker detects an unavailable page before rows arrive and can return to chats', async () => {
  const f = fixture();
  Object.assign(f.state, { doc: null, ready: false, pageCheckAt: 0 });
  f.controls.ping = false;
  await f.plan();
  await settle();
  assert.equal((await f.popup('ui:status')).tabBlock, 'page');
  assert.equal((await f.popup('ui:return-to-chats')).ok, true);
  assert.equal(f.controls.lastTabUpdate.url, CHAT_URL);
});

test('recognized rows are read before startup completes and a later replay does not requeue them', async () => {
  const f = fixture();
  f.state.scan.startupCutoff = START - 45 * MINUTE;
  const rows = [{ id: 'recognized', title: 'Fixture', at: START - 30 * MINUTE, precision: 'minute' }];
  assert.equal((await f.report({ complete: false, partial: true, skipped: 1, scanned: 1, rows })).ok, true);
  await f.plan();
  await settle();
  assert.deepEqual(f.reads, ['recognized']);
  assert.equal((await f.report({ complete: true, partial: true, skipped: 1, scanned: 1, rows,
    recoveryRanges: [{ first: 2, last: 2, before: { position: 1, key: 'recognized' } }] })).ok, true);
  await f.plan();
  await settle();
  assert.deepEqual(f.reads, ['recognized']);
  assert.match((await f.popup('ui:status')).scanStatus, /— 1/);
  const { recovery } = await f.recovery();
  assert.equal((await f.report({ recovery: true, recoveryId: recovery.id,
    results: [{ position: 2, resolved: true, rowId: 'recovered' }],
    rows: [{ id: 'recovered', title: 'Fixture', at: START - 35 * MINUTE, precision: 'minute' }] })).ok, true);
  await f.plan();
  await settle();
  assert.deepEqual(f.reads, ['recognized', 'recovered']);
});

test('all 181 skipped positions receive a bounded attempt and an in-flight batch survives reload', async () => {
  const f = fixture();
  f.state.scan.startupCutoff = START - 45 * MINUTE;
  assert.equal((await f.report({ complete: true, partial: true, skipped: 181, scanned: 0, rows: [],
    recoveryRanges: [{ first: 2, last: 182, before: { position: 1, key: 'before' },
      after: { position: 183, key: 'after' } }] })).ok, true);
  const first = (await f.recovery()).recovery;
  assert.equal(first.targets.length, 8);
  assert.equal(first.targets[0].position, 2);
  await f.reload();
  assert.equal((await f.recovery()).recovery.id, first.id);
  const attempted = [];
  let batch = first;
  while (batch) {
    assert.ok(batch.targets.length <= 8);
    const results = batch.targets.map(({ position }) => ({ position, resolved: position !== 2, rowId: 'row-' + position }));
    attempted.push(...results.map(result => result.position));
    const report = { recovery: true, recoveryId: batch.id, results, rows: [] };
    assert.equal((await f.report(report)).ok, true);
    assert.equal((await f.report(report)).ok, true);
    batch = (await f.recovery()).recovery;
    assert.ok(attempted.length <= 182);
  }
  assert.deepEqual(attempted, [...Array.from({ length: 181 }, (_, index) => index + 2), 2]);
  assert.equal(f.saved().coverage.skipped, 1);
});

test('a known chat moved into a skipped position does not resolve the gap or increase coverage', async () => {
  const f = fixture();
  f.state.scan.startupCutoff = START - 45 * MINUTE;
  const known = { id: 'known', title: 'Known', at: START - 5 * MINUTE, precision: 'minute', position: 1 };
  assert.equal((await f.report({ complete: true, partial: true, skipped: 1, rows: [known],
    recoveryRanges: [{ first: 2, last: 2, before: { position: 1, key: known.id },
      after: { position: 3, key: 'after' } }] })).ok, true);
  let batch = (await f.recovery()).recovery;
  assert.equal(batch.targets[0].before.key, known.id);
  assert.equal((await f.report({ recovery: true, recoveryId: batch.id,
    results: [{ position: 2, resolved: true, rowId: known.id }], rows: [{ ...known, position: 2 }] })).ok, true);
  assert.equal(f.saved().coverage.scanned, 1);
  assert.equal(f.saved().coverage.skipped, 1);
  batch = (await f.recovery()).recovery;
  assert.equal(batch.targets[0].after.key, 'after');
  const recovered = { ...known, id: 'recovered', position: 2 };
  assert.equal((await f.report({ recovery: true, recoveryId: batch.id,
    results: [{ position: 2, resolved: true, rowId: recovered.id }], rows: [known, recovered, recovered] })).ok, true);
  assert.equal(f.saved().coverage.scanned, 2);
  assert.equal(f.saved().coverage.skipped, 0);
});

test('a newly discovered chat is counted once and resolves a gap when its anchors later match', async () => {
  const f = fixture();
  f.state.scan.startupCutoff = START - 45 * MINUTE;
  const row = { id: 'new', title: 'New', at: START - 5 * MINUTE, precision: 'minute', position: 2 };
  assert.equal((await f.report({ complete: true, partial: true, skipped: 1, rows: [],
    recoveryRanges: [{ first: 2, last: 2, before: { position: 1, key: 'before' },
      after: { position: 3, key: 'after' } }] })).ok, true);
  let batch = (await f.recovery()).recovery;
  assert.equal((await f.report({ recovery: true, recoveryId: batch.id,
    results: [{ position: 2, resolved: false }], rows: [row] })).ok, true);
  assert.equal(f.saved().coverage.scanned, 1);
  assert.equal(f.saved().coverage.skipped, 1);
  batch = (await f.recovery()).recovery;
  assert.equal((await f.report({ recovery: true, recoveryId: batch.id,
    results: [{ position: 2, resolved: true, rowId: row.id }], rows: [row] })).ok, true);
  assert.equal(f.saved().coverage.scanned, 1);
  assert.equal(f.saved().coverage.skipped, 0);
});

test('a rejected ready history logs a reason code without the chat or message metadata', async () => {
  const f = fixture();
  f.state.scan.startupCutoff = START - 45 * MINUTE;
  f.controls.read = ({ id, job }) => ({ id, identity: '1__2__3', ready: true, startReached: true, complete: true,
    messages: [{ at: job.at, role: 'student', author: 'Fixture name' }] });
  await f.report({ complete: true, partial: true, recoveryRanges: [],
    rows: [{ id: 'id:1__2__3', title: 'Fixture title', at: START - 5 * MINUTE, precision: 'minute' }] });
  await f.plan();
  await settle();
  const failure = f.saved().shiftLogs.active.events.find(event => event.event === 'chat_check_failed');
  assert.equal(failure.details.reason, 'message_id_missing');
  assert.deepEqual(Object.keys(failure.details), ['reason']);
  assert.equal(f.saved().checked, 0);
});

test('a minute overlapping the startup cutoff is retried while exact history is decided precisely', async () => {
  const at = START - 45 * MINUTE;
  const cutoff = at + 30_000;
  for (const [time, precision, checked, failure, earlierAt] of [
    [at, 'minute', 0, 'message_time_unconfirmed'],
    [cutoff, 'exact', 0, undefined],
    [cutoff + 1, 'exact', 1, undefined],
    [at, 'minute', 0, 'message_time_unconfirmed', cutoff - 1],
    [at, 'minute', 1, undefined, cutoff + 1]
  ]) {
    const f = fixture();
    f.state.scan.startupCutoff = cutoff;
    f.controls.read = ({ id }) => ({ id, identity: '1__2__3', ready: true, startReached: true, complete: true,
      messages: [
        ...(Number.isFinite(earlierAt) ? [{ id: 'earlier', at: earlierAt, precision: 'exact', role: 'service' }] : []),
        { id: 'tail', at: time, precision, role: 'student', author: 'Fixture' }
      ] });
    await f.report({ complete: true, partial: true, recoveryRanges: [],
      rows: [{ id: 'id:1__2__3', title: 'Fixture', at, precision: 'minute' }] });
    await f.plan();
    await settle();

    const saved = f.saved();
    assert.equal(saved.checked, checked);
    assert.equal(saved.shiftLogs.active.events.find(event => event.event === 'chat_check_failed')?.details.reason, failure);
    assert.equal(Boolean(saved.scan.chats['id:1__2__3'].pending), Boolean(failure));
  }
});

test('startup block is visible before rows are ready and logs only transitions', async () => {
  const f = fixture();
  f.state.scan.startupCutoff = START - 45 * MINUTE;
  f.state.ready = false;
  f.state.pageCheckAt = 0;
  await f.startupBlock('in_use');
  await f.plan();
  await settle();
  const waiting = await f.popup('ui:status');
  assert.equal(waiting.ready, false);
  assert.equal(waiting.scanComplete, null);
  assert.equal(waiting.tabBlock, 'in_use');
  await f.startupBlock('in_use');
  await f.startupBlock('draft');
  assert.equal((await f.popup('ui:status')).tabBlock, 'draft');
  await f.startupBlock('');
  assert.equal((await f.popup('ui:status')).tabBlock, '');
  assert.deepEqual(f.saved().shiftLogs.active.events.filter(event => event.event.startsWith('chat_list_'))
    .map(event => [event.event, event.details.reason ?? event.details.previousReason]),
  [['chat_list_deferred', 'in_use'], ['chat_list_deferred', 'draft'], ['chat_list_resumed', 'draft']]);

  await f.report({ complete: true, rows: [], recoveryRanges: [] });
  await f.startupBlock('in_use');
  assert.equal((await f.popup('ui:status')).tabBlock, '');
});

test('stopping the targeted search at the time boundary has a distinct journal code', async () => {
  const f = fixture();
  f.state.scan.startupCutoff = START - 45 * MINUTE;
  f.controls.read = () => ({ ready: false, reasonCode: 'row_time_boundary' });
  await f.report({ complete: true, partial: true, recoveryRanges: [],
    rows: [{ id: 'target', title: 'Fixture title', at: START - 5 * MINUTE, precision: 'minute' }] });
  await f.plan();
  await settle();
  const failure = f.saved().shiftLogs.active.events.find(event => event.event === 'chat_check_failed');
  assert.equal(failure.details.reason, 'row_time_boundary');
});

test('an unavailable range before the time boundary has its own journal code', async () => {
  const f = fixture();
  f.state.scan.startupCutoff = START - 45 * MINUTE;
  f.controls.read = () => ({ ready: false, reasonCode: 'row_range_unavailable' });
  await f.report({ complete: true, partial: true, recoveryRanges: [],
    rows: [{ id: 'target', title: 'Fixture title', at: START - 5 * MINUTE, precision: 'minute' }] });
  await f.plan();
  await settle();
  const failure = f.saved().shiftLogs.active.events.find(event => event.event === 'chat_check_failed');
  assert.equal(failure.details.reason, 'row_range_unavailable');
});

test('a busy tab defers the entire queue and resumes immediately on read completion', async () => {
  const f = fixture();
  f.state.scan.startupCutoff = START - 45 * MINUTE;
  const rows = Array.from({ length: 16 }, (_, index) => ({
    id: 'chat-' + index, title: 'Fixture', at: START - 5 * MINUTE - index * MINUTE, precision: 'minute'
  }));
  f.controls.read = () => ({ blocked: true, tabBlock: 'read_busy' });
  await f.report({ complete: true, partial: true, recoveryRanges: [], rows });
  await f.plan();
  await settle();
  assert.equal(f.reads.length, 1);
  assert.equal(f.saved().tabBlock.reason, 'read_busy');
  for (let attempt = 0; attempt < 3; attempt++) await f.plan();
  await f.wake();
  await f.plan();
  await settle();
  assert.equal(f.reads.length, 1);
  f.advance(10_000);
  await f.plan();
  await settle();
  assert.equal(f.reads.length, 2);
  assert.equal(f.reads[0], f.reads[1]);
  const deferred = f.saved().shiftLogs.active.events.filter(event => event.event === 'chat_check_deferred');
  assert.deepEqual(deferred.map(event => event.details.reason), ['read_busy']);
  f.controls.read = null;
  await f.wake({ readReady: true });
  await f.plan();
  await settle();
  for (let pass = 0; pass < rows.length - 1; pass++) {
    await f.plan();
    await settle();
  }
  assert.equal(f.saved().checked, rows.length);
});

test('completion delivered before a busy reply still allows the next read', async () => {
  const f = fixture();
  f.state.scan.startupCutoff = START - 45 * MINUTE;
  f.controls.read = async () => {
    f.controls.read = null;
    await f.wake({ readReady: true });
    return { blocked: true, tabBlock: 'read_busy' };
  };
  await f.report({ complete: true, partial: true, recoveryRanges: [],
    rows: [{ id: 'target', title: 'Fixture', at: START - 5 * MINUTE, precision: 'minute' }] });
  await f.plan();
  await settle();
  assert.equal(f.saved().tabBlock.retryAt, START);
  await f.plan();
  await settle();
  assert.equal(f.saved().checked, 1);
});

test('a schedule failure records the fixed cause without the underlying error details', async () => {
  const f = fixture();
  f.state.scan.roster = null;
  f.controls.useRealSchedule = true;
  await f.plan();
  await settle();
  const failure = f.saved().shiftLogs.active.events.find(event => event.event === 'schedule_failed');
  assert.equal(failure.details.reason, 'schedule_config');
  assert.deepEqual(Object.keys(failure.details).sort(), ['hourMsk', 'reason']);
});

test('the journal waits for a first confirmed duty hour even across a schedule retry', async () => {
  const f = fixture();
  f.state.scan.roster = null;
  const requests = [];
  f.controls.schedule = async (date, hour) => {
    requests.push([date, hour]);
    throw Object.assign(new Error('Schedule timed out'), { code: 'schedule_timeout' });
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await f.plan();
    await settle();
    assert.equal(f.saved().shiftLogs.active.lastDutyPeriod, null);
    f.advance(5 * MINUTE);
  }
  assert.deepEqual(requests, [['2026-11-27', 13], ['2026-11-27', 13]]);
  assert.equal(f.saved().shiftLogs.active.events.some(event => event.details?.scope === 'journal'), false);

  f.controls.schedule = async () => ({ names: ['Иван Петров'], directory: ['Иван Петров'] });
  await f.plan();
  await settle();
  assert.equal(f.saved().shiftLogs.active.lastDutyPeriod, Date.UTC(2026, 10, 27, 10));
});

test('failed manual starts remove only the tabs the attempts created', async () => {
  const f = fixture();
  Object.assign(f.state, { tab: null, lastWatchTab: null, doc: null, ready: false });
  f.state.scan.enabled = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    f.controls.failStorage = true;
    assert.equal((await f.popup('ui:start')).ok, false);
  }
  assert.deepEqual(f.created, [2, 3]);
  assert.deepEqual(f.removed, f.created);
  assert.equal(f.saved().scan.enabled, false);
});

test('a failed manual start keeps a previously existing tab', async () => {
  const f = fixture();
  Object.assign(f.state, { tab: null, doc: null, ready: false });
  f.state.scan.enabled = false;
  f.controls.failStorage = true;
  assert.equal((await f.popup('ui:start')).ok, false);
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.removed, []);
});

test('a retired duty hour is requested after waking and closes only the journal', async () => {
  const f = fixture();
  await f.plan();
  await settle();
  const firstDuty = f.saved().shiftLogs.active.lastDutyPeriod;
  f.advance(2 * HOUR);
  const queriedHours = [];
  f.controls.schedule = async (_, hour) => {
    queriedHours.push(hour);
    return { names: [], directory: [] };
  };
  await f.plan();
  await settle();
  assert.ok(queriedHours.includes(14));
  assert.equal(f.saved().shiftLogs.pending[0].endedAt, firstDuty + HOUR);
  assert.equal(f.saved().scan.period, firstDuty + 2 * HOUR);
});

test('fallback uses a binary download and records the filename returned by Chrome', async () => {
  const f = fixture();
  f.prepareReport();
  await f.plan();
  await settle();
  assert.match(f.controls.lastDownload.url, /^data:application\/octet-stream,/);
  assert.equal(f.saved().shiftLogs.lastExport.filename, 'renamed-shift.log');
  assert.equal(f.saved().shiftLogs.lastExport.where, 'downloads');
});
