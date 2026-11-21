'use strict';

const { db, getSetting } = require('../db');
const pricing = require('./pricing');
const { normalizeOffer } = require('./comparison');
const orders = require('./orders');
const { consolidateDemands } = require('./purchasePlan');
const { recommendations } = require('./recommend');
const trends = require('./trends');
const alerts = require('./alerts');

function safeNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? pricing.round2(n, d) : 0;
}

// A realised figure belongs to the currency of its order: payments were
// converted into the order currency at the payment date, never into a shared
// base. Adding figures from orders in different currencies and labelling the
// sum "base" is a false total, so aggregate per currency and only expose a
// scalar when every amount shares one currency (same rule as mixed POs).
function addMoney(byCurrency, currency, amount) {
  const cur = currency || 'UNKNOWN';
  byCurrency[cur] = pricing.round2((Number(byCurrency[cur]) || 0) + (Number(amount) || 0));
}

function singleCurrencyTotal(byCurrency, empty = 0) {
  const keys = Object.keys(byCurrency);
  if (!keys.length) return empty;
  return keys.length === 1 ? byCurrency[keys[0]] : null;
}

function overview() {
  const base = getSetting('base_currency', 'USD');
  const offers = db.prepare('SELECT COUNT(*) n FROM offers').get().n;
  const suppliers = db.prepare('SELECT COUNT(*) n FROM suppliers').get().n;
  const products = db.prepare('SELECT COUNT(*) n FROM products').get().n;
  const uploads = db.prepare('SELECT COUNT(*) n FROM uploads').get().n;
  const openExceptions = db.prepare('SELECT COUNT(*) n FROM exceptions WHERE resolved = 0').get().n;
  const exceptionsByType = db.prepare('SELECT type, COUNT(*) n FROM exceptions WHERE resolved = 0 GROUP BY type ORDER BY n DESC').all();

  const overlapProducts = db.prepare(
    `SELECT COUNT(*) n FROM (
       SELECT product_id FROM offers WHERE product_id IS NOT NULL
       GROUP BY product_id HAVING COUNT(DISTINCT supplier_code) > 1
     )`
  ).get().n;

  const customers = db.prepare('SELECT COUNT(*) n FROM customers').get().n;
  const openDemands = db.prepare("SELECT COUNT(*) n FROM demands WHERE status = 'open'").get().n;
  const inventoryUnits = db.prepare('SELECT COALESCE(SUM(on_hand),0) n FROM inventory_lots').get().n;

  const allOrders = orders.listOrders(1000);
  const settled = allOrders.filter((o) => o.realised.settled);
  const realisedMarginByCurrency = {};
  for (const o of settled) addMoney(realisedMarginByCurrency, o.currency, o.realised.realisedMargin);
  const realisedMargin = singleCurrencyTotal(realisedMarginByCurrency);
  const mixedCurrency = new Set(allOrders.map((o) => o.currency).filter(Boolean)).size > 1;
  const ordersOpen = allOrders.filter((o) => !o.realised.settled).length;
  // A converted payment with no dated rate is an assumption, not a measured
  // result. Carry the count so dashboards cannot present the total as signable.
  const fxAssumedOrders = allOrders.filter((o) => (o.realised.fxAssumptions || []).length).length;

  return {
    baseCurrency: base,
    offers, suppliers, products, uploads,
    openExceptions, exceptionsByType,
    overlapProducts,
    customers, openDemands, inventoryUnits,
    orders: allOrders.length,
    ordersOpen,
    realisedMargin,
    realisedMarginByCurrency,
    mixedCurrency,
    fxAssumedOrders,
  };
}

// Products sourced from more than one supplier, ranked by potential saving.
// Comparisons whose spread is implausibly large are surfaced separately as
// "review" items (almost always a price-basis or unit mismatch in the source
// data) rather than being reported as real arbitrage.
const PLAUSIBLE_MAX_PCT = 100;

function opportunities(limit = 25) {
  const base = getSetting('base_currency', 'USD');
  const productIds = db.prepare(
    `SELECT product_id FROM offers WHERE product_id IS NOT NULL
     GROUP BY product_id HAVING COUNT(DISTINCT supplier_code) > 1
     ORDER BY product_id`
  ).all().map((r) => r.product_id);

  const out = [];
  for (const pid of productIds) {
    const rows = db.prepare(
      `SELECT o.*, s.name AS supplier_name, s.default_discount_pct
       FROM offers o JOIN suppliers s ON s.code = o.supplier_code WHERE o.product_id = ?`
    ).all(pid);
    const priced = rows
      .map((r) => ({ r, n: normalizeOffer(r, base) }))
      .filter((x) => !x.n.isRetail && x.n.perBottleBase != null)
      .sort((a, b) => a.n.perBottleBase - b.n.perBottleBase);
    if (priced.length < 2) continue;
    const best = priced[0];
    const worst = priced[priced.length - 1];
    // only report genuine cross-supplier arbitrage
    if (best.r.supplier_code === worst.r.supplier_code) continue;
    const saving = pricing.round4(worst.n.perBottleBase - best.n.perBottleBase);
    const savingPct = best.n.perBottleBase > 0 ? pricing.round4((saving / best.n.perBottleBase) * 100) : 0;
    if (saving <= 0) continue;
    const flagged = savingPct > PLAUSIBLE_MAX_PCT;
    out.push({
      productId: pid,
      displayName: best.r.description,
      category: best.r.category,
      sizeMl: best.r.size_ml,
      bestSupplier: best.r.supplier_code,
      bestPrice: best.n.perBottleBase,
      bestBasis: best.n.basis,
      bestFlags: best.n.flags,
      worstSupplier: worst.r.supplier_code,
      worstPrice: worst.n.perBottleBase,
      worstBasis: worst.n.basis,
      worstFlags: worst.n.flags,
      savingPerBottle: saving,
      savingPct,
      flagged,
      reason: flagged ? 'Suspected price-basis/unit mismatch — confirm quotes before trusting.' : null,
    });
  }
  const sorted = out.sort((a, b) => b.savingPct - a.savingPct);
  return {
    plausible: sorted.filter((o) => !o.flagged).slice(0, limit),
    review: sorted.filter((o) => o.flagged).slice(0, limit),
  };
}

function supplierStats() {
  return db.prepare(
    `SELECT s.code, s.name, s.currency, s.price_type,
            COUNT(o.id) AS offers,
            SUM(CASE WHEN o.product_id IS NULL THEN 1 ELSE 0 END) AS unmatched,
            SUM(CASE WHEN o.gtin_valid = 0 THEN 1 ELSE 0 END) AS invalid_barcodes
     FROM suppliers s LEFT JOIN offers o ON o.supplier_code = s.code
     GROUP BY s.code ORDER BY s.code`
  ).all();
}

// Cheapest-supplier wins across overlapping products.
function winsByType() {
  const base = getSetting('base_currency', 'USD');
  const productIds = db.prepare(
    `SELECT product_id FROM offers WHERE product_id IS NOT NULL
     GROUP BY product_id HAVING COUNT(DISTINCT supplier_code) > 1`
  ).all().map((r) => r.product_id);
  const wins = {};
  for (const pid of productIds) {
    const rows = db.prepare(
      `SELECT o.*, s.default_discount_pct FROM offers o JOIN suppliers s ON s.code = o.supplier_code WHERE o.product_id = ?`
    ).all(pid);
    const priced = rows
      .map((r) => ({ r, n: normalizeOffer(r, base) }))
      .filter((x) => !x.n.isRetail && x.n.perBottleBase != null)
      .sort((a, b) => a.n.perBottleBase - b.n.perBottleBase);
    if (!priced.length) continue;
    const w = priced[0].r.supplier_code;
    wins[w] = (wins[w] || 0) + 1;
  }
  return wins;
}

function kpis(opts = {}) {
  const base = getSetting('base_currency', 'USD');
  const capitalLimit = Number(getSetting('capital_limit', '250000'));

  const ov = overview();
  const plan = consolidateDemands({ approvedOnly: opts.approvedOnly });
  const recs = recommendations({ actionableOnly: false, limit: 500 });

  const allOrders = orders.listOrders(1000);
  const settled = allOrders.filter((o) => o.realised.settled);
  const delivered = settled.filter((o) => o.status === 'delivered');
  const mixedCurrency = new Set(allOrders.map((o) => o.currency).filter(Boolean)).size > 1;

  // Settled cash flows stay in each order's own currency: payments were
  // converted into that currency at the payment date, not into a shared base.
  const revenueByCurrency = {};
  const costPaidByCurrency = {};
  for (const o of settled) {
    addMoney(revenueByCurrency, o.currency, o.realised.paidIn || 0);
    addMoney(costPaidByCurrency, o.currency, o.realised.paidOut || 0);
  }
  const revenue = singleCurrencyTotal(revenueByCurrency);
  const costPaid = singleCurrencyTotal(costPaidByCurrency);

  const grossProfitByCurrency = {};
  const grossMarginPctByCurrency = {};
  for (const cur of new Set([...Object.keys(revenueByCurrency), ...Object.keys(costPaidByCurrency)])) {
    const profit = pricing.round2((revenueByCurrency[cur] || 0) - (costPaidByCurrency[cur] || 0));
    grossProfitByCurrency[cur] = profit;
    grossMarginPctByCurrency[cur] = revenueByCurrency[cur] > 0
      ? pricing.round2((profit / revenueByCurrency[cur]) * 100, 1) : null;
  }
  const grossProfit = singleCurrencyTotal(grossProfitByCurrency);
  const grossMarginPct = singleCurrencyTotal(grossMarginPctByCurrency);

  const openOrders = allOrders.filter((o) => !o.realised.settled);
  const arByCurrency = {};
  const apByCurrency = {};
  for (const o of openOrders) {
    addMoney(arByCurrency, o.currency, o.realised.revenueOutstanding || 0);
    addMoney(apByCurrency, o.currency, o.realised.costOutstanding || 0);
  }
  const ar = singleCurrencyTotal(arByCurrency);
  const ap = singleCurrencyTotal(apByCurrency);
  const workingCapitalByCurrency = {};
  for (const cur of new Set([...Object.keys(arByCurrency), ...Object.keys(apByCurrency)])) {
    workingCapitalByCurrency[cur] = pricing.round2((arByCurrency[cur] || 0) - (apByCurrency[cur] || 0));
  }
  const workingCapital = singleCurrencyTotal(workingCapitalByCurrency);

  const inventoryCost = pricing.round2(db.prepare('SELECT COALESCE(SUM(on_hand * unit_cost),0) n FROM inventory_lots WHERE unit_cost IS NOT NULL').get().n);
  // A turnover ratio mixing base-currency stock with multi-currency cost paid
  // has no meaning without a dated conversion; costPaid is null when mixed.
  const daysInventory = inventoryCost > 0 && costPaid > 0 ? pricing.round2((inventoryCost / costPaid) * 30) : null;
  const inventoryTurn = daysInventory ? pricing.round2(360 / daysInventory) : null;

  const buyConv = plan.items.length ? pricing.round2(plan.items.reduce((s, i) => s + (i.buyConv || 1), 0) / plan.items.length, 2) : 1.0;
  const writeDown = pricing.round2(db.prepare(
    "SELECT COALESCE(SUM(on_hand * unit_cost * 0.1),0) n FROM inventory_lots WHERE unit_cost IS NOT NULL AND expiry_date IS NOT NULL AND date(expiry_date) < date('now')"
  ).get().n);

  const alertsK = alerts.counts();
  const movers = trends.priceMovers(10);

  return {
    baseCurrency: base,
    mixedCurrency,
    currencyWarning: mixedCurrency
      ? 'Orders span multiple currencies. Single totals are null; use the *ByCurrency breakdowns. There is no single amount without an explicit, dated FX conversion.'
      : null,
    summary: {
      // Mixed-currency scalars stay null. safeNum() would turn null into 0 and
      // present a fake zero balance, so it is only applied to real numbers.
      revenue: revenue == null ? null : safeNum(revenue),
      costPaid: costPaid == null ? null : safeNum(costPaid),
      grossProfit: grossProfit == null ? null : safeNum(grossProfit),
      grossMarginPct: grossMarginPct == null ? null : safeNum(grossMarginPct, 1),
      realisedMargin: ov.realisedMargin == null ? null : safeNum(ov.realisedMargin),
      fxAssumedOrders: ov.fxAssumedOrders,
      ordersSettled: settled.length,
      ordersDelivered: delivered.length,
      ordersOpen: openOrders.length,
      revenueByCurrency,
      costPaidByCurrency,
      grossProfitByCurrency,
      grossMarginPctByCurrency,
      realisedMarginByCurrency: ov.realisedMarginByCurrency,
    },
    cash: {
      ar: ar == null ? null : safeNum(ar),
      ap: ap == null ? null : safeNum(ap),
      workingCapital: workingCapital == null ? null : safeNum(workingCapital),
      arByCurrency,
      apByCurrency,
      workingCapitalByCurrency,
      capitalRequired: plan.totals.capital,
      capitalLimit,
      overCapital: plan.totals.overLimit,
    },
    stock: {
      inventoryUnits: ov.inventoryUnits,
      inventoryCost: safeNum(inventoryCost),
      daysInventory,
      inventoryTurn,
      writeDownRisk: safeNum(writeDown),
    },
    buying: {
      openDemands: ov.openDemands,
      recsTotal: recs.length,
      recsActionable: recs.filter((r) => r.actionable).length,
      planItems: plan.items.length,
      planActionable: plan.totals.actionable,
      avgBuyConv: safeNum(buyConv, 2),
    },
    quality: {
      openExceptions: ov.openExceptions,
      alerts: alertsK,
      priceMovers: movers.length,
      overlapProducts: ov.overlapProducts,
    },
  };
}

module.exports = { kpis, overview, opportunities, supplierStats, winsByType, addMoney, singleCurrencyTotal };
