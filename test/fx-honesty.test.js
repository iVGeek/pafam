'use strict';
// A missing FX rate must never be silently presented as parity. The converted
// number stays usable, but it is flagged so the UI/AI mark it as an assumption.
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `ptp-fx-test-${process.pid}.db`);
process.env.PTP_DATA_DIR = path.dirname(TMP_DB);
process.env.PTP_DB = TMP_DB;
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch (_) { /* ignore */ }
  }
});

const { test } = require('node:test');
const assert = require('node:assert');
const { db, setSetting } = require('../server/db');
const { normalizeOffer } = require('../server/services/comparison');
const { sourceLowest } = require('../server/services/sourcing');

require('../server/seedData').seedData({ log: () => {} });
setSetting('base_currency', 'USD');

test('normalizeOffer flags a currency with no FX rate', () => {
  const out = normalizeOffer({
    price: 10, price_type: 'cost', price_basis: 'unit', units_per_case: 1, currency: 'XYZ',
  }, 'USD');
  assert.strictEqual(out.fxRate, 1);
  assert.strictEqual(out.fxMissing, true);
  assert.ok(out.flags.includes('fx-rate-missing'));
  assert.strictEqual(out.perBottleBase, 10, 'parity is still computed, but flagged');
});

test('normalizeOffer does not flag same-currency or known rates', () => {
  const same = normalizeOffer({
    price: 10, price_type: 'cost', price_basis: 'unit', units_per_case: 1, currency: 'USD',
  }, 'USD');
  assert.strictEqual(same.fxMissing, false);
  assert.strictEqual(same.flags.includes('fx-rate-missing'), false);

  const known = normalizeOffer({
    price: 10, price_type: 'cost', price_basis: 'unit', units_per_case: 1, currency: 'EUR',
  }, 'USD');
  assert.strictEqual(known.fxMissing, false, 'seeded EUR->USD rate exists');
  assert.notStrictEqual(known.fxRate, 1);
});

test('sourceLowest surfaces missing FX rates in warnings and result', () => {
  const product = db.prepare('SELECT id FROM products WHERE id IN (SELECT product_id FROM offers) LIMIT 1').get();
  assert.ok(product, 'seeded product with offers');
  db.prepare("INSERT OR IGNORE INTO suppliers(code, name, currency) VALUES ('FXTEST', 'FX Test Supplier', 'ZZZ')").run();
  db.prepare(`INSERT INTO offers(upload_id, supplier_code, description, currency, price, price_basis, price_type, units_per_case, product_id, status)
    VALUES (1, 'FXTEST', 'FX test offer', 'ZZZ', 5, 'unit', 'cost', 1, ?, 'new')`).run(product.id);

  const out = sourceLowest({ productId: product.id, quantity: 1, baseCurrency: 'USD' });
  assert.strictEqual(out.found, true);
  assert.ok(out.warnings.some((w) => /no USD FX rate/.test(w)), 'warning names the missing rate');
  const flagged = out.ranked.find((r) => r.fxRateMissing) || out.excluded.find((r) => r.fxRateMissing);
  assert.ok(flagged, 'result is flagged as using an assumed FX rate');
  assert.ok(flagged.flags.includes('fx-rate-missing'));
  assert.ok(flagged.missing.some((m) => /FX rate ZZZ -> USD/.test(m)));
  assert.strictEqual(flagged.complete, false);
});
