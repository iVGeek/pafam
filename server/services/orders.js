'use strict';

const { db } = require('../db');
const pricing = require('./pricing');

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Pure realised-vs-forecast calculation for one order given its payments.
// Forecast comes from the order's planned unit cost / price; realised comes
// from the payments actually booked (outbound = we paid a supplier, inbound =
// a customer paid us).
function realise(order, payments) {
  const qty = Number(order.quantity) || 0;
  const forecastCost = round2((Number(order.unit_cost) || 0) * qty);
  const forecastRevenue = round2((Number(order.unit_price) || 0) * qty);
  const forecastMargin = round2(forecastRevenue - forecastCost);
  const forecastMarginPct = forecastRevenue > 0 ? pricing.round4((forecastMargin / forecastRevenue) * 100) : null;

  let paidOut = 0;
  let paidIn = 0;
  for (const p of payments || []) {
    const amt = Number(p.amount) || 0;
    if (p.direction === 'outbound') paidOut += amt;
    else paidIn += amt;
  }
  paidOut = round2(paidOut);
  paidIn = round2(paidIn);

  const realisedMargin = round2(paidIn - paidOut);
  const realisedMarginPct = paidIn > 0 ? pricing.round4((realisedMargin / paidIn) * 100) : null;
  const costOutstanding = round2(Math.max(0, forecastCost - paidOut));
  const revenueOutstanding = round2(Math.max(0, forecastRevenue - paidIn));
  const costSettled = forecastCost <= 0 || paidOut >= forecastCost - 0.01;
  const revenueSettled = forecastRevenue <= 0 || paidIn >= forecastRevenue - 0.01;
  const settled = costSettled && revenueSettled;
  const marginVariance = forecastMargin != null && settled ? round2(realisedMargin - forecastMargin) : null;

  // Money-weighted return on the actual dated payments (section 8.7). Only
  // reported when the dates genuinely support it; otherwise the reason is kept
  // so the UI can say why instead of showing a number that means nothing.
  const dated = (payments || [])
    .map((p) => ({
      date: p.paid_date || p.paidDate || null,
      amount: p.direction === 'outbound' ? -(Number(p.amount) || 0) : (Number(p.amount) || 0),
    }))
    .filter((f) => f.date);
  // A money-weighted return on an order that is still open is not a result,
  // it is an artefact of a partial receipt — so we only report it once the
  // order has actually settled.
  const xirrResult = settled ? pricing.xirr(dated) : { xirrPct: null, reason: 'order not settled yet' };
  const funding = dated.length ? pricing.dailyFunding(dated) : null;

  return {
    quantity: qty,
    forecastCost, forecastRevenue, forecastMargin, forecastMarginPct,
    paidOut, paidIn,
    realisedMargin, realisedMarginPct,
    costOutstanding, revenueOutstanding,
    costSettled, revenueSettled, settled,
    marginVariance,
    xirrPct: xirrResult.xirrPct,
    xirrReason: xirrResult.xirrPct == null ? (xirrResult.reason || null) : null,
    daysFunded: funding ? funding.daysFunded : null,
    peakFunding: funding ? funding.peakDeficit : null,
    datedPayments: dated.length,
  };
}

const ORDER_SELECT = `
  SELECT o.*, c.name AS customer_name, p.display_name, p.canonical_gtin, s.name AS supplier_name
  FROM orders o
  LEFT JOIN customers c ON c.id = o.customer_id
  LEFT JOIN products p ON p.id = o.product_id
  LEFT JOIN suppliers s ON s.code = o.supplier_code`;

function paymentsFor(orderId) {
  return db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY paid_date, id').all(orderId);
}

function withRealised(order) {
  return { ...order, payments: paymentsFor(order.id), realised: realise(order, paymentsFor(order.id)) };
}

function listOrders(limit = 300) {
  return db.prepare(`${ORDER_SELECT} ORDER BY o.id DESC LIMIT ?`).all(limit).map(withRealised);
}

function getOrder(id) {
  const o = db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(Number(id));
  return o ? withRealised(o) : null;
}

function nextRef() {
  const n = db.prepare('SELECT COALESCE(MAX(id),0) + 1 AS n FROM orders').get().n;
  return 'ORD-' + String(n).padStart(4, '0');
}

// Create an order, optionally seeded from a saved deal (quote).
function createOrder(body = {}) {
  let q = null;
  if (body.quoteId) {
    q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(Number(body.quoteId));
    if (!q) return { error: 'quote not found' };
  }
  const customerId = body.customerId != null ? Number(body.customerId) : (q ? q.customer_id : null);
  const productId = body.productId != null ? Number(body.productId) : (q ? q.product_id : null);
  if (!customerId || !productId) return { error: 'customerId and productId required' };

  const quantity = body.quantity != null ? Number(body.quantity) : (q ? q.quantity : null);
  if (!quantity) return { error: 'quantity required' };
  const unitCost = body.unitCost != null ? Number(body.unitCost) : (q ? q.landed_unit_cost : null);
  const unitPrice = body.unitPrice != null ? Number(body.unitPrice) : (q ? (q.selling_unit_price != null ? q.selling_unit_price : q.unit_price) : null);

  const info = db.prepare(
    `INSERT INTO orders(ref, quote_id, demand_id, customer_id, supplier_code, product_id, offer_id,
       quantity, currency, unit_cost, unit_price, status, order_date, supplier_due, customer_due, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    nextRef(), q ? q.id : null, (q && q.demand_id) || (body.demandId != null ? Number(body.demandId) : null),
    customerId, body.supplierCode || (q ? q.supplier_code : null), productId,
    body.offerId != null ? Number(body.offerId) : (q ? q.offer_id : null),
    quantity, body.currency || 'USD', unitCost, unitPrice, body.status || 'draft',
    body.orderDate || (q && q.order_date) || new Date().toISOString().slice(0, 10),
    body.supplierDue || (q && q.supplier_due_date) || null,
    body.customerDue || (q && q.customer_due_date) || null,
    body.notes || null
  );
  return { ok: true, id: Number(info.lastInsertRowid) };
}

function recordPayment(orderId, body = {}) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(orderId));
  if (!order) return { error: 'order not found' };
  const direction = body.direction === 'outbound' ? 'outbound' : 'inbound';
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount === 0) return { error: 'amount required' };
  const info = db.prepare(
    `INSERT INTO payments(order_id, direction, amount, currency, paid_date, method, reference, notes)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    order.id, direction, amount, body.currency || order.currency || 'USD',
    body.paidDate || new Date().toISOString().slice(0, 10),
    body.method || null, body.reference || null, body.notes || null
  );
  return { ok: true, id: Number(info.lastInsertRowid) };
}

function updateStatus(id, status) {
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, Number(id));
  return { ok: true };
}

module.exports = { realise, listOrders, getOrder, createOrder, recordPayment, updateStatus, round2 };
