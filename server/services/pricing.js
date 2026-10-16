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

  // Deal costs (§7): costs of getting the deal done, separate from landed cost.
  // Outbound delivery, commission, transaction fees, storage and financing are
  // either per-unit amounts or percentages of net revenue. Expected credit loss
  // is a percentage of net revenue. All optional and default to zero so a
  // buy/sell with no deal costs is unchanged.
  const outboundPerUnit = safe(input.outboundPerUnit);
  const storagePerUnit = safe(input.storagePerUnit);
  const financingPerUnit = safe(input.financingPerUnit);
  const commissionPct = safe(input.commissionPct);
  const transactionFeePct = safe(input.transactionFeePct);
  const expectedCreditLossPct = safe(input.expectedCreditLossPct);

  const dealCostUnit =
    outboundPerUnit + storagePerUnit + financingPerUnit +
    (netUnitRevenue * (commissionPct + transactionFeePct + expectedCreditLossPct)) / 100;
  const dealCostsTotal = dealCostUnit * qty;

  const contributionUnit = grossProfitUnit - dealCostUnit;
  const contributionTotal = contributionUnit * qty;
  const contributionMarginPct = revenueTotal > 0 ? (contributionTotal / revenueTotal) * 100 : 0;

  // Deployed capital = what we actually have tied up: cost of goods plus the
  // deal costs funded before the customer pays (§7, §9).
  const deployedCapital = costTotal + dealCostsTotal;
  const simpleReturnPct = round2(deployedCapital > 0 ? (contributionTotal / deployedCapital) * 100 : 0);

  const marginPct = netUnitRevenue > 0 ? (grossProfitUnit / netUnitRevenue) * 100 : 0;
  const markup = netUnitRevenue - landed;
  const markupPctOfCost = landed > 0 ? (grossProfitUnit / landed) * 100 : 0;
  const roiPct = landed > 0 ? (grossProfitUnit / landed) * 100 : 0;
  const daysToCash = safe(input.daysToCash, 30) || 30;
  const annualisedRoiPct = roiPct * (365 / daysToCash);
  const annualisedReturnPct = round2(simpleReturnPct * (365 / daysToCash));

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
    // Deal contribution (§7): gross profit less the costs of executing the deal.
    dealCostUnit: round4(dealCostUnit),
    dealCostsTotal: round2(dealCostsTotal),
    contributionUnit: round4(contributionUnit),
    contributionTotal: round2(contributionTotal),
    contributionMarginPct: round4(contributionMarginPct),
    deployedCapital: round2(deployedCapital),
    simpleReturnPct,
    annualisedReturnPct,
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

/* ======================= cost price -> selling price ======================= */

// Margin and markup at a given cost and price.
//   margin %  = (price - cost) / price   (what the platform's policy uses)
//   markup %  = (price - cost) / cost    (the "on the cost price" reading)
function marginFromPrices(cost, price) {
  const c = safe(cost);
  const p = safe(price);
  return {
    cost: round4(c),
    price: round4(p),
    marginPct: p > 0 ? round4(((p - c) / p) * 100) : 0,
    markup: round4(p - c),
    markupPctOfCost: c > 0 ? round4(((p - c) / c) * 100) : 0,
  };
}

// Selling price from a markup applied to the cost price:  SP = cost × (1 + m).
function sellingPriceFromMarkup(cost, markupPct) {
  return round4(safe(cost) * (1 + safe(markupPct) / 100));
}

// Selling price to achieve a target margin on the selling price:
//   SP = cost / (1 - margin%). Undefined at or above 100%.
function sellingPriceFromMargin(cost, marginPct) {
  const c = safe(cost);
  const m = safe(marginPct);
  if (m >= 100) return null;
  return round4(c / (1 - m / 100));
}

// Both conventions from one cost + target %, so a trader can use whichever
// reading they mean. Every option carries the resulting margin and markup so
// the difference between the two conventions is visible, never hidden.
function priceFromMargin(cost, marginPct) {
  const c = safe(cost);
  const m = safe(marginPct);
  const build = (basis, price) => {
    const valid = price != null && Number.isFinite(price) && price > 0;
    const marginPctOnSell = valid && price > 0 ? round4(((price - c) / price) * 100) : null;
    const markupPctOfCost = valid && c > 0 ? round4(((price - c) / c) * 100) : null;
    return {
      basis,
      sellingUnitPrice: valid ? round4(price) : null,
      marginPctOnSell,
      markupPctOfCost,
      markupPerUnit: valid ? round4(price - c) : null,
      valid,
      reason: valid ? null : (m >= 100 && basis === 'margin_on_selling' ? 'a margin on selling price must be below 100%' : 'cost required'),
    };
  };
  return {
    cost: round4(c),
    targetMarginPct: round4(m),
    markupOnCost: build('markup_on_cost', sellingPriceFromMarkup(c, m)),
    marginOnSelling: build('margin_on_selling', sellingPriceFromMargin(c, m)),
  };
}

// Effective margin (on selling price) of a price built on cost, and whether it
// clears the house policy. Used by the offer builder's guard rails.
function pricePolicy(cost, price, minMarginPct, minMarkup) {
  const c = safe(cost);
  const p = safe(price);
  const marginPct = p > 0 ? ((p - c) / p) * 100 : 0;
  const markup = p - c;
  return {
    marginPct: round4(marginPct),
    markup: round4(markup),
    passesPolicy: marginPct >= safe(minMarginPct, 0) - 1e-9 && markup >= safe(minMarkup, 0) - 1e-9,
  };
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
//
// Two §8 controls are modelled here rather than buried in the margin:
//   * Recoverable taxes (control 3) are paid on import and recovered later.
//     They are NOT cost, but they DO tie up cash while outstanding — so they
//     raise peak funding without touching margin.
//   * Deposits and advances (control 4) move cash to day 0: a supplier advance
//     or a customer deposit is real cash out/in on the order date.
function cashflow(input) {
  const totalCost = safe(input.totalCost);
  const totalRevenue = safe(input.totalRevenue);
  const supplierPayDays = safe(input.supplierPayDays, 0);
  const customerPayDays = safe(input.customerPayDays, 30);
  const leadTimeDays = safe(input.leadTimeDays, 0);
  const transitDays = safe(input.transitDays, 0);
  const orderDate = input.orderDate || new Date().toISOString().slice(0, 10);

  // Recoverable tax is cash out on receipt and cash back on collection.
  const recoverableTax = safe(input.recoverableTaxTotal);
  // Deposits / advances are a slice of the same totals, just paid earlier.
  const supplierAdvance = round2(totalCost * (safe(input.supplierAdvancePct) / 100));
  const customerDeposit = round2(totalRevenue * (safe(input.customerDepositPct) / 100));

  const goodsDays = leadTimeDays + transitDays;
  const supplierDue = addDays(orderDate, supplierPayDays);
  const goodsDate = addDays(orderDate, goodsDays);
  const customerDue = addDays(goodsDate, customerPayDays);

  const events = [
    { label: 'Order placed', date: orderDate, day: 0, amount: customerDeposit - supplierAdvance },
    { label: 'Pay supplier', date: supplierDue, day: supplierPayDays, amount: -(totalCost - supplierAdvance) },
    { label: 'Goods received', date: goodsDate, day: goodsDays, amount: -recoverableTax },
    { label: 'Customer pays', date: customerDue, day: goodsDays + customerPayDays, amount: totalRevenue - customerDeposit + recoverableTax },
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
    // Goods-only capital, i.e. what the peak would be with no recoverable tax
    // outstanding. The gap between the two is cash tied up purely in tax.
    peakCapitalExcludingTax: round2(Math.max(0, peakCapital - recoverableTax)),
    recoverableTax: round2(recoverableTax),
    supplierAdvance: round2(supplierAdvance),
    customerDeposit: round2(customerDeposit),
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
    outboundPerUnit: input.outboundPerUnit,
    storagePerUnit: input.storagePerUnit,
    financingPerUnit: input.financingPerUnit,
    commissionPct: input.commissionPct,
    transactionFeePct: input.transactionFeePct,
    expectedCreditLossPct: input.expectedCreditLossPct,
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
    recoverableTaxTotal: input.recoverableTaxTotal,
    supplierAdvancePct: input.supplierAdvancePct,
    customerDepositPct: input.customerDepositPct,
  });

  const annualisedRoiPct = cf.capitalDays > 0
    ? round4(metrics.roiPct * (365 / cf.capitalDays))
    : null;

  return {
    metrics,
    cashflow: { ...cf, annualisedRoiPct },
    contribution: {
      perUnit: metrics.contributionUnit,
      total: metrics.contributionTotal,
      marginPct: metrics.contributionMarginPct,
      dealCostsTotal: metrics.dealCostsTotal,
    },
    // Return on the capital actually deployed across the cash cycle (§7, §9).
    return: {
      deployedCapital: metrics.deployedCapital,
      simpleReturnPct: metrics.simpleReturnPct,
      annualisedReturnPct: cf.capitalDays > 0
        ? round2(metrics.simpleReturnPct * (365 / cf.capitalDays))
        : null,
      capitalDays: cf.capitalDays,
    },
    scenarios: scenarios(input),
  };
}

// Conservative / base / upside cases plus stress cases (price drop,
// customer default). Each case only shifts a few inputs so the manager can see
// how sensitive the deal's contribution is (§8.8, §4.5). Never presented as a
// forecast.
function scenarios(input) {
  const qty = safe(input.quantity, 1) || 1;
  const landed = safe(input.landedUnitCost);
  const sell = safe(input.sellingUnitPrice);
  const daysToCash = safe(input.daysToCash, 30) || 30;
  const base = { ...input, quantity: qty };
  const dropPct = safe(input.stressPriceDropPct, 10);
  const defaultPct = safe(input.stressCustomerDefaultPct, 100);

  const mk = (kind, label, description, overrides) => {
    const m = dealMetrics({ ...base, ...overrides });
    return {
      kind, label, description,
      marginPct: m.marginPct,
      contributionTotal: m.contributionTotal,
      contributionMarginPct: m.contributionMarginPct,
      revenueTotal: m.revenueTotal,
      passesPolicy: m.passesPolicy,
      survives: m.contributionTotal > 0,
    };
  };

  return [
    mk('base', 'Base', 'As quoted', {}),
    mk('conservative', 'Conservative', 'Selling price −4%, landed cost +5%, +30 days to cash',
      { sellingUnitPrice: sell * 0.96, landedUnitCost: landed * 1.05, daysToCash: daysToCash + 30 }),
    mk('upside', 'Upside', 'Selling price +3%, landed cost −2%, −15 days to cash',
      { sellingUnitPrice: sell * 1.03, landedUnitCost: landed * 0.98, daysToCash: Math.max(1, daysToCash - 15) }),
    mk('stress_price_drop', `Stress: price −${dropPct}%`, 'Customer only pays the current market price',
      { sellingUnitPrice: sell * (1 - dropPct / 100) }),
    mk('stress_default', 'Stress: customer default', 'No revenue recovered — full loss of landed capital',
      { sellingUnitPrice: sell * (1 - defaultPct / 100) }),
  ];
}

// ---- XIRR / dated cash-flow returns (brief section 8, control 7) ------------
//
// "use XIRR only where dated cash flows support it". These helpers are
// deliberately conservative: when the dates cannot support a money-weighted
// return they return null with a reason rather than a misleading number.

// Net present value of dated cash flows at an annual rate (ACT/365).
function npv(ratePct, flows) {
  const r = ratePct / 100;
  if (r <= -1) return null;
  const t0 = flows[0].t;
  return flows.reduce((sum, f) => sum + f.amount / Math.pow(1 + r, (f.t - t0) / 365), 0);
}

// Annualised money-weighted return for dated cash flows.
// flows: [{ date: 'YYYY-MM-DD', amount: number }]. Money out is negative.
// Returns null (with a reason) when the flows cannot support an XIRR.
function xirr(flows) {
  const clean = (flows || [])
    .map((f) => ({ date: f.date, amount: Number(f.amount) }))
    .filter((f) => f.date && Number.isFinite(f.amount) && f.amount !== 0);
  if (clean.length < 2) return { xirrPct: null, reason: 'need at least two dated cash flows' };

  const base = new Date(clean[0].date + 'T00:00:00Z').getTime();
  const dated = clean.map((f) => ({ ...f, t: Math.round((new Date(f.date + 'T00:00:00Z').getTime() - base) / 86400000) }));

  const pos = dated.some((f) => f.amount > 0);
  const neg = dated.some((f) => f.amount < 0);
  if (!pos || !neg) return { xirrPct: null, reason: 'need at least one inflow and one outflow' };

  if (dated.every((f) => f.t === 0)) {
    return { xirrPct: null, reason: 'all cash flows fall on the same day' };
  }

  // Bracket the root. Rates a trade can genuinely produce run from slightly
  // negative to many thousands of percent on a short capital cycle, so we
  // search a wide log-spaced range rather than a narrow one and only give up
  // when the NPV genuinely never changes sign.
  const factors = [];
  for (let e = -6; e <= 14; e++) factors.push(Math.pow(10, e / 2));   // 0.001 .. 1e7
  let lo = null;
  let hi = null;
  let npvLo = null;
  let npvHi = null;
  for (const f of factors) {
    if (f >= 1) { const v = npv((f - 1) * 100, dated); if (v != null && v <= 0) { hi = (f - 1) * 100; npvHi = v; break; } }
  }
  for (let i = factors.length - 1; i >= 0; i--) {
    const f = factors[i];
    if (f < 1) { const v = npv((f - 1) * 100, dated); if (v != null && v >= 0) { lo = (f - 1) * 100; npvLo = v; break; } }
  }
  if (lo == null) { lo = -99.9999; npvLo = npv(lo, dated); }
  if (hi == null) { hi = 1e9; npvHi = npv(hi, dated); }
  if (npvLo == null || npvHi == null || npvLo * npvHi > 0) {
    return { xirrPct: null, reason: 'no rate in a plausible range zeroes the NPV' };
  }

  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const npvMid = npv(mid, dated);
    if (npvMid == null) break;
    if (Math.abs(npvMid) < 1e-7) { lo = hi = mid; break; }
    if (npvLo * npvMid < 0) { hi = mid; npvHi = npvMid; } else { lo = mid; npvLo = npvMid; }
  }
  const rate = (lo + hi) / 2;
  return {
    xirrPct: round4(rate),
    npvAtRate: round4(npv(rate, dated) || 0),
    days: dated[dated.length - 1].t - dated[0].t,
    flows: dated.length,
  };
}

// Daily funding balance between the first and last dated movement. This is
// what actually tells you how long capital was tied up when there are several
// payments/receipts rather than one clean in and one clean out.
function dailyFunding(flows) {
  const clean = (flows || [])
    .map((f) => ({ date: f.date, amount: Number(f.amount) }))
    .filter((f) => f.date && Number.isFinite(f.amount));
  if (!clean.length) return { days: [], peakDeficit: 0, peakDeficitDay: null, daysFunded: 0 };

  clean.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const start = new Date(clean[0].date + 'T00:00:00Z');
  const end = new Date(clean[clean.length - 1].date + 'T00:00:00Z');
  const span = Math.round((end - start) / 86400000);

  const byDay = new Map();
  for (const f of clean) {
    const d = Math.round((new Date(f.date + 'T00:00:00Z') - start) / 86400000);
    byDay.set(d, round2((byDay.get(d) || 0) + f.amount));
  }

  let balance = 0;
  let peakDeficit = 0;
  let peakDeficitDay = null;
  let daysFunded = 0;
  const days = [];
  for (let d = 0; d <= span; d++) {
    balance = round2(balance + (byDay.get(d) || 0));
    if (balance < 0) daysFunded++;
    if (balance < peakDeficit) { peakDeficit = balance; peakDeficitDay = d; }
    days.push({ day: d, date: new Date(start.getTime() + d * 864e5).toISOString().slice(0, 10), balance, movement: byDay.get(d) || 0 });
  }
  return {
    days,
    spanDays: span,
    peakDeficit,
    peakDeficitDay,
    daysFunded,
    weightedDays: clean.reduce((s, f) => s + f.amount * Math.round((new Date(f.date + 'T00:00:00Z') - start) / 86400000), 0),
  };
}

module.exports = {
  round2, round4,
  unitAcquisitionPrice,
  landedUnitCost,
  dealMetrics,
  discountOffRrpPct,
  convert,
  priceFromMargin,
  sellingPriceFromMarkup,
  sellingPriceFromMargin,
  pricePolicy,
  parseTermsDays,
  addDays,
  daysBetween,
  cashflow,
  computeDeal,
  scenarios,
  xirr,
  npv,
  dailyFunding,
};
