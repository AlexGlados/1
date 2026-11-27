const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const MIN = 60_000;
const CUTOFF = Date.parse('2026-11-27T13:00:30Z');
const NOW = CUTOFF + 45 * MIN;
const MINUTE_START = CUTOFF - 30_000;
const DATE = '2026-11-27';
const CURATOR = 'Иван Петров';

function load(file, globals = {}) {
  const context = vm.createContext(globals);
  vm.runInContext(readFileSync(join(__dirname, '../chrome', file), 'utf8'), context, { filename: file });
  return context;
}

const { ChatEngine: E } = load('engine.js');

function startup(rows) {
  const state = E.fresh();
  state.curatorName = CURATOR;
  E.start(state, NOW);
  E.installRoster(state, { generation: state.generation, period: state.period }, [CURATOR], null, NOW);
  E.observe(state, rows, NOW, NOW, { startupCutoff: state.startupCutoff, partial: true });
  return state;
}

function checkReply(state, job, at) {
  const check = {};
  E.apply(state, job, { id: job.id, ready: true, startReached: true, complete: true,
    messages: [{ role: 'service', author: 'Сервис', at }] }, NOW, check);
  return check;
}

test('startup queues the overlapping minute and exact newer row with no grace for an exact cutoff', () => {
  const state = startup([
    { id: 'overlap', title: 'Время до минуты', precision: 'minute', at: MINUTE_START },
    { id: 'old', title: 'Прошлая минута', precision: 'minute', at: MINUTE_START - MIN },
    { id: 'boundary', title: 'Ровно на границе', precision: 'exact', at: CUTOFF },
    { id: 'newer', title: 'После границы', precision: 'exact', at: CUTOFF + 10_000 },
    { id: 'undated', title: 'Дата без времени', precision: 'day', at: MINUTE_START }
  ]);
  assert.deepEqual(Object.keys(state.chats).sort(), ['newer', 'overlap']);
  const newer = E.next(state, NOW);
  assert.equal(newer.id, 'newer');
  assert.ok(checkReply(state, newer, CUTOFF + 10_000).status);
  const overlap = E.next(state, NOW);
  assert.equal(overlap.id, 'overlap');
  assert.equal(overlap.minActivityAt, CUTOFF + 1);
  assert.ok(checkReply(state, overlap, CUTOFF + 1_000).status);
  assert.equal(E.next(state, NOW), null);
});

test('startup checks the real message time and leaves normal recency strict', () => {
  const minuteRow = { id: 'overlap', title: 'Время до минуты', precision: 'minute', at: MINUTE_START };
  const state = startup([minuteRow]);
  const job = E.next(state, NOW);
  assert.deepEqual(checkReply(state, job, CUTOFF), {});
  assert.equal(state.chats.overlap.pending, null);
  assert.equal(state.chats.overlap.checked, null);
  assert.equal(E.isCheckableChat(minuteRow, MINUTE_START + 20 * MIN), false);
  assert.equal(E.isStartupActivity(minuteRow, MINUTE_START + MIN - 1), false);
});

const CONFIG_URL = 'chrome-extension://fixture/schedule-config.json';
const config = { ok: true, json: async () => ({ spreadsheetId: 'spreadsheet', entryGid: '12' }) };
const tab = (title, gid = '12') => `items.push({name:"${title}",pageUrl:"",gid:"${gid}"});`;
const week = tab('23.11.2026 – 29.11.2026');
const header = 'День,Час,Старший,Итого,Веб,Иван Петров';
const csv = header + '\nпятница,16:00,,1,,Иван Петров';

function schedule({ settings = config, index = week, body = csv, network } = {}) {
  return load('schedule.js', {
    AbortSignal,
    chrome: { runtime: { getURL: file => 'chrome-extension://fixture/' + file } },
    fetch: async url => {
      if (url === CONFIG_URL) return settings;
      if (network) return network();
      return { ok: true, text: async () => url.includes('/htmlview') ? index : body };
    }
  }).ShSchedule;
}

test('schedule diagnostics classify fixed failures without accepting arbitrary external codes', async () => {
  const scenarios = [
    ['schedule_config', { settings: { ok: false } }],
    ['schedule_timeout', { network: () => { throw new DOMException('private', 'TimeoutError'); } }],
    ['schedule_network', { network: () => { throw new Error('private path'); } }],
    ['schedule_http', { network: () => ({ ok: false, status: 503 }) }],
    ['schedule_tabs', { index: '' }],
    ['schedule_week_missing', { index: tab('16.11.2026 – 22.11.2026') }],
    ['schedule_week_ambiguous', { index: week + tab('23.11.2026 – 29.11.2026', '13') }],
    ['schedule_csv', { body: '"' + csv }],
    ['schedule_hour_missing', { body: header }],
    ['schedule_hour_ambiguous', { body: csv + '\nпятница,16:00,,1,,Иван Петров' }],
    ['schedule_roster', { body: header + '\nпятница,16:00,,2,,Иван Петров' }]
  ];
  for (const [code, setup] of scenarios) {
    const S = schedule(setup);
    await assert.rejects(S.read(DATE, 16), error => S.errorCode(error) === code, code);
  }
  const S = schedule();
  assert.equal(S.errorCode({ code: 'schedule_network', message: 'private' }), 'schedule_unknown');
  await assert.rejects(S.read('2026-11-31', 16), error => S.errorCode(error) === 'schedule_request');
  assert.deepEqual(Array.from((await S.read(DATE, 16)).names), [CURATOR]);
});
