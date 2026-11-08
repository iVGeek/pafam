'use strict';

// Opportunity ranking (brief section 18).
//
// "Rank opportunities by contribution, credible sell-through, cash cycle,
//  customer credit and concentration risk. Cap speculative buying and
//  exposure per SKU, brand, supplier and customer. Calculate maximum buy
//  price from conservative achievable selling price less all deal costs
//  and required contribution. Calculate the customer-specific minimum
//  sell price consistently."
//
// Inputs come from the existing buying recommendations (contribution, cash,
// policy). Sell-through and credit are estimated from history the system
// holds; where history does not exist the estimate is labelled, never
// invented. Exposure caps: speculative cash per dimension must stay under
// a configurable share of the capital limit (settings).

const { db, getSetting } = require('../db');
const { recommendations } = require('./recommend');
const scorecards = require('./supplierScorecard');

function clamp01(n) { return Math.max(0, Math.min(1, n)); }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }

function customerStats(customerId) {
  const demands = db.prepare(
    'SELECT status, COUNT(*) n FROM demands WHERE customer_id = ? GROUP BY status'
  ).all(customerId);
  const byStatus = {};
  demands.forEach((r) => { byStatus[r.status] = r.n; });
  const won = byStatus.won || 0;
  const closed = won + (byStatus.lost || 0) + (byStatus.expired || 0);
  const winRate = closed > 0 ? won / closed : null;
  const customer = db.prepare('SELECT credit_limit, payment_terms FROM customers WHERE id = ?').get(customerId);
  // Outstanding: open orders' revenue outstanding (customer owes us)
  const openOrders = db.prepare('SELECT id FROM orders WHERE customer_id = ? AND status NOT IN (\'closed\', \'cancelled\', \'delivered\')').all(customerId);
  let outstanding = 0;
  for (const o of openOrders) {
    const paidIn = db.prepare(
      "SELECT COALESCE(SUM(amount),0) n FROM payments WHERE order_id = ? AND direction = 'inbound'"
    ).get(o.id).n;
    const order = db.prepare('SELECT quantity, unit_price FROM orders WHERE id = ?').get(o.id);
    outstanding += Math.max(0, (Number(order.quantity) || 0) * (Number(order.unit_price) || 0) - Number(paidIn || 0));
  }
  return {
    byStatus,
    winRate: winRate != null ? round2(winRate) : null,
    closed,
    creditLimit: customer && customer.credit_limit != null ? Number(customer.credit_limit) : null,
    paymentTerms: customer ? customer.payment_terms : null,
    outstanding: round2(outstanding),
  };
}

// Credible sell-through for one recommendation.
// explicit demand states + customer win-rate when history exists.
function sellThrough(rec) {
  const statusScore = { open: 0.5, quoted: 0.8, wishlist: 0.3, matched: 0.6 };
  const statuses = String(rec.demandStatus || '').split(',').map((s) => s.trim());
  const base = Math.max(...statuses.map((s) => statusScore[s] != null ? statusScore[s] : 0.5));
  const custId = rec.customers && rec.customers[0] && rec.customers[0].customerId;
  const stats = custId ? customerStats(custId) : null;
  if (stats && stats.winRate != null) {
    // Blend: 60% demand state, 40% proven win rate
    return { probability: clamp01(base * 0.6 + stats.winRate * 0.4), basis: `demand ${statuses.join('/')} blended with customer win rate ${stats.winRate}` };
  }
  return { probability: clamp01(base), basis: `demand status only (${statuses.join('/')}) — no customer history` };
}

function creditScore(rec) {
  const custId = rec.customers && rec.customers[0] && rec.customers[0].customerId;
  if (!custId) return { score: null, utilisation: null, limit: null, outstanding: null };
  const stats = customerStats(custId);
  if (stats.creditLimit == null || stats.creditLimit <= 0) {
    return { score: null, utilisation: null, limit: null, outstanding: stats.outstanding, terms: stats.paymentTerms };
  }
  const utilisation = clamp01(stats.outstanding / stats.creditLimit);
  // Lower utilisation = safer. Score is headroom.
  return { score: clamp01(1 - utilisation), utilisation: round2(utilisation), limit: stats.creditLimit, outstanding: stats.outstanding, terms: stats.paymentTerms };
}

function rankOpportunities(opts = {}) {
  const caps = {
    sku: Number(getSetting('exposure_cap_sku_pct', '25')) / 100,
    brand: Number(getSetting('exposure_cap_brand_pct', '40')) / 100,
    supplier: Number(getSetting('exposure_cap_supplier_pct', '50')) / 100,
    customer: Number(getSetting('exposure_cap_customer_pct', '50')) / 100,
  };
  const capitalLimit = Number(getSetting('capital_limit', '250000')) || 0;
  const recs = recommendations({ actionableOnly: false, limit: 500 });

  // Running exposure (cash committed) per dimension, in rank order.
  const exposure = { sku: new Map(), brand: new Map(), supplier: new Map(), customer: new Map() };
  const add = (map, key, amt) => map.set(key, (map.get(key) || 0) + (Number(amt) || 0));

  const ranked = recs.map((rec) => {
    const cash = Number(rec.cashRequirement) || 0;
    const contrib = Number(rec.contribution) || 0;
    const st = sellThrough(rec);
    const credit = creditScore(rec);
    const supCode = rec.supplier && rec.supplier.code;
    const supCard = supCode ? scorecards.scorecard(supCode) : null;
    const supGrade = supCard && !supCard.error ? supCard.grade : null;

    // Exposure shares against capital limit (if set)
    const capOf = (pct) => capitalLimit > 0 ? capitalLimit * pct : null;
    const skuKey = rec.productId, brandKey = (rec.product && rec.product.brand) || 'unknown';
    const custKey = rec.customers && rec.customers[0] && rec.customers[0].customerId;
    const before = {
      sku: exposure.sku.get(skuKey) || 0,
      brand: exposure.brand.get(brandKey) || 0,
      supplier: exposure.supplier.get(supCode) || 0,
      customer: exposure.customer.get(custKey) || 0,
    };
    const after = {
      sku: before.sku + cash, brand: before.brand + cash,
      supplier: before.supplier + cash, customer: before.customer + cash,
    };
    const breached = [];
    const check = (dim, afterAmt, pct) => {
      const cap = capOf(pct);
      if (cap != null && afterAmt > cap) breached.push(`${dim} exposure ${round2(afterAmt)} exceeds cap ${round2(cap)}`);
    };
    check('SKU', after.sku, caps.sku);
    check('brand', after.brand, caps.brand);
    check('supplier', after.supplier, caps.supplier);
    check('customer', after.customer, caps.customer);

    // Max buy / min sell (brief section 18), both consistent:
    // conservative sell = lowest credible anchor (target or RRP-derived)
    const landed = Number(rec.landedUnitCost) || 0;
    const margin = Number(getSetting('min_margin_pct', '15')) / 100;
    const minSell = landed > 0 ? round2(Math.max(landed / (1 - margin), landed + Number(getSetting('min_markup', '0.75')))) : null;
    const conservativeSell = rec.suggestedSell != null ? Number(rec.suggestedSell) : null;
    const maxBuy = conservativeSell != null && landed > 0
      ? round2(conservativeSell * (1 - margin))
      : null;

    // Score (redistributes when a factor is unknown)
    const parts = [
      { key: 'contribution', label: 'Contribution', value: contrib > 0 && cash > 0 ? clamp01(contrib / Math.max(cash, 1) / 0.5) : (contrib > 0 ? 0.5 : 0), weight: 30 },
      { key: 'sellThrough', label: 'Sell-through', value: st.probability, weight: 25 },
      { key: 'capitalEfficiency', label: 'Capital efficiency (return on cash)', value: contrib > 0 && cash > 0 ? clamp01((contrib / cash) / 0.5) : 0, weight: 20 },
      { key: 'credit', label: 'Customer credit headroom', value: credit.score, weight: 15 },
      { key: 'concentration', label: 'Concentration (low exposure = better)', value: capitalLimit > 0 ? clamp01(1 - Math.max(after.sku, after.brand, after.supplier, after.customer) / capitalLimit) : null, weight: 10 },
    ];
    const known = parts.filter((p) => p.value != null);
    const tw = known.reduce((s, p) => s + p.weight, 0) || 1;
    const score = known.length ? Math.round(known.reduce((s, p) => s + p.value * p.weight, 0) / tw * 1000) / 10 : null;

    const entry = {
      rank: 0,
      productId: rec.productId,
      product: rec.product,
      demandQuantity: rec.demandQuantity,
      orderQuantity: rec.orderQuantity,
      customers: rec.customers,
      supplier: rec.supplier,
      supplierGrade: supGrade,
      executable: rec.executable,
      actionable: rec.actionable && breached.length === 0,
      contribution: rec.contribution,
      cashRequirement: rec.cashRequirement,
      expectedCollection: rec.expectedCollection,
      meetsPolicy: rec.meetsPolicy,
      withinCapitalLimit: rec.withinCapitalLimit,
      sellThrough: st,
      credit,
      exposure: {
        sku: round2(after.sku), brand: round2(after.brand),
        supplier: round2(after.supplier), customer: round2(after.customer),
      },
      caps,
      breached,
      maxBuyPrice: maxBuy,
      minSellPrice: minSell,
      conservativeSell,
      scoredParts: known.map((p) => ({ key: p.key, label: p.label, value: Math.round(p.value * 1000) / 10, weight: p.weight })),
      missingParts: parts.filter((p) => p.value == null).map((p) => p.label),
      score,
    };
    // Commit exposure for the next opportunity
    add(exposure.sku, skuKey, cash);
    add(exposure.brand, brandKey, cash);
    add(exposure.supplier, supCode, cash);
    add(exposure.customer, custKey, cash);
    return entry;
  });

  // Rank: score first, then contribution. Blocked (capped) sink.
  ranked.sort((a, b) => {
    if ((a.breached.length ? 1 : 0) !== (b.breached.length ? 1 : 0)) return (a.breached.length ? 1 : 0) - (b.breached.length ? 1 : 0);
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    return (b.contribution || 0) - (a.contribution || 0);
  });
  ranked.forEach((r, i) => { r.rank = i + 1; });
  if (opts.actionableOnly) return ranked.filter((r) => r.actionable);
  return ranked;
}

module.exports = { rankOpportunities, sellThrough, customerStats };
