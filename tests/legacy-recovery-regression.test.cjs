const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { webcrypto } = require('node:crypto');
const { test } = require('node:test');
const vm = require('node:vm');

const NOW = Date.UTC(2026, 10, 27, 10, 18);
const CUTOFF = NOW - 45 * 60_000;
const row = (id, position) => ({ id, title: 'Synthetic', position, at: NOW - 5 * 60_000, precision: 'minute' });
const known = row('id:1__2__1', 1);
const additional = row('id:1__2__2', 2);

function fixture(rows, recovery) {
  const event = { addListener() {} };
  const browser = {
    runtime: { id: 'fixture', getURL: path => 'safari-web-extension://fixture/' + path,
      onMessage: event, onInstalled: event, onStartup: event },
    alarms: { onAlarm: event, get: async () => null },
    tabs: { onRemoved: event, onUpdated: event }
  };
  class Clock extends Date {
    static now() { return NOW; }
  }
  const context = vm.createContext({
    browser, Date: Clock, URL, crypto: webcrypto, console, queueMicrotask() {},
    importScripts(...files) { for (const file of files) load(file); }
  });
  function load(file) {
    vm.runInContext(readFileSync(join(__dirname, '../safari/WebExtension', file), 'utf8'), context, { filename: file });
  }
  load('background.js');
  const { E, blank, nextRecoveryBatch, applyRecoveryBatch } =
    vm.runInContext('({ E, blank, nextRecoveryBatch, applyRecoveryBatch })', context);
  const state = blank();
  state.scan.curatorName = 'Иван Петров';
  E.start(state.scan, NOW);
  E.observe(state.scan, rows, NOW, NOW, { partial: true, startupCutoff: CUTOFF });
  state.scan.startupCutoff = null;
  state.coverage = { complete: true, cutoff: CUTOFF, partial: true, scanned: rows.length,
    skipped: 1, total: null, recovery };
  return { state, nextRecoveryBatch, applyRecoveryBatch };
}

test('legacy unanchored in-flight work is re-surveyed once at the original cutoff', () => {
  const { state, nextRecoveryBatch, applyRecoveryBatch } = fixture([known], {
    ranges: [], batch: { id: 'old', cutoff: CUTOFF, targets: [{ position: 2, tries: 1 }] }, acknowledged: null
  });
  const batch = nextRecoveryBatch(state.coverage);
  assert.equal(batch.resurvey, true);
  assert.equal(batch.cutoff, CUTOFF);
  state.coverage = JSON.parse(JSON.stringify(state.coverage));
  assert.equal(nextRecoveryBatch(state.coverage).id, batch.id);
  assert.equal(applyRecoveryBatch(state, {
    recoveryId: 'old', observedAt: NOW, rows: [additional],
    results: [{ position: 2, resolved: true, rowId: additional.id }]
  }), false);

  const partial = { recoveryId: batch.id, resurvey: true, complete: false, observedAt: NOW, rows: [known] };
  assert.equal(applyRecoveryBatch(state, partial), true);
  assert.equal(state.coverage.scanned, 1);
  assert.equal(state.coverage.skipped, 1);
  assert.equal(nextRecoveryBatch(state.coverage).id, batch.id);

  const complete = { ...partial, complete: true, rows: [known, additional], recoveryRanges: [], skipped: 0 };
  assert.equal(applyRecoveryBatch(state, complete), true);
  assert.equal(applyRecoveryBatch(state, complete), true);
  assert.equal(state.coverage.cutoff, CUTOFF);
  assert.equal(state.coverage.scanned, 2);
  assert.equal(state.coverage.skipped, 0);
  assert.equal(nextRecoveryBatch(state.coverage), null);
});

test('exhausted legacy positions get new anchors and a known moved row keeps the gap open', () => {
  const { state, nextRecoveryBatch, applyRecoveryBatch } = fixture([known, additional], {
    ranges: [], batch: null, acknowledged: 'old'
  });
  const resurvey = nextRecoveryBatch(state.coverage);
  assert.equal(resurvey.resurvey, true);
  const before = { position: 2, key: additional.id };
  const after = { position: 4, key: 'id:1__2__4' };
  assert.equal(applyRecoveryBatch(state, {
    recoveryId: resurvey.id, resurvey: true, complete: true, observedAt: NOW, rows: [known, additional],
    recoveryRanges: [{ first: 3, last: 3, before, after }], skipped: 1
  }), true);
  assert.equal(state.coverage.scanned, 2);
  for (let tries = 0; tries < 2; tries++) {
    const batch = nextRecoveryBatch(state.coverage);
    assert.equal(batch.resurvey, undefined);
    assert.equal(batch.cutoff, CUTOFF);
    assert.equal(batch.targets[0].before.key, before.key);
    assert.equal(batch.targets[0].after.key, after.key);
    assert.equal(applyRecoveryBatch(state, {
      recoveryId: batch.id, observedAt: NOW, rows: [row(known.id, 3)],
      results: [{ position: 3, resolved: true, rowId: known.id }]
    }), true);
  }
  assert.equal(nextRecoveryBatch(state.coverage), null);
  assert.equal(state.coverage.scanned, 2);
  assert.equal(state.coverage.skipped, 1);
});
