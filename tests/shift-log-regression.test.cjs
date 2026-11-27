const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FIRST = Date.UTC(2026, 10, 27, 20);
const CURATOR = 'Иван Петров';
const hour = offset => FIRST + offset * HOUR;
const stamp = (offset, minute) => hour(offset) + minute * MINUTE;

function fixture() {
  const context = vm.createContext({ crypto: webcrypto });
  for (const file of ['engine.js', 'shift-log.js']) {
    vm.runInContext(readFileSync(join(__dirname, '../chrome', file), 'utf8'), context, { filename: file });
  }
  const s = { scan: context.ChatEngine.fresh(), checked: 0, notified: 0 };
  const log = context.ShkolkovoShiftLog;
  s.scan.curatorName = CURATOR;
  s.scan.enabled = true;
  function setRoster(period, names) {
    Object.assign(s.scan, { period, appliedPeriod: period, roster: names, directory: names });
  }
  function check(at) {
    s.checked++;
    log.record(s, at, 'chat_checked');
  }
  function notify(at, kind = 'free') {
    if (kind !== 'offline' && kind !== 'connecting') s.notified++;
    log.record(s, at, 'notification_delivered', { kind });
  }
  setRoster(hour(0), [CURATOR]);
  log.start(s, stamp(0, 1));
  log.observe(s, stamp(0, 1), true);
  return { s, log, setRoster, check, notify };
}

test('the next shift keeps its first hour and starts at its earliest transferred event', () => {
  const { s, log, setRoster, check, notify } = fixture();
  const recoveredAt = stamp(3, 15);
  const oldId = log.lookupId(s);
  check(stamp(0, 2));
  check(stamp(1, 2));
  notify(stamp(1, 3));
  check(stamp(2, 7));
  notify(stamp(2, 8));
  check(stamp(3, 5));
  notify(stamp(3, 6), 'offline');
  setRoster(hour(3), [CURATOR]);
  log.observe(s, recoveredAt, true);

  assert.equal(log.missingHour(s, recoveredAt), hour(1));
  assert.equal(log.confirmHour(s, recoveredAt, hour(1), []), true);
  assert.equal(s.shiftLogs.active, null);
  assert.equal(log.missingHour(s, recoveredAt), hour(2));
  assert.notEqual(log.lookupId(s), oldId);
  assert.equal(s.shiftLogs.pending[0].checked, 1);
  assert.equal(s.shiftLogs.pending[0].notified, 0);

  assert.equal(log.confirmHour(s, recoveredAt, hour(2), [CURATOR]), true);
  const next = s.shiftLogs.active;
  assert.equal(next.openedAt, stamp(2, 7));
  assert.equal(next.firstDutyPeriod, hour(2));
  assert.equal(next.lastDutyPeriod, hour(3));
  assert.equal(log.missingHour(s, recoveredAt), null);
  log.finish(s, recoveredAt, 'manual');

  const report = s.shiftLogs.pending[1];
  assert.equal(report.openedAt, stamp(2, 7));
  assert.equal(report.checked, 2);
  assert.equal(report.notified, 1);
  assert.equal(report.events.some(event => event.at === stamp(2, 7) && event.event === 'chat_checked'), true);
  assert.equal(report.events.some(event => event.at < report.openedAt), false);
});

test('several delayed confirmations divide buffered counts between successive shifts', () => {
  const { s, log, setRoster, check, notify } = fixture();
  const recoveredAt = stamp(6, 15);
  check(stamp(0, 2));
  check(stamp(2, 9));
  notify(stamp(2, 10));
  check(stamp(3, 11));
  check(stamp(4, 12));
  check(stamp(5, 13));
  setRoster(hour(6), [CURATOR]);
  log.observe(s, recoveredAt, true);

  assert.equal(log.confirmHour(s, recoveredAt, hour(1), []), true);
  // The durable review retains newly received events while the prior shift is closed.
  s.shiftLogs = JSON.parse(JSON.stringify(s.shiftLogs));
  check(recoveredAt);
  for (const [offset, names] of [[2, [CURATOR]], [3, []], [4, [CURATOR]], [5, [CURATOR]]]) {
    assert.equal(log.missingHour(s, recoveredAt), hour(offset));
    assert.equal(log.confirmHour(s, recoveredAt, hour(offset), names), true);
  }
  assert.equal(s.shiftLogs.active.firstDutyPeriod, hour(4));
  assert.equal(s.shiftLogs.active.openedAt, stamp(4, 12));
  assert.equal(s.shiftLogs.active.lastDutyPeriod, hour(6));
  log.finish(s, recoveredAt, 'manual');

  const [first, second, third] = s.shiftLogs.pending;
  assert.equal(first.endedAt, hour(1));
  assert.equal(first.checked, 1);
  assert.equal(second.endedAt, hour(3));
  assert.equal(second.openedAt, stamp(2, 9));
  assert.equal(second.checked, 1);
  assert.equal(second.notified, 1);
  assert.equal(third.checked, 3);
  assert.equal(third.notified, 0);
  assert.equal(third.events.some(event => event.at === stamp(3, 11)), false);
  assert.equal(third.events.some(event => event.at === recoveredAt && event.event === 'chat_checked'), true);
});
