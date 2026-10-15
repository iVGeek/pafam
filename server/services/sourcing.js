'use strict';

const { db, getSetting } = require('../db');
const { computeLanded } = require('./landing');
const pricing = require('./pricing');
const fx = require('./fx');
const gtin = require('../../src/lib/gtin');
const approvals = require('./approvals');

// Business Q1: for an exact SKU and quantity delivered to our destination,
// which supplier offers the lowest EXECUTABLE landed cost? This service loads
// every offer for the product, computes the landed cost at the requested
// quantity, then ranks only the executable ones (MOQ met, in stock, unexpired,
// destination-eligible, not pure retail).

function landedSettings() {
  return {
    base_currency: getSetting('base_currency', 'USD'),
    dest_market: getSetting('dest_market', 'US'),
    default_duty_pct: getSetting('default_duty_pct', '0'),
    default_freight_per_unit: getSetting('default_freight_per_unit', '0'),
    default_insurance_pct: getSetting('default_insurance_pct', '0'),
    default_brokerage: getSetting('default_brokerage', '0'),
    default_handling_per_unit: getSetting('default_handling_per_unit', '0'),
    default_other_tax_pct: getSetting('default_other_tax_pct', '0'),
  };
}

function resolveProduct({ productId, gtin: rawGtin }) {
  if (productId) return db.prepare('SELECT * FROM products WHERE id = ?').get(Number(productId));
  if (rawGtin) {
    const g = gtin.analyse(rawGtin);
    if (g.valid) return db.prepare('SELECT * FROM products WHERE canonical_gtin = ?').get(g.canonical14);
  }
  return null;
}

const OFFER_QUERY = `
  SELECT o.*,
         s.name AS supplier_name,
         s.default_discount_pct AS supplier_discount,
         s.incoterm AS supplier_incoterm,
         s.duty_pct, s.freight_per_unit, s.insurance_pct,
         s.brokerage_per_unit, s.handling_per_unit, s.other_tax_pct
    FROM offers o
    JOIN suppliers s ON s.code = o.supplier_code
   WHERE o.product_id = ?
     AND o.status IN ('new','matched')`;

function sourceLowest({ productId, gtin: rawGtin, quantity, destination, baseCurrency } = {}) {
  const settings = landedSettings();
  const base = baseCurrency || settings.base_currency;
  const qty = Number(quantity) > 0 ? Number(quantity) : 1;
  const dest = (destination || settings.dest_market || 'US').toUpperCase();

  const product = resolveProduct({ productId, gtin: rawGtin });
  if (!product) return { found: false, quantity: qty, destination: dest, baseCurrency: base };

  const rows = db.prepare(OFFER_QUERY).all(product.id);
  const rateCache = {};
  const approvalEnforced = approvals.approvalRequired();
  const results = rows.map((r) => {
    const key = r.currency;
    if (!(key in rateCache)) rateCache[key] = fx.getRate(r.currency, base) || 1;
    const supplier = {
      name: r.supplier_name,
      default_discount_pct: r.supplier_discount,
      incoterm: r.supplier_incoterm,
      duty_pct: r.duty_pct,
      freight_per_unit: r.freight_per_unit,
      insurance_pct: r.insurance_pct,
      brokerage_per_unit: r.brokerage_per_unit,
      handling_per_unit: r.handling_per_unit,
      other_tax_pct: r.other_tax_pct,
    };
    const landed = computeLanded(r, supplier, {
      quantity: qty,
      destination: dest,
      baseCurrency: base,
      settings,
      fxRate: rateCache[key],
    });
    // Staff approval (section 3/16): when enforcement is on, an offer that has
    // not been signed off cannot be traded, so it must not win the comparison.
    const approvalStatus = r.approval_status || 'review';
    if (approvalEnforced && approvalStatus !== 'approved') {
      landed.flags.push('not-approved');
      landed.executable = false;
      landed.missing.push('staff approval');
    }
    landed.approvalStatus = approvalStatus;
    landed.approvedBy = r.approved_by || null;
    return landed;
  });

  const executable = results
    .filter((r) => r.executable && r.landedUnitCost != null)
    .sort((a, b) => a.landedUnitCost - b.landedUnitCost);
  const excluded = results.filter((r) => !r.executable || r.landedUnitCost == null);

  const winner = executable[0] || null;
  const runnerUp = executable[1] || null;
  const worst = executable[executable.length - 1] || null;
  const savingsVsNext = winner && runnerUp
    ? pricing.round4(runnerUp.landedUnitCost - winner.landedUnitCost)
    : null;
  const spread = winner && worst
    ? pricing.round4(worst.landedUnitCost - winner.landedUnitCost)
    : null;
  const spreadPct = winner && worst && winner.landedUnitCost > 0
    ? pricing.round4((spread / winner.landedUnitCost) * 100)
    : null;

  const incompleteCount = executable.filter((e) => !e.complete).length;

  return {
    found: true,
    product,
    quantity: qty,
    destination: dest,
    baseCurrency: base,
    settings,
    winner,
    runnerUp,
    ranked: executable,
    excluded,
    counts: { offers: results.length, executable: executable.length, excluded: excluded.length, incomplete: incompleteCount },
    savingsVsNext,
    spread,
    spreadPct,
    warnings: [
      ...(executable.length && incompleteCount ? [`${incompleteCount} executable offer(s) are missing landed-cost inputs (shown as assumed).`] : []),
      ...(excluded.length ? [`${excluded.length} offer(s) excluded (MOQ, stock, expiry, eligibility or retail price).`] : []),
    ],
  };
}

module.exports = { sourceLowest, landedSettings };
