'use strict';
// A rate booked later must never revalue an older offer or receipt. These tests
// use a dedicated synthetic currency pair so seeded rates cannot interfere.
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `ptp-fx-dated-${process.pid}.db`);
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

const { db } = require('../server/db');
const fx = require('../server/services/fx');
const { normalizeOffer } = require('../server/services/comparison');
const { sourceLowest } = require('../server/services/sourcing');
const { buildDeal } = require('../server/services/deal');
const orders = require('../server/services/orders');

if (!useCache) require('../server/seedData').seedData({ log: () => {} });

const PAIR = 'TST'; // synthetic, never appears in the seed data
fx.setRate(PAIR, 'USD', 1.10, { rateDate: '2026-01-01', source: 'dated-test' });
fx.setRate(PAIR, 'USD', 1.20, { rateDate: '2026-03-01', source: 'dated-test' });

test('fx.getRate selects the rate in force on a given date', () => {
  assert.strictEqual(fx.getRate(PAIR, 'USD', '2026-02-01'), 1.10);
  assert.strictEqual(fx.getRate(PAIR, 'USD', '2026-04-01'), 1.20);
  assert.strictEqual(fx.getRate(PAIR, 'USD'), 1.20, 'no date means the latest rate');
  assert.strictEqual(fx.getRate(PAIR, 'USD', '2025-01-01'), null, 'nothing in force yet');
});

test('normalizeOffer prices an offer with the rate on its list date', () => {
  const mk = (listDate) => normalizeOffer({
    currency: PAIR, price: 10, price_type: 'cost', price_basis: 'unit',
    units_per_case: 1, list_date: listDate,
  }, 'USD');
  assert.strictEqual(mk('2026-02-01').perBottleBase, 11);
  assert.strictEqual(mk('2026-04-01').perBottleBase, 12);
  assert.strictEqual(mk(null).perBottleBase, 12, 'undated offer uses the newest rate');
  const tooEarly = mk('2025-01-01');
  assert.strictEqual(tooEarly.fxMissing, true, 'no rate on that date is flagged, not silently priced');
});

function seededProductWithOffers() {
  const p = db.prepare('SELECT id FROM products WHERE id IN (SELECT product_id FROM offers) LIMIT 1').get();
  assert.ok(p, 'seeded product with offers');
  return p.id;
}

test('buildDeal uses the offer list date for FX', () => {
  const productId = seededProductWithOffers();
  db.prepare('INSERT OR IGNORE INTO suppliers(code, name, currency) VALUES (?, ?, ?)')
    .run('DATEDFX', 'Dated FX Test', PAIR);
  const info = db.prepare(
    `INSERT INTO offers(upload_id, supplier_code, description, currency, price, price_basis, price_type, units_per_case, product_id, status, list_date)
     VALUES (1, 'DATEDFX', 'Dated FX offer', ?, 10, 'unit', 'cost', 1, ?, 'new', ?)`
  ).run(PAIR, productId, '2026-02-01');

  const out = buildDeal({ offerId: Number(info.lastInsertRowid), quantity: 1 });
  assert.strictEqual(out.found, true);
  assert.strictEqual(out.landed.fxRate, 1.10, 'early rate applied, not the newer 1.20');
  assert.strictEqual(out.fxRateMissing, false);
});

test('sourceLowest keeps separate rates for the same currency on different dates', () => {
  const productId = seededProductWithOffers();
  db.prepare('INSERT OR IGNORE INTO suppliers(code, name, currency) VALUES (?, ?, ?)')
    .run('DATEDSRC', 'Dated Sourcing Test', PAIR);
  const insert = db.prepare(
    `INSERT INTO offers(upload_id, supplier_code, description, currency, price, price_basis, price_type, units_per_case, product_id, status, list_date)
     VALUES (1, 'DATEDSRC', ?, ?, 10, 'unit', 'cost', 1, ?, 'new', ?)`
  );
  const early = Number(insert.run('early offer', PAIR, productId, '2026-02-01').lastInsertRowid);
  const late = Number(insert.run('late offer', PAIR, productId, '2026-04-01').lastInsertRowid);

  const out = sourceLowest({ productId, quantity: 1, baseCurrency: 'USD' });
  assert.strictEqual(out.found, true);
  const rows = [...out.ranked, ...out.excluded];
  const byId = new Map(rows.map((r) => [r.offerId, r]));
  assert.ok(byId.has(early) && byId.has(late), 'both dated offers returned');
  assert.strictEqual(byId.get(early).fxRate, 1.10);
  assert.strictEqual(byId.get(late).fxRate, 1.20);
});

test('realise converts mixed-currency payments at the payment date', () => {
  const customerId = db.prepare('SELECT id FROM customers LIMIT 1').get().id;
  const productId = seededProductWithOffers();
  const id = Number(orders.createOrder({
    customerId, productId, currency: 'USD', quantity: 100,
    unitCost: 8, unitPrice: 15, orderDate: '2026-01-15',
  }).id);

  orders.recordPayment(id, {
    direction: 'inbound', amount: 100, currency: PAIR, paidDate: '2026-02-01',
  });
  const first = orders.getOrder(id);
  assert.strictEqual(first.realised.paidIn, 110, '100 TST at the 2026-02-01 rate of 1.10');

  // Booking a newer rate must not rewrite the already-recorded receipt.
  fx.setRate(PAIR, 'USD', 1.50, { rateDate: '2026-06-01', source: 'dated-test' });
  const again = orders.getOrder(id);
  assert.strictEqual(again.realised.paidIn, 110, 'dated rate is reproducible');

  orders.recordPayment(id, {
    direction: 'outbound', amount: 50, currency: PAIR, paidDate: '2026-02-10',
  });
  const both = orders.getOrder(id);
  assert.strictEqual(both.realised.paidOut, 55, 'supplier payment converted in its own currency');
  assert.strictEqual(both.realised.realisedMargin, 55);

  // A currency with no rate stays usable but is explicitly flagged.
  orders.recordPayment(id, {
    direction: 'inbound', amount: 20, currency: 'NON', paidDate: '2026-02-15',
  });
  const flagged = orders.getOrder(id);
  assert.ok(flagged.realised.fxAssumptions.some((a) => /NON -> USD/.test(a)),
    'missing rate is surfaced as an assumption, not hidden as parity');
  assert.strictEqual(flagged.payments.find((p) => p.currency === 'NON').fxMissing, true);
});
