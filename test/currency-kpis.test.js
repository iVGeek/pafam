'use strict';
// Money realised on an order belongs to that order's currency: payments were
// converted into it at the payment date. Summing orders in different currencies
// and labelling the result "base" is a false total. These tests use a fresh DB
// with synthetic currencies so seeded data cannot hide the behaviour.
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `ptp-currency-kpis-${process.pid}.db`);
process.env.PTP_DATA_DIR = path.dirname(TMP_DB);
process.env.PTP_DB = TMP_DB;
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch (_) { /* ignore */ }
  }
});

const { test } = require('node:test');
const assert = require('node:assert');

const { db } = require('../server/db');
const orders = require('../server/services/orders');
const analytics = require('../server/services/analytics');
const { customerKpis } = require('../server/services/customerKpis');

const customerId = Number(db.prepare(
  "INSERT INTO customers(code, name, currency) VALUES ('CURRKPI', 'Currency KPI Test', 'USD')"
).run().lastInsertRowid);
const productId = Number(db.prepare(
  "INSERT INTO products(canonical_gtin, display_name) VALUES ('9999990000001', 'Currency KPI Test Product')"
).run().lastInsertRowid);

function settledOrder(currency, unitCost, unitPrice) {
  const id = Number(orders.createOrder({
    customerId, productId, currency, quantity: 10, unitCost, unitPrice,
    status: 'delivered', orderDate: '2026-02-01',
  }).id);
  orders.recordPayment(id, { direction: 'outbound', amount: unitCost * 10, paidDate: '2026-02-05' });
  orders.recordPayment(id, { direction: 'inbound', amount: unitPrice * 10, paidDate: '2026-02-10' });
  return id;
}

function openOrder(currency, unitCost, unitPrice) {
  return Number(orders.createOrder({
    customerId, productId, currency, quantity: 10, unitCost, unitPrice,
    status: 'draft', orderDate: '2026-01-05', customerDue: '2026-01-20',
  }).id);
}

test('single-currency KPIs keep numeric scalars and a one-entry map', () => {
  settledOrder('USD', 10, 20);
  openOrder('USD', 10, 20);
  const k = analytics.kpis({});
  assert.strictEqual(k.mixedCurrency, false);
  assert.strictEqual(k.summary.revenue, 200);
  assert.strictEqual(k.summary.costPaid, 100);
  assert.strictEqual(k.summary.grossProfit, 100);
  assert.deepStrictEqual(k.summary.revenueByCurrency, { USD: 200 });
  assert.deepStrictEqual(k.summary.realisedMarginByCurrency, { USD: 100 });
  assert.strictEqual(k.cash.ar, 200);
  assert.strictEqual(k.cash.ap, 100);
  assert.strictEqual(k.cash.workingCapital, 100);
  assert.strictEqual(typeof customerKpis().overdueDebt, 'number');
});

test('mixed-currency KPIs expose per-currency truth and null scalars', () => {
  settledOrder('EUR', 5, 10);       // +100 EUR revenue, 50 EUR cost, 50 EUR margin
  openOrder('EUR', 5, 10);          // +100 EUR AR, 50 EUR AP

  const k = analytics.kpis({});
  assert.strictEqual(k.mixedCurrency, true);
  assert.match(k.currencyWarning, /explicit, dated FX conversion/);

  // Settled money: null scalars, real values per currency.
  assert.strictEqual(k.summary.revenue, null);
  assert.deepStrictEqual(k.summary.revenueByCurrency, { USD: 200, EUR: 100 });
  assert.strictEqual(k.summary.costPaid, null);
  assert.deepStrictEqual(k.summary.costPaidByCurrency, { USD: 100, EUR: 50 });
  assert.strictEqual(k.summary.grossProfit, null);
  assert.deepStrictEqual(k.summary.grossProfitByCurrency, { USD: 100, EUR: 50 });
  assert.strictEqual(k.summary.grossMarginPct, null);
  assert.strictEqual(k.summary.grossMarginPctByCurrency.USD, 50);
  assert.strictEqual(k.summary.grossMarginPctByCurrency.EUR, 50);
  assert.strictEqual(k.summary.realisedMargin, null);
  assert.deepStrictEqual(k.summary.realisedMarginByCurrency, { USD: 100, EUR: 50 });

  // Open money: same rule for AR/AP/working capital.
  assert.strictEqual(k.cash.ar, null);
  assert.deepStrictEqual(k.cash.arByCurrency, { USD: 200, EUR: 100 });
  assert.strictEqual(k.cash.ap, null);
  assert.deepStrictEqual(k.cash.apByCurrency, { USD: 100, EUR: 50 });
  assert.strictEqual(k.cash.workingCapital, null);
  assert.deepStrictEqual(k.cash.workingCapitalByCurrency, { USD: 100, EUR: 50 });

  // A cross-currency turnover ratio has no meaning without a dated conversion.
  assert.strictEqual(k.stock.daysInventory, null);

  // overview() carries the same flags for the dashboard.
  assert.strictEqual(analytics.overview().mixedCurrency, true);
  assert.strictEqual(analytics.overview().realisedMargin, null);
});

test('customer KPIs split overdue debt by currency instead of adding it', () => {
  const c = customerKpis();
  assert.strictEqual(c.mixedCurrency, true);
  assert.strictEqual(c.overdueDebt, null);
  assert.deepStrictEqual(c.overdueDebtByCurrency, { USD: 200, EUR: 100 });
  assert.strictEqual(c.overdueOrders, 2);
  assert.match(c.currencyWarning, /explicit, dated FX conversion/);
});
