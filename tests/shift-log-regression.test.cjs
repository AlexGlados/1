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
  for (const file of ['engine.js', 'time.js', 'shift-log.js']) {
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

test('references follow buffered events within a report and rotate at a shift boundary', () => {
  const { s, log, setRoster } = fixture();
  const keys = { chatId: 'id:123__456__789', episode: 'private-episode-id', noticeId: 'chrome-internal-notice' };
  log.diagnostic(s, stamp(0, 2), 'notification_decision', keys, { decision: 'queued' });
  log.diagnostic(s, stamp(1, 2), 'notification_api_result', keys, { result: 'accepted' });
  log.diagnostic(s, stamp(3, 5), 'notification_cancelled', keys, { reason: 'episode_changed' });
  s.shiftLogs = JSON.parse(JSON.stringify(s.shiftLogs));
  setRoster(hour(3), [CURATOR]);
  const now = stamp(3, 10);
  log.observe(s, now, true);
  assert.equal(log.confirmHour(s, now, hour(1), [CURATOR]), true);
  assert.equal(log.confirmHour(s, now, hour(2), []), true);
  log.finish(s, now, 'manual');

  const [first, second] = s.shiftLogs.pending;
  const queued = first.events.find(entry => entry.event === 'notification_decision').details;
  const api = first.events.find(entry => entry.event === 'notification_api_result').details;
  const cancelled = second.events.find(entry => entry.event === 'notification_cancelled').details;
  for (const field of ['chat_ref', 'episode_ref', 'notification_ref']) {
    assert.match(queued[field], /^[\da-f-]{36}$/u);
    assert.equal(api[field], queued[field]);
    assert.notEqual(cancelled[field], queued[field]);
  }
  assert.equal(s.notificationLogIndex, undefined);
  const exportText = log.render(first, '1.11.7') + log.render(second, '1.11.7');
  assert.doesNotMatch(exportText, /123__456__789|private-episode-id|chrome-internal-notice|Иван Петров/u);
});

test('repeated timestamp diagnostics coalesce and ordinary overflow preserves connection and delivery', () => {
  const { s, log } = fixture();
  const keys = { chatId: 'id:123__456__789', episode: 'private-episode-id', noticeId: 'native-reference', kind: 'free' };
  const time = { source: 'datetime', precision: 'exact', timezone: 'explicit', offsetMinutes: 120, at: stamp(0, 1) };
  log.record(s, stamp(0, 2), 'connection_changed', { status: 'offline' });
  log.diagnostic(s, stamp(0, 3), 'notification_api_result', keys, { kind: 'free', result: 'accepted' });
  for (let i = 0; i < 1300; i++) {
    log.parsedTime(s, stamp(0, 4) + i, keys, 'history', time);
    log.diagnostic(s, stamp(0, 4) + i, 'chat_check_failed', keys, { reason: 'row_unavailable' });
  }
  for (let i = 0; i < 1300; i++) log.parsedTime(s, stamp(0, 5) + i, keys, 'history', time);
  log.finish(s, stamp(0, 7), 'manual');
  const report = s.shiftLogs.pending[0];
  assert.equal(report.events.length, 1200);
  assert.ok(report.omitted > 0);
  assert.ok(report.events.some(entry => entry.event === 'connection_changed' && entry.details.status === 'offline'));
  assert.ok(report.events.some(entry => entry.event === 'notification_api_result' && entry.details.result === 'accepted'));
  const [entry] = report.events.filter(entry => entry.event === 'message_time_parsed');
  assert.ok(entry.occurrences >= 1300);
  assert.equal(entry.lastAt, stamp(0, 5) + 1299);
  assert.match(log.render(report, '1.11.7'), new RegExp('"occurrences":' + entry.occurrences));
});

test('buffered hours preserve connection and delivery through unrelated events and export', () => {
  const { s, log, setRoster, check } = fixture();
  const next = stamp(1, 1);
  log.record(s, next, 'connection_changed', { status: 'offline' });
  log.record(s, next + 1, 'notification_api_result', { kind: 'free', result: 'rejected' });
  for (let i = 0; i < 1300; i++) check(next + 2 + i);
  log.record(s, next + 1302, 'connection_changed', { status: 'online' });
  setRoster(hour(1), [CURATOR]);
  log.observe(s, stamp(1, 3), true);
  log.finish(s, stamp(1, 4), 'manual');
  const report = s.shiftLogs.pending[0];
  assert.equal(report.checked, 1300);
  assert.ok(report.omitted > 0);
  assert.deepEqual(Array.from(report.events.filter(entry => entry.event === 'connection_changed'), entry => entry.details.status),
    ['offline', 'online']);
  assert.ok(report.events.some(entry => entry.event === 'notification_api_result' && entry.details.result === 'rejected'));
});

test('delivery traffic cannot evict the connection transitions from a saturated journal', () => {
  const { s, log } = fixture();
  const at = stamp(0, 2);
  for (let i = 0; i < 1200; i++) log.record(s, at + i, 'notification_api_result', { result: 'accepted' });
  log.record(s, at + 1200, 'connection_changed', { status: 'offline' });
  log.record(s, at + 3300, 'connection_changed', { status: 'online' });
  for (let i = 0; i < 1200; i++) log.record(s, at + 3301 + i, 'notification_api_result', { result: 'rejected' });
  log.finish(s, stamp(0, 3), 'manual');
  const report = s.shiftLogs.pending[0];
  assert.equal(report.events.length, 1200);
  assert.deepEqual(Array.from(report.events.filter(entry => entry.event === 'connection_changed'), entry => entry.details.status),
    ['offline', 'online']);
  assert.ok(report.events.some(entry => entry.event === 'notification_api_result' && entry.details.result === 'rejected'));
});

test('confirming a temporary chat key merges active and buffered chat and episode references', () => {
  const { s, log, setRoster } = fixture();
  const canonical = { chatId: 'id:123__456__789', episode: 'private-episode-id', noticeId: 'private-notice' };
  const temporary = { ...canonical, chatId: '5:temporary-key' };
  log.diagnostic(s, stamp(0, 2), 'notification_decision', canonical, { decision: 'queued' });
  log.diagnostic(s, stamp(0, 3), 'notification_deferred', temporary, { reason: 'new_activity_before_send' });
  log.diagnostic(s, stamp(1, 2), 'notification_api_result', temporary, { result: 'rejected' });
  const queued = s.shiftLogs.active.events.find(entry => entry.event === 'notification_decision');
  assert.notEqual(queued.details.chat_ref, s.shiftLogs.active.held.events[0].details.chat_ref);

  s.notificationLogIndex = JSON.parse(JSON.stringify(s.notificationLogIndex));
  s.shiftLogs = JSON.parse(JSON.stringify(s.shiftLogs));
  log.identifyChat(s, temporary.chatId, canonical.chatId);
  log.diagnostic(s, stamp(1, 3), 'notification_api_result', canonical, { result: 'accepted' });
  setRoster(hour(1), [CURATOR]);
  log.observe(s, stamp(1, 4), true);
  log.finish(s, stamp(1, 5), 'manual');
  const report = s.shiftLogs.pending[0];
  const events = report.events.filter(entry => entry.event.startsWith('notification_'));
  assert.equal(events.length, 4);
  for (const field of ['chat_ref', 'episode_ref', 'notification_ref']) {
    assert.equal(new Set(events.map(entry => entry.details[field])).size, 1);
  }
  assert.doesNotMatch(log.render(report, '1.11.7'), /123__456__789|temporary-key|private-episode-id|private-notice/u);
});
