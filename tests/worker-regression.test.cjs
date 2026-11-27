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
const event = () => ({ addListener(listener) { this.emit = listener; } });

async function settle() {
  for (let turn = 0; turn < 20; turn++) await new Promise(setImmediate);
}

function fixture() {
  let now = START;
  const values = {};
  const session = { 'shkolkovo.browserSession': 'fixture-boot' };
  const notifications = {};
  const reads = [];
  const alarms = new Map();
  const tab = { id: 1, windowId: 1, status: 'complete', active: false, autoDiscardable: false };
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
    runtime: { id: 'regression', getManifest: () => ({ version: '1.11.0' }), getURL: file => ORIGIN + file,
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
      get: async () => ({ ...tab }),
      update: async (_, fields) => {
        controls.lastTabUpdate = fields;
        return Object.assign(tab, fields);
      },
      sendMessage: async (_, request) => {
        if (request.type === 'monitor:ping') return controls.ping ? { ok: true } : null;
        if (request.type === 'monitor:snapshot') return { connection: controls.connection };
        if (request.type === 'monitor:read') {
          reads.push(request.id);
          return { id: request.id, ready: true, startReached: true, complete: true,
            messages: [{ id: 'message', role: 'service', author: 'Сервис', at: request.job.at }] };
        }
        return { ok: true };
      }
    },
    notifications: {
      onClosed: event(), onClicked: event(),
      getAll: async () => ({ ...notifications }),
      create: async (id, detail) => { notifications[id] = detail; return id; }
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
  context.ShSchedule = { read: (...args) => controls.schedule(...args) };
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
  return {
    state, controls, reads, notifications, saved: () => values[MONITOR_KEY],
    advance: delta => { now += delta; },
    plan: () => vm.runInContext('plan()', context),
    popup: type => dispatch({ url: ORIGIN + 'popup.html' }, { type }),
    report: fields => dispatch({ url: CHAT_URL, tab: { id: 1 }, frameId: 0, documentId: 'doc' },
      { type: 'monitor:coverage', session: String(state.scan.generation), observedAt: now, ...fields }),
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
  assert.equal((await f.report({ complete: true, partial: true, skipped: 1, scanned: 1, rows })).ok, true);
  await f.plan();
  await settle();
  assert.deepEqual(f.reads, ['recognized']);
  assert.match((await f.popup('ui:status')).scanStatus, /— 1/);
  assert.equal((await f.report({ complete: true, recovery: true, partial: true, skipped: 0,
    rows: [{ id: 'recovered', title: 'Fixture', at: START - 35 * MINUTE, precision: 'minute' }] })).ok, true);
  await f.plan();
  await settle();
  assert.deepEqual(f.reads, ['recognized', 'recovered']);
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
