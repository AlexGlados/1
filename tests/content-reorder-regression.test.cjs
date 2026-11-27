const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const AT = Date.parse('2026-11-27T12:03:30Z');
const MINUTE_START = Date.parse('2026-11-27T12:03:00Z');
const MINUTE = 60_000;
const ROW_A = 'id:1__2__1';
const ROW_B = 'id:1__2__2';
const ROW_C = 'id:1__2__3';
const ROW_D = 'id:1__2__4';
const source = readFileSync(join(__dirname, '../chrome/content.js'), 'utf8');

function row(key, position, at = AT, precision = 'exact') {
  return { key, position, at, precision, label: 'Synthetic chat', element: { isConnected: true } };
}

function fixture(total, initialFrame) {
  let render = initialFrame;
  let scrollTop = 0;
  const observers = new Set();
  const messages = [];
  const replies = new Map();
  class Clock extends Date {
    static now() { return AT + MINUTE; }
  }
  class Observer {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const root = {
    isConnected: true,
    clientHeight: 100,
    scrollHeight: 100 + total * 100,
    get scrollTop() { return scrollTop; },
    set scrollTop(value) {
      scrollTop = value;
      queueMicrotask(() => { for (const observer of [...observers]) observer.callback([]); });
    },
    querySelectorAll: () => []
  };
  const dom = {
    getVirtualList: () => root,
    getRows: () => render(scrollTop),
    getListLayout: () => ({ total, positions: render(scrollTop).map(({ position, key }) => ({
      position, key, top: (position - 1) * 100
    })) }),
    recentWindow: 20 * MINUTE
  };
  const context = vm.createContext({
    AbortController,
    Date: Clock,
    MutationObserver: Observer,
    queueMicrotask,
    location: { origin: 'https://1.shkolkovo.online', pathname: '/chat' },
    navigator: { onLine: true },
    document: { hidden: true, body: {}, hasFocus: () => false, getElementById: () => null,
      querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener() {} },
    setTimeout(callback, delay) {
      // Virtual rendering settles synchronously in the fixture. Leave the
      // ordinary capture/recovery timers idle until the test calls the entry point.
      if (delay === 180) queueMicrotask(callback);
      return 1;
    },
    setInterval: () => 1,
    clearTimeout() {},
    clearInterval() {},
    chrome: { runtime: { id: 'fixture', onMessage: { addListener() {} }, sendMessage: async message => {
      messages.push(message);
      return replies.get(message.type) ?? { ok: true };
    } } },
    ShkolkovoDom: dom,
    ShkolkovoConnection: { create: () => ({
      details: () => ({ connection: 'online' }), start() {}, stop() {}, setListRoot() {}
    }) }
  });
  const end = '  void hello(revision);';
  assert.ok(source.includes(end), 'content fixture must replace startup at the live script entry point');
  vm.runInContext(source.replace(end, '  globalThis.testApi = { setSession, reportHead, seekRow, read, recoverSkipped };'),
    context, { filename: 'content.js' });
  const api = context.testApi;
  api.setSession('fixture-session', 'Иван Петров', null, AT - MINUTE);
  return { api, root, messages, replies, render: next => { render = next; } };
}

function captures(f) {
  return f.messages.filter(message => message.type === 'monitor:rows');
}

test('reordering one chat between virtual frames withholds the head watermark', async () => {
  const f = fixture(3, scroll => scroll === 0
    ? [row(ROW_A, 1)]
    : [row(ROW_A, 2), row(ROW_C, 3)]);

  await f.api.reportHead(f.root, AT - MINUTE, AT + MINUTE, true);

  const unstable = captures(f).at(-1);
  assert.deepEqual(Array.from(unstable.rows, item => item.id).sort(), [ROW_A, ROW_C]);
  assert.equal(Object.hasOwn(unstable, 'headThrough'), false);

  f.render(scroll => scroll === 0
    ? [row(ROW_A, 1), row(ROW_B, 2)]
    : [row(ROW_B, 2), row(ROW_C, 3)]);
  await f.api.reportHead(f.root, AT - MINUTE, AT + MINUTE, true);

  const stable = captures(f).at(-1);
  assert.deepEqual(Array.from(stable.rows, item => item.id).sort(), [ROW_A, ROW_B, ROW_C]);
  assert.equal(stable.headThrough, AT + MINUTE);
});

test('a changed row at the same position interrupts coverage across overlapping frames', async () => {
  const f = fixture(3, scroll => scroll === 0
    ? [row(ROW_A, 1), row(ROW_B, 2)]
    : [row(ROW_D, 2), row(ROW_C, 3)]);

  await f.api.reportHead(f.root, AT - MINUTE, AT + MINUTE, true);

  const capture = captures(f).at(-1);
  assert.ok(capture.rows.some(item => item.id === ROW_D));
  assert.equal(Object.hasOwn(capture, 'headThrough'), false);
});

test('a changed head while returning to the top also withholds the watermark', async () => {
  let moved = false;
  const f = fixture(3, scroll => {
    if (scroll === 0) return [row(moved ? ROW_D : ROW_A, 1), row(ROW_B, 2)];
    moved = true;
    return [row(ROW_B, 2), row(ROW_C, 3)];
  });

  await f.api.reportHead(f.root, AT - MINUTE, AT + MINUTE, true);

  const capture = captures(f).at(-1);
  assert.ok(capture.rows.some(item => item.id === ROW_D));
  assert.equal(Object.hasOwn(capture, 'headThrough'), false);
});

test('targeted search continues past a minute-precision row in the target minute', async () => {
  const f = fixture(2, scroll => scroll === 0
    ? [row(ROW_A, 1, MINUTE_START, 'minute')]
    : [row(ROW_B, 2)]);
  const result = await f.api.seekRow(
    ROW_B, undefined, new AbortController().signal, () => true, AT + 2 * MINUTE, AT - MINUTE, AT
  );

  assert.equal(result?.key, ROW_B);
});

test('targeted search reports a distinct reason when it reaches older rows', async () => {
  const f = fixture(2, scroll => scroll === 0
    ? [row(ROW_A, 1, MINUTE_START - MINUTE, 'minute')]
    : [row(ROW_B, 2, MINUTE_START - 2 * MINUTE, 'minute')]);
  const search = {};

  const result = await f.api.seekRow(
    ROW_C, undefined, new AbortController().signal, () => true, AT + 2 * MINUTE, AT - 5 * MINUTE, AT, search
  );

  assert.equal(result, null);
  assert.equal(search.reasonCode, 'row_time_boundary');
  const reply = await f.api.read({ id: ROW_C, session: 'fixture-session', expiresAt: AT + 2 * MINUTE,
    job: { rowKey: ROW_C, at: AT, minActivityAt: AT - 5 * MINUTE } });
  assert.equal(reply.ready, false);
  assert.equal(reply.reasonCode, 'row_time_boundary');
});

function recoverPosition(f) {
  f.replies.set('monitor:recovery-next', {
    ok: true,
    recovery: {
      id: 'fixture-batch', cutoff: AT - MINUTE,
      targets: [{ position: 2, before: { position: 1, key: ROW_A }, after: { position: 3, key: ROW_C } }]
    }
  });
  return f.api.recoverSkipped();
}

test('positional recovery reports the actual row identity between matching anchors', async () => {
  const f = fixture(3, () => [row(ROW_A, 1), row(ROW_B, 2), row(ROW_C, 3)]);

  await recoverPosition(f);

  const coverage = f.messages.find(message => message.type === 'monitor:coverage');
  assert.equal(coverage.results[0].resolved, true);
  assert.equal(coverage.results[0].rowId, ROW_B);
});

test('positional recovery does not treat a moved anchor as the missing chat', async () => {
  const f = fixture(3, () => [row(ROW_D, 1), row(ROW_A, 2), row(ROW_C, 3)]);

  await recoverPosition(f);

  const coverage = f.messages.find(message => message.type === 'monitor:coverage');
  assert.equal(coverage.results[0].resolved, false);
  assert.ok(coverage.rows.some(item => item.id === ROW_D));
});

test('positional recovery translates the gap after both anchors shift equally', async () => {
  const f = fixture(4, () => [row(ROW_D, 1), row(ROW_A, 2), row(ROW_B, 3), row(ROW_C, 4)]);

  await recoverPosition(f);

  const coverage = f.messages.find(message => message.type === 'monitor:coverage');
  assert.equal(coverage.results[0].resolved, true);
  assert.equal(coverage.results[0].rowId, ROW_B);
});
