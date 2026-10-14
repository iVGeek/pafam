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

/* ======================= payment terms & dated cash flow ======================= */

// Read the number of days from free-text commercial terms, e.g.
// "Net 30" -> 30, "30 days" -> 30, "2/10 Net 45" -> 45, "Prepay"/"COD" -> 0.
function parseTermsDays(terms, fallback = 0) {
  if (terms === null || terms === undefined || terms === '') return fallback;
  const s = String(terms).toLowerCase();
  let m = s.match(/net\s*(\d+)/);
  if (m) return Number(m[1]);
  m = s.match(/(\d+)\s*(?:days?|d\b)/);
  if (m) return Number(m[1]);
  if (/(prepay|pre-?payment|pro\s*forma|in advance|cash with order|cwo|cod|cash on delivery|immediate|advance|l\/c|letter of credit)/.test(s)) return 0;
  return fallback;
}

function addDays(dateStr, days) {
  const base = dateStr ? new Date(dateStr + 'T00:00:00Z') : new Date();
  const d = new Date(base.getTime() + Math.round(safe(days, 0)) * 86400000);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00Z').getTime();
  const db = new Date(b + 'T00:00:00Z').getTime();
  return Math.round((db - da) / 86400000);
}

// Dated cash-flow schedule for a single buy-sell cycle. Shows when cash leaves
// (supplier paid) and returns (customer pays), the peak funding requirement
// (capital) and how many days that capital is employed.
function cashflow(input) {
  const totalCost = safe(input.totalCost);
  const totalRevenue = safe(input.totalRevenue);
  const supplierPayDays = safe(input.supplierPayDays, 0);
  const customerPayDays = safe(input.customerPayDays, 30);
  const leadTimeDays = safe(input.leadTimeDays, 0);
  const transitDays = safe(input.transitDays, 0);
  const orderDate = input.orderDate || new Date().toISOString().slice(0, 10);

  const goodsDays = leadTimeDays + transitDays;
  const supplierDue = addDays(orderDate, supplierPayDays);
  const goodsDate = addDays(orderDate, goodsDays);
  const customerDue = addDays(goodsDate, customerPayDays);

  const events = [
    { label: 'Order placed', date: orderDate, day: 0, amount: 0 },
    { label: 'Pay supplier', date: supplierDue, day: supplierPayDays, amount: -totalCost },
    { label: 'Goods received', date: goodsDate, day: goodsDays, amount: 0 },
    { label: 'Customer pays', date: customerDue, day: goodsDays + customerPayDays, amount: totalRevenue },
  ].sort((a, b) => a.day - b.day);

  let balance = 0;
  let peakDeficit = 0;
  const schedule = events.map((e) => {
    balance += e.amount;
    if (balance < peakDeficit) peakDeficit = balance;
    return { ...e, amount: round2(e.amount), balance: round2(balance) };
  });

  const capitalDays = daysBetween(supplierDue, customerDue);
  const peakCapital = round2(-peakDeficit);

  return {
    orderDate,
    supplierDue,
    goodsDate,
    customerDue,
    supplierPayDays,
    customerPayDays,
    leadTimeDays,
    transitDays,
    capitalDays,
    peakCapital,
    negativeWorkingCapital: capitalDays < 0,
    capitalTurnover: capitalDays > 0 ? round4(365 / capitalDays) : null,
    schedule,
  };
}

// Full deal: contribution/profit plus the dated cash flow and capital employed.
// Combines dealMetrics (profitability + policy) with cashflow (timing/capital).
function computeDeal(input) {
  const qty = safe(input.quantity, 1) || 1;
  const metrics = dealMetrics({
    quantity: qty,
    landedUnitCost: input.landedUnitCost,
    sellingUnitPrice: input.sellingUnitPrice,
    discountPct: input.discountPct,
    rebatePct: input.rebatePct,
    returnsAllowancePct: input.returnsAllowancePct,
    customerDeductionPct: input.customerDeductionPct,
    paymentTermsCostPct: input.paymentTermsCostPct,
    daysToCash: input.daysToCash,
    minMarginPct: input.minMarginPct,
    minMarkup: input.minMarkup,
  });

  const cf = cashflow({
    totalCost: metrics.costTotal,
    totalRevenue: metrics.revenueTotal,
    supplierPayDays: input.supplierPayDays,
    customerPayDays: input.customerPayDays,
    leadTimeDays: input.leadTimeDays,
    transitDays: input.transitDays,
    orderDate: input.orderDate,
  });

  const annualisedRoiPct = cf.capitalDays > 0
    ? round4(metrics.roiPct * (365 / cf.capitalDays))
    : null;

  return {
    metrics,
    cashflow: { ...cf, annualisedRoiPct },
    contribution: { perUnit: metrics.grossProfitUnit, total: metrics.grossProfitTotal },
  };
}

module.exports = {
  round2, round4,
  unitAcquisitionPrice,
  landedUnitCost,
  dealMetrics,
  discountOffRrpPct,
  convert,
  parseTermsDays,
  addDays,
  daysBetween,
  cashflow,
  computeDeal,
};
