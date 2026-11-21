'use strict';
// Caller-supplied `limit` must never materialise a whole table. The shared
// clamp is the guard; listOrders is the acceptance-critical consumer that also
// issues one payments query per row.
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `ptp-limit-test-${process.pid}.db`);
const SNAP = path.join(os.tmpdir(), 'ptp-test-fixture.db');
const useCache = process.env.PTP_TEST_NO_CACHE !== '1' && fs.existsSync(SNAP);

process.env.PTP_DATA_DIR = path.dirname(TMP_DB);
process.env.PTP_DB = TMP_DB;
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch (_) { /* ignore */ }
  }
});

const { test } = require('node:test');
const assert = require('node:assert');
if (useCache) fs.copyFileSync(SNAP, TMP_DB);
const { clampLimit } = require('../server/services/listLimit');
const orders = require('../server/services/orders');

if (!useCache) require('../server/seedData').seedData({ log: () => {} });

test('clampLimit bounds huge, negative and NaN inputs', () => {
  assert.strictEqual(clampLimit('100000000', 300), 500, 'huge limit is capped at 500');
  assert.strictEqual(clampLimit(9999), 500);
  assert.strictEqual(clampLimit(-5, 200), 200, 'negative falls back');
  assert.strictEqual(clampLimit('abc', 100), 100, 'non-numeric falls back');
  assert.strictEqual(clampLimit(0, 200), 200);
  assert.strictEqual(clampLimit(120, 200), 120, 'valid in-range value is kept');
  assert.strictEqual(clampLimit('12.9', 200), 12, 'fractional is floored');
});

test('listOrders never returns more than the clamp even when asked for a million', () => {
  const rows = orders.listOrders('1000000');
  assert.ok(rows.length <= 500, `returned ${rows.length} rows, expected <= 500`);
  assert.ok(rows.length > 0, 'seeded orders exist');
});
