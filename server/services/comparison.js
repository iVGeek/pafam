'use strict';

const { db, getSetting } = require('../db');
const pricing = require('./pricing');
const fx = require('./fx');

// Normalise an offer row into a per-bottle acquisition price in the base currency,
// plus explicit comparability flags. This is the crux of the brief: never compare
// a case price with a bottle price, or a cost with a retail price, without saying so.
function normalizeOffer(offer, baseCurrency) {
  const base = baseCurrency || getSetting('base_currency', 'USD');
  const unitsPerCase = Number(offer.units_per_case) > 0 ? Number(offer.units_per_case) : 1;

  const acq = pricing.unitAcquisitionPrice(
    {
      price: offer.price,
      price_type: offer.price_type,
      price_basis: offer.price_basis,
      units_per_case: unitsPerCase,
      default_discount_pct: offer.default_discount_pct || 0,
      exp_discount_pct: offer.exp_discount_pct || 0,
    },
    {}
  );

  let perBottle = acq.perBottle;
  let perBottleBase = null;
  let fxRate = 1;
  if (perBottle != null) {
    fxRate = fx.getRate(offer.currency, base);
    if (fxRate == null) fxRate = 1;
    perBottleBase = pricing.round4(perBottle * fxRate);
  }

  // An RRP-priced offer is only a usable cost once a trade discount converts it.
  const effectiveDiscount = Number(offer.default_discount_pct) || 0;
  const isRrp = offer.price_type === 'rrp';
  const derivedFromRrp = isRrp && effectiveDiscount > 0;
  const isRetail = isRrp && !derivedFromRrp; // pure retail, not comparable to a cost

  const flags = [];
  if (isRetail) flags.push('retail-price');
  if (derivedFromRrp) flags.push('estimated-cost-from-rrp');
  if (offer.price_basis === 'case') flags.push('priced-per-case');
  if (offer.gtin_valid === 0) flags.push('invalid-barcode');
  if (offer.price == null) flags.push('no-price');

  return {
    perBottle: perBottle == null ? null : pricing.round4(perBottle),
    perBottleBase,
    currency: offer.currency,
    baseCurrency: base,
    fxRate,
    isRetail,
    derivedFromRrp,
    flags,
    basis: acq.basis,
  };
}

// All offers for a product, each normalised and sorted cheapest first.
// Only comparable offers (acquisition cost, valid) participate in ranking.
function compareProduct(productId, opts = {}) {
  const base = opts.baseCurrency || getSetting('base_currency', 'USD');
  const rows = db.prepare(
    `SELECT o.*, s.name AS supplier_name, s.default_discount_pct
     FROM offers o JOIN suppliers s ON s.code = o.supplier_code
     WHERE o.product_id = ?
     ORDER BY o.price ASC`
  ).all(productId);

  const enriched = rows.map((r) => {
    const n = normalizeOffer(r, base);
    return {
      offerId: r.id,
      supplier: r.supplier_code,
      supplierName: r.supplier_name,
      description: r.description,
      category: r.category,
      sizeMl: r.size_ml,
      currency: r.currency,
      price: r.price,
      priceBasis: r.price_basis,
      priceType: r.price_type,
      unitsPerCase: r.units_per_case,
      rrp: r.rrp,
      expiryDate: r.expiry_date,
      notes: r.notes,
      listDate: r.list_date,
      incoterm: r.incoterm,
      incotermPlace: r.incoterm_place,
      ...n,
    };
  });

  // ranking: only non-retail, priced offers
  const rankable = enriched.filter((e) => !e.isRetail && e.perBottleBase != null).sort((a, b) => a.perBottleBase - b.perBottleBase);
  const best = rankable[0] || null;
  const worst = rankable[rankable.length - 1] || null;
  const spread = best && worst ? pricing.round4(worst.perBottleBase - best.perBottleBase) : null;
  const spreadPct = best && worst && best.perBottleBase > 0 ? pricing.round4((spread / best.perBottleBase) * 100) : null;

  return {
    productId,
    baseCurrency: base,
    offers: enriched,
    rankableCount: rankable.length,
    best: best ? { offerId: best.offerId, supplier: best.supplier, perBottleBase: best.perBottleBase, currency: best.currency } : null,
    savingsPerBottle: spread,
    savingsPct: spreadPct,
    comparabilityWarning: rankable.length > 0 && enriched.length > rankable.length
      ? 'Some offers are retail (RRP) or un-priced and are excluded from ranking.'
      : null,
  };
}

module.exports = { normalizeOffer, compareProduct };
