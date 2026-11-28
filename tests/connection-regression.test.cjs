const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../chrome/connection.js'), 'utf8');

function fixture({ initiallyOnline = true } = {}) {
  let now = 0;
  let sequence = 0;
  let badge = 'online';
  const timers = new Map();
  const changes = [];
  const alerts = [];
  const window = new EventTarget();
  const navigator = { onLine: initiallyOnline };
  class Clock extends Date {
    static now() { return now; }
  }
  const context = vm.createContext({
    Date: Clock, window, navigator, document: { body: {} },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(source, context, { filename: 'connection.js' });
  const monitor = context.ShkolkovoConnection.create({
    dom: { getConnectionBadge: () => badge && { status: badge } },
    onChange: status => changes.push(status),
    send: async status => { alerts.push(status); return { ok: true }; }
  });
  const setNetwork = onLine => {
    navigator.onLine = onLine;
    window.dispatchEvent(new Event(onLine ? 'online' : 'offline'));
  };
  async function advance(ms) {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.callback();
    }
    await Promise.resolve();
  }
  return { monitor, changes, alerts, advance, setNetwork, setBadge: status => { badge = status; monitor.refresh(); } };
}

test('browser offline overrides a stale green site badge and debounces the alert', async () => {
  const f = fixture();
  f.monitor.start();
  assert.equal(f.monitor.details().connection, 'online');

  f.setNetwork(false);
  assert.equal(f.monitor.details().connection, 'offline');
  await f.advance(1999);
  f.setNetwork(true);
  await f.advance(1);
  assert.deepEqual(f.alerts, []);
  assert.equal(f.monitor.details().connection, 'online');

  f.setNetwork(false);
  await f.advance(2000);
  await f.advance(3000);
  assert.deepEqual(f.alerts, ['offline']);
  assert.equal(f.monitor.details().connection, 'offline');
  f.setBadge('connecting');
  f.setNetwork(true);
  assert.equal(f.monitor.details().connection, 'connecting');
  assert.deepEqual(f.changes, ['online', 'offline', 'online', 'offline', 'connecting']);

  f.monitor.stop();
  f.setNetwork(false);
  assert.equal(f.monitor.details().connection, null);
  assert.deepEqual(f.alerts, ['offline']);
});

test('a reload while the browser is offline waits for confirmed online before an alert', async () => {
  const f = fixture({ initiallyOnline: false });
  f.monitor.start();
  assert.equal(f.monitor.details().connection, 'offline');
  await f.advance(5000);
  assert.deepEqual(f.alerts, []);

  f.setNetwork(true);
  f.setBadge('offline');
  await f.advance(2000);
  assert.deepEqual(f.alerts, ['offline']);
});
