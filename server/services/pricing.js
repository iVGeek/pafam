'use strict';

// Pricing / profitability engine per brief sections 7-9 and the GCS pricing rules.
// Pure functions (no DB) so they are unit-testable and reusable by API + UI.
//
// Key definitions (brief section 7):
//   margin = (sell - cost) / sell
//   markup = sell - cost            (absolute, in currency)
// GCS house rules: minimum 15% margin, minimum 0.75 markup.

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function round4(n) { return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000; }
function safe(n, d = 0) { const x = Number(n); return Number.isFinite(x) ? x : d; }

// Convert a supplier's quoted price into a per-bottle acquisition price.
// Handles: price_type 'rrp' (apply discount off RRP) and price_basis 'case'
// (divide by units per case). Never merges case barcode into unit barcode.
function unitAcquisitionPrice(offer, opts = {}) {
  const unitsPerCase = safe(offer.units_per_case, 1) || 1;
  const discount = safe(
    opts.discountOffRrpPct !== undefined ? opts.discountOffRrpPct : offer.default_discount_pct,
    0
  );
  let price = safe(offer.price, NaN);
  if (!Number.isFinite(price)) return { perBottle: null, basis: offer.price_basis || 'unit', source: 'missing' };

  const notes = [];
  if (offer.price_type === 'rrp') {
    price = price * (1 - discount / 100);
    notes.push(`rrp minus ${discount}%`);
  }
  if (offer.price_basis === 'case') {
    price = price / unitsPerCase;
    notes.push(`per case of ${unitsPerCase}`);
  }
  return {
    perBottle: price,
    basis: offer.price_basis || 'unit',
    source: offer.price_type || 'cost',
    notes: notes.join(', '),
  };
}

// Landed unit cost build-up (per bottle).
function landedUnitCost(input) {
  const purchase = safe(input.purchaseUnitPrice);
  const dutyPct = safe(input.dutyPct);
  const duty = purchase * (dutyPct / 100);
  const freight = safe(input.freightPerUnit);
  const insurance = safe(input.insurancePerUnit);
  const brokerage = safe(input.brokeragePerUnit);
  const handling = safe(input.handlingPerUnit);
  const otherTaxes = safe(input.otherTaxesPerUnit);
  const total = purchase + duty + freight + insurance + brokerage + handling + otherTaxes;
  return {
    purchase: round4(purchase),
    duty: round4(duty),
    freight: round4(freight),
    insurance: round4(insurance),
    brokerage: round4(brokerage),
    handling: round4(handling),
    otherTaxes: round4(otherTaxes),
    total: round4(total),
  };
}

// Full deal profitability.
function dealMetrics(input) {
  const qty = safe(input.quantity, 1);
  const landed = safe(input.landedUnitCost);
  const sell = safe(input.sellingUnitPrice);

  const discountPct = safe(input.discountPct);
  const rebatePct = safe(input.rebatePct);
  const returnsPct = safe(input.returnsAllowancePct);
  const deductionPct = safe(input.customerDeductionPct);
  const termsPct = safe(input.paymentTermsCostPct);

  const totalOffPct = discountPct + rebatePct + returnsPct + deductionPct;
  const grossListUnit = sell;
  const netUnitRevenue = sell * (1 - totalOffPct / 100) * (1 - termsPct / 100);

  const grossProfitUnit = netUnitRevenue - landed;
  const grossProfitTotal = grossProfitUnit * qty;
  const revenueTotal = netUnitRevenue * qty;
  const costTotal = landed * qty;

  const marginPct = netUnitRevenue > 0 ? (grossProfitUnit / netUnitRevenue) * 100 : 0;
  const markup = netUnitRevenue - landed;
  const markupPctOfCost = landed > 0 ? (grossProfitUnit / landed) * 100 : 0;
  const roiPct = landed > 0 ? (grossProfitUnit / landed) * 100 : 0;
  const daysToCash = safe(input.daysToCash, 30) || 30;
  const annualisedRoiPct = roiPct * (365 / daysToCash);

  const pass =
    marginPct >= safe(input.minMarginPct, 0) - 1e-9 &&
    markup >= safe(input.minMarkup, 0) - 1e-9;

  return {
    quantity: qty,
    landedUnitCost: round4(landed),
    grossListUnit: round4(grossListUnit),
    discountPct: round4(totalOffPct),
    netUnitRevenue: round4(netUnitRevenue),
    grossProfitUnit: round4(grossProfitUnit),
    grossProfitTotal: round2(grossProfitTotal),
    revenueTotal: round2(revenueTotal),
    costTotal: round2(costTotal),
    marginPct: round4(marginPct),
    markup: round4(markup),
    markupPctOfCost: round4(markupPctOfCost),
    roiPct: round4(roiPct),
    annualisedRoiPct: round4(annualisedRoiPct),
    daysToCash,
    passesPolicy: pass,
  };
}

// Discount off RRP as a percentage.
function discountOffRrpPct(price, rrp) {
  if (!rrp) return null;
  return round4(((rrp - price) / rrp) * 100);
}

// FX conversion. rate = quote units per 1 base unit. Pass base->quote directly.
function convert(amount, rate) {
  return safe(amount) * safe(rate, 1);
}

module.exports = {
  round2, round4,
  unitAcquisitionPrice,
  landedUnitCost,
  dealMetrics,
  discountOffRrpPct,
  convert,
};
