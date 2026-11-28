const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

process.env.TZ = 'Europe/Helsinki';
const context = vm.createContext({ getComputedStyle: () => ({ visibility: 'visible' }) });
const source = readFileSync(join(__dirname, '../chrome/dom.js'), 'utf8');
const api = '  globalThis.ShkolkovoDom = {';
assert.ok(source.includes(api));
vm.runInContext(source.replace(api, api + ' messageStamp,'), context, { filename: 'dom.js' });
const { parseActivity, isRecent } = context.ShkolkovoDom;

test('bare list and history times use the browser zone and preserve an explicit offset', () => {
  const now = Date.parse('2026-11-28T01:18:50Z');
  const expected = Date.parse('2026-11-28T01:18:00Z');
  assert.equal(parseActivity('03:18', now)?.at, expected);
  assert.equal(parseActivity('28.11.2026 03:18', now)?.at, expected);
  assert.equal(parseActivity('2026-11-28T03:18', now)?.at, expected);
  const exact = parseActivity('2026-11-28T03:18:35.125+02:00', now);
  assert.equal(exact.at, expected + 35_125);
  assert.equal(exact.precision, 'exact');
  assert.equal(isRecent(expected, now), true);
  assert.equal(isRecent(parseActivity('02:58', now)?.at, now), false);
});

test('relative dates follow the local calendar across midnight and daylight saving time', () => {
  const midnight = Date.parse('2026-11-28T22:01:00Z');
  assert.equal(parseActivity('сегодня 00:00', midnight)?.at, Date.parse('2026-11-28T22:00:00Z'));
  assert.equal(parseActivity('23:59', midnight)?.at, Date.parse('2026-11-28T21:59:00Z'));
  assert.equal(parseActivity('29.11.2026', midnight)?.at, Date.parse('2026-11-28T22:00:00Z'));

  const spring = Date.parse('2026-03-29T06:00:00Z');
  const previous = Date.parse('2026-03-28T06:30:00Z');
  assert.equal(parseActivity('вчера 08:30', spring)?.at, previous);
  assert.equal(parseActivity('сб. 08:30', spring)?.at, previous);
  assert.equal(parseActivity('сегодня 03:30', spring), null);
  assert.equal(parseActivity('2026-03-29T03:30:12+02:00', spring)?.at, Date.parse('2026-03-29T01:30:12Z'));
});

test('history preserves the machine minute until seconds shown in the same minute have elapsed', () => {
  const label = '28.11.2026 12:34:55';
  const now = Date.parse('2026-11-28T12:34:20+02:00');
  const minute = Date.parse('2026-11-28T12:34:00+02:00');
  for (const datetime of ['2026-11-28T12:34+02:00', '2026-11-28T12:34']) {
    const time = { textContent: label, querySelectorAll: () => [], getClientRects: () => [1],
      getAttribute: key => key === 'datetime' ? datetime : null };
    const fallback = context.ShkolkovoDom.messageStamp(time, label, now);
    assert.equal(fallback.at, minute);
    assert.equal(fallback.precision, 'minute');
    assert.equal(fallback.timeParse.source, 'datetime');
    assert.equal(fallback.timeParse.rejected[0].reason, 'future_timestamp');
    assert.equal(fallback.timeParse.rejected[0].deltaMs, 55_000);

    const elapsed = context.ShkolkovoDom.messageStamp(time, label, minute + 55_000);
    assert.equal(elapsed.at, minute + 55_000);
    assert.equal(elapsed.precision, 'exact');
    assert.equal(elapsed.timeParse.source, 'text');
  }
});
