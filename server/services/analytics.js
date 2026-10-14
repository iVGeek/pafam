'use strict';

const { db, getSetting } = require('../db');
const pricing = require('./pricing');
const { normalizeOffer } = require('./comparison');
const orders = require('./orders');

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
  const realisedMargin = pricing.round2(settled.reduce((s, o) => s + o.realised.realisedMargin, 0));
  const ordersOpen = allOrders.filter((o) => !o.realised.settled).length;

  return {
    baseCurrency: base,
    offers, suppliers, products, uploads,
    openExceptions, exceptionsByType,
    overlapProducts,
    customers, openDemands, inventoryUnits,
    orders: allOrders.length,
    ordersOpen,
    realisedMargin,
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

module.exports = { overview, opportunities, supplierStats, winsByType };
