'use strict';

const { db } = require('../db');
const pricing = require('./pricing');

// Honest demand forecast baseline (Phase 4d). Does not extrapolate to
// impossible precision. If there is insufficient history, we return
// "insufficient" with a clear reason and zeroed values.
const MIN_OBS = 5;
const DAYS_PER_MONTH = 30;

// Pure baseline: given a chronological list of monthly totals, return the
// moving-average figures. Below MIN_OBS observations we refuse to forecast and
// say why, rather than extrapolating from noise.
function movingAverageForecast(monthlyQuantities, opts = {}) {
  const minObs = opts.minObservations || MIN_OBS;
  const months = (monthlyQuantities || []).filter((q) => Number.isFinite(Number(q)));
  const totalQty = months.reduce((s, q) => s + Number(q), 0);
  const avgPerMonth = months.length ? pricing.round2(totalQty / months.length) : 0;
  const avgPerWeek = pricing.round2((avgPerMonth / DAYS_PER_MONTH) * 7);
  const avgPerDay = pricing.round2(avgPerMonth / DAYS_PER_MONTH);
  const sufficient = months.length >= minObs;
  return {
    months: months.length,
    totalQty: pricing.round2(totalQty),
    avgPerMonth,
    avgPerWeek,
    avgPerDay,
    forecastQty30d: sufficient ? Math.round(avgPerMonth) : 0,
    confidence: sufficient ? 'medium' : 'insufficient',
    sufficient,
    reason: sufficient ? null : `need >= ${minObs} delivery months (have ${months.length})`,
  };
}

// Backtest (brief section 12): "Backtest against a simple baseline."
// Walk-forward: for each product with >= MIN_OBS months, forecast each
// month from the prior months' average and measure the error vs actual.
// Returns MAPE per product and overall. With < MIN_OBS months it says so,
// it does not grade noise.
function backtest(opts = {}) {
  const baseline = forecastBaseline(opts);
  const products = (baseline.byProduct || []).filter((p) => p.months >= MIN_OBS);
  const results = products.map((p) => {
    const qs = p.observations.map((o) => Number(o.quantity) || 0);
    let absErr = 0, n = 0, sumA = 0;
    for (let i = 1; i < qs.length; i++) {
      const prior = qs.slice(0, i);
      const pred = prior.reduce((s, q) => s + q, 0) / prior.length;
      const actual = qs[i];
      if (actual > 0) { absErr += Math.abs(pred - actual) / actual; sumA += actual; n += 1; }
    }
    return {
      productId: p.productId,
      productName: p.productName,
      months: p.months,
      mape: n ? Math.round((absErr / n) * 1000) / 10 : null,
      testedMonths: n,
    };
  }).filter((r) => r.mape != null).sort((a, b) => a.mape - b.mape);
  const overall = results.length
    ? Math.round((results.reduce((s, r) => s + r.mape, 0) / results.length) * 10) / 10
    : null;
  const totalProducts = (baseline.byProduct || []).length;
  return {
    overallMape: overall,
    tested: results.length,
    totalProducts,
    reason: results.length ? null : `need >= ${MIN_OBS} months of delivered history per product (have ${totalProducts} product(s), none sufficient)`,
    results: results.slice(0, opts.limit || 25),
  };
}

function _getOrders() {
  try {
    const orders = require('./orders');
    return orders.listOrders(2000) || [];
  } catch (e) {
    return [];
  }
}

function _getDemands() {
  return db.prepare(
    `SELECT d.*, p.id AS product_id, p.display_name, c.name AS customer_name
       FROM demands d
       JOIN products p ON p.id = d.product_id
       JOIN customers c ON c.id = d.customer_id
      ORDER BY d.id DESC LIMIT 2000`
  ).all();
}

// Simple moving-average baseline on delivered order quantities, grouped
// by (productId, customerId). Never invents a direction from < MIN_OBS.
function forecastBaseline(opts = {}) {
  const orders = _getOrders();
  const delivered = orders.filter((o) => o.status === 'delivered' || (o.realised && o.realised.settled && o.status !== 'cancelled'));

  // Aggregate monthly-ish quantity by key.
  const buckets = new Map();
  for (const o of delivered) {
    const key = `${o.product_id || ''}:${o.customer_id || ''}`;
    const date = o.order_date || o.created_at || null;
    if (!date) continue;
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) continue;
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const q = Number(o.quantity) || 0;
    if (!buckets.has(key)) buckets.set(key, new Map());
    const m = buckets.get(key);
    m.set(ym, (m.get(ym) || 0) + q);
  }

  // Build series
  const series = [];
  for (const [key, ymMap] of buckets.entries()) {
    const [pidStr, cidStr] = key.split(':');
    const pid = pidStr ? Number(pidStr) : null;
    const cid = cidStr ? Number(cidStr) : null;
    const months = Array.from(ymMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const fc = movingAverageForecast(months.map(([, q]) => q));
    const product = pid ? db.prepare('SELECT display_name FROM products WHERE id=?').get(pid) : null;
    const customer = cid ? db.prepare('SELECT name FROM customers WHERE id=?').get(cid) : null;
    series.push({
      productId: pid,
      customerId: cid,
      productName: product ? product.display_name : null,
      customerName: customer ? customer.name : null,
      observations: months.map(([m, q]) => ({ month: m, quantity: q })),
      horizonDays: 30,
      ...fc,
    });
  }

  // Also surface top product-level baselines across customers
  const byProduct = new Map();
  for (const s of series) {
    if (s.productId == null) continue;
    const k2 = s.productId;
    const cur = byProduct.get(k2) || { productId: k2, productName: s.productName, months: 0, points: [] };
    cur.months = Math.max(cur.months, s.months);
    cur.points = cur.points.concat(s.observations);
    byProduct.set(k2, cur);
  }
  const productSeries = Array.from(byProduct.values()).map((p) => {
    const ymMap2 = new Map();
    for (const pt of p.points) ymMap2.set(pt.month, (ymMap2.get(pt.month) || 0) + pt.quantity);
    const months = Array.from(ymMap2.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const fc = movingAverageForecast(months.map(([, q]) => q));
    return {
      productId: p.productId,
      productName: p.productName,
      observations: months.map(([m, q]) => ({ month: m, quantity: q })),
      ...fc,
    };
  });

  const totalSufficient = series.filter((s) => s.sufficient).length;
  return {
    sufficientCount: totalSufficient,
    totalPairs: series.length,
    minObservations: MIN_OBS,
    byCustomerProduct: series,
    byProduct: productSeries,
    demands: _getDemands().slice(0, 100),
  };
}

module.exports = { forecastBaseline, movingAverageForecast, backtest, MIN_OBS };
