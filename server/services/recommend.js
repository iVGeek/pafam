'use strict';

const { db, getSetting } = require('../db');
const sourcing = require('./sourcing');
const deal = require('./deal');
const { landedSettings } = sourcing;

function roundUpTo(n, multiple) {
  const q = Math.max(1, Math.floor(Number(n) || 0));
  const m = Number(multiple) > 0 ? Math.floor(multiple) : 1;
  return Math.ceil(q / m) * m;
}

// The quantity a buyer would actually order: at least the supplier MOQ and a
// whole number of order multiples. Never below the customer demand.
function orderQuantityFor(offer, demandQty) {
  if (!offer) return Math.max(1, Math.floor(demandQty || 1));
  const moq = Number(offer.moq) > 0 ? Number(offer.moq) : 1;
  const multiple = Number(offer.order_multiple) > 0 ? Number(offer.order_multiple) : 1;
  const target = Math.max(demandQty || 1, moq);
  return roundUpTo(target, multiple);
}

const FLAG_LABEL = {
  'no-price': 'no usable price',
  'retail-price': 'price is retail (RRP) with no trade discount',
  'tier-applied': 'quantity break applied',
  'below-moq': 'below supplier minimum order quantity',
  'not-order-multiple': 'not a whole order multiple',
  'availability-unit-unknown': 'stock availability unit unknown',
  'insufficient-stock': 'not enough stock for the quantity',
  'expired': 'offer expired',
  'not-eligible': 'supplier not permitted for destination',
  'incoterm-unknown': 'incoterm unknown',
  'incomplete-cost': 'landed-cost inputs incomplete',
};

function labelFlags(flags) {
  return (flags || []).map((f) => FLAG_LABEL[f] || f);
}

// A buying recommendation for one product (brief section 10 / 4.6): match the
// customer demand against the cheapest *executable* supplier, round the order
// to the supplier's MOQ/order multiple, price it against policy and show
// capital, expected collection and every missing assumption. Read-only — it
// never commits anything; a human converts it to a quote or order.
function recommendationFor(productId, opts = {}) {
  const settings = landedSettings();
  const base = settings.base_currency;
  const dest = (opts.destination || settings.dest_market || 'US').toUpperCase();
  const minMarginPct = Number(getSetting('min_margin_pct', '15'));
  const minMarkup = Number(getSetting('min_markup', '0.75'));
  const capitalLimit = Number(getSetting('capital_limit', '250000'));

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(productId));
  if (!product) return null;

  const demands = db.prepare(
    `SELECT d.*, c.name AS customer_name, c.region, c.payment_terms
       FROM demands d JOIN customers c ON c.id = d.customer_id
      WHERE d.product_id = ? AND d.status IN ('open','wishlist','quoted')
      ORDER BY (d.needed_by IS NULL), d.needed_by, d.id`
  ).all(Number(productId));
  if (!demands.length) return null;

  const demandQty = demands.reduce((s, d) => s + (Number(d.quantity) || 0), 0);
  const targetPrices = demands.map((d) => Number(d.target_price)).filter((n) => Number.isFinite(n) && n > 0);
  const targetPrice = targetPrices.length ? Math.max(...targetPrices) : null;
  const neededBy = demands.map((d) => d.needed_by).filter(Boolean).sort()[0] || null;

  const sourced = sourcing.sourceLowest({ productId: Number(productId), quantity: demandQty, destination: dest, baseCurrency: base });
  const winner = sourced.winner || null;

  // Cost-known candidates (executable first, then excluded that still priced),
  // so we can honestly show the closest option even when none is executable.
  const priced = [
    ...(sourced.ranked || []),
    ...(sourced.excluded || []).filter((e) => e.landedUnitCost != null),
  ].sort((a, b) => a.landedUnitCost - b.landedUnitCost);

  const candidates = priced.slice(0, 4).map((c) => ({
    supplier: c.supplier,
    offerId: c.offerId,
    currency: c.currency,
    landedUnitCost: c.landedUnitCost,
    executable: !!c.executable,
    complete: c.complete !== false,
    reasons: labelFlags(c.flags),
  }));

  const chosen = winner || priced[0] || null;
  const offer = chosen ? deal.getOffer(chosen.offerId) : null;
  const orderQuantity = orderQuantityFor(offer, demandQty);

  const missing = chosen ? (chosen.missing || []) : ['no priced supplier'];
  const warnings = [
    ...sourced.warnings,
    ...(chosen && !chosen.executable ? ['No fully executable supplier — showing the closest priced option.'] : []),
  ];

  // Suggested sell: highest customer target, else RRP-derived, else the policy
  // floor (minimum price that still clears the margin/markup policy).
  let suggestedSell = null;
  let sellSource = null;
  if (targetPrice != null) { suggestedSell = targetPrice; sellSource = 'customer target'; }
  else if (offer && offer.rrp != null && Number(offer.rrp) > 0) { suggestedSell = Number(offer.rrp); sellSource = 'supplier RRP'; }

  let landedUnitCost = chosen ? chosen.landedUnitCost : null;
  const policyFloor = landedUnitCost != null
    ? Math.max(landedUnitCost / (1 - minMarginPct / 100), landedUnitCost + minMarkup)
    : null;
  if (suggestedSell == null && policyFloor != null) {
    suggestedSell = Math.round(policyFloor * 100) / 100;
    sellSource = 'policy floor';
  }

  let contribution = null;
  let cashRequirement = null;
  let expectedCollection = null;
  let marginPct = null;
  let markup = null;
  let meetsPolicy = null;
  let withinCapitalLimit = null;

  if (chosen && suggestedSell != null) {
    const result = deal.buildDeal({
      offerId: chosen.offerId,
      quantity: orderQuantity,
      sellingUnitPrice: suggestedSell,
      customerId: demands[0].customer_id,
      destination: dest,
      baseCurrency: base,
    });
    if (result.found) {
      landedUnitCost = result.deal.metrics.landedUnitCost;
      marginPct = result.deal.metrics.marginPct;
      markup = result.deal.metrics.markup;
      meetsPolicy = result.deal.metrics.passesPolicy;
      contribution = result.deal.contribution.total;
      cashRequirement = result.deal.cashflow.peakCapital;
      expectedCollection = result.deal.cashflow.customerDue;
      withinCapitalLimit = capitalLimit > 0 ? cashRequirement <= capitalLimit : true;
    } else {
      warnings.push(result.error || 'deal could not be computed');
    }
  }

  const executable = !!(winner && suggestedSell != null && contribution != null);
  const approved = demands.some((d) => d.approved) || false;
  const actionable = executable && meetsPolicy === true && withinCapitalLimit === true && missing.length === 0;

  return {
    productId: Number(productId),
    product: {
      id: product.id,
      displayName: product.display_name,
      canonicalGtin: product.canonical_gtin,
      brand: product.brand,
      sizeMl: product.size_ml,
      category: product.category,
    },
    demandQuantity: demandQty,
    orderQuantity,
    destination: dest,
    baseCurrency: base,
    neededBy,
    customers: demands.map((d) => ({
      demandId: d.id,
      customerId: d.customer_id,
      customerName: d.customer_name,
      region: d.region,
      quantity: Number(d.quantity) || 0,
      targetPrice: d.target_price != null ? Number(d.target_price) : null,
      neededBy: d.needed_by,
      status: d.status,
      approved: !!d.approved,
    })),
    demandStatus: [...new Set(demands.map((d) => d.status))].join(', '),
    approved,
    supplier: chosen ? { code: chosen.supplier, offerId: chosen.offerId, currency: chosen.currency, complete: chosen.complete !== false } : null,
    executable,
    supplierExecutable: !!winner,
    runnerUp: sourced.runnerUp ? { code: sourced.runnerUp.supplier, landedUnitCost: sourced.runnerUp.landedUnitCost } : null,
    candidates,
    landedUnitCost,
    suggestedSell,
    sellSource,
    policyFloor: policyFloor != null ? Math.round(policyFloor * 100) / 100 : null,
    marginPct,
    markup,
    contribution,
    cashRequirement,
    expectedCollection,
    meetsPolicy,
    withinCapitalLimit,
    capitalLimit,
    minMarginPct,
    minMarkup,
    reasons: chosen ? labelFlags(chosen.flags) : [],
    missing,
    warnings,
    actionable,
    sourceCounts: sourced.counts,
  };
}

function recommendations(opts = {}) {
  const rows = db.prepare(
    `SELECT DISTINCT product_id FROM demands
      WHERE status IN ('open','wishlist','quoted') AND product_id IS NOT NULL`
  ).all().map((r) => r.product_id);

  let out = rows.map((pid) => recommendationFor(pid, opts)).filter(Boolean);
  if (opts.actionableOnly) out = out.filter((r) => r.actionable);
  out.sort((a, b) => (b.contribution || 0) - (a.contribution || 0));
  const limit = Math.min(Number(opts.limit) || 200, 1000);
  return out.slice(0, limit);
}

module.exports = { recommendationFor, recommendations, orderQuantityFor, roundUpTo };
