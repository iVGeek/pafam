'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const pricing = require('../server/services/pricing');
const gtin = require('../src/lib/gtin');
const { parsePackSize } = require('../src/lib/pack');
const { parseNote } = require('../src/lib/notes');
const { computeLanded, selectTier } = require('../server/services/landing');
const incoterms = require('../src/lib/incoterms');
const trends = require('../server/services/trends');
const orders = require('../server/services/orders');
const { orderQuantityFor, roundUpTo } = require('../server/services/recommend');
const { consolidateDemands } = require('../server/services/purchasePlan');
const analytics = require('../server/services/analytics');
const { movingAverageForecast } = require('../server/services/forecast');

test('GTIN check digit validates real EAN-13', () => {
  assert.equal(gtin.analyse('4006714008789').valid, true);
  assert.equal(gtin.analyse('4006714008789').canonical14, '04006714008789');
  assert.equal(gtin.analyse('4006714008780').valid, false);
});

test('GTIN handles EAN-8 and UPC-A', () => {
  assert.equal(gtin.analyse('12345670').type, 'EAN-8');
  assert.equal(gtin.analyse('036000291452').type, 'UPC-A');
});

test('pack size parsing', () => {
  assert.equal(parsePackSize('CORONA BOT. 4*6 35,5CL'), 24);
  assert.equal(parsePackSize('Cerveza Corona Botella 6 Pack  0,355 Litros'), 6);
  assert.equal(parsePackSize('Whisky Old Parr 12 años 1,00 Litro'), null);
  assert.equal(parsePackSize('Strongbow 24 Uds 33cl'), 24);
});

test('pricing: 30% discount off 100, cost 49 -> 30% margin', () => {
  // brief section 9 style example
  const m = pricing.dealMetrics({
    landedUnitCost: 49, sellingUnitPrice: 100, discountPct: 30,
    quantity: 1, minMarginPct: 15, minMarkup: 0.75,
  });
  assert.equal(m.netUnitRevenue, 70);
  assert.equal(m.grossProfitUnit, 21);
  assert.equal(m.marginPct, 30);
  assert.equal(m.markup, 21);
  assert.equal(m.passesPolicy, true);
});

test('pricing: fails policy below 15% margin', () => {
  const m = pricing.dealMetrics({ landedUnitCost: 90, sellingUnitPrice: 100, quantity: 1, minMarginPct: 15, minMarkup: 0.75 });
  assert.equal(m.marginPct, 10);
  assert.equal(m.passesPolicy, false);
});

test('landed cost builds up duty and fees', () => {
  const l = pricing.landedUnitCost({ purchaseUnitPrice: 100, dutyPct: 10, freightPerUnit: 5, brokeragePerUnit: 2 });
  assert.equal(l.duty, 10);
  assert.equal(l.total, 117);
});

test('unit acquisition price normalises case and RRP', () => {
  const caseOffer = { price: 24, price_basis: 'case', price_type: 'cost', units_per_case: 24 };
  assert.equal(pricing.unitAcquisitionPrice(caseOffer).perBottle, 1);
  const rrpOffer = { price: 10, price_basis: 'unit', price_type: 'rrp', default_discount_pct: 40 };
  assert.equal(pricing.unitAcquisitionPrice(rrpOffer).perBottle, 6);
});

test('discount off RRP', () => {
  assert.equal(pricing.discountOffRrpPct(70, 100), 30);
});

test('note parser extracts quantity, price, barcode, intent', () => {
  const p = parseNote('Customer: Atlantic Spirits. Interested in 500 bottles of Jack Daniels, target 18.50 EUR. Barcode 5099873088333.');
  assert.equal(p.suggestedQuantity, 500);
  assert.equal(p.suggestedPrice, 18.5);
  assert.equal(p.suggestedCurrency, 'EUR');
  assert.ok(p.barcodes.includes('05099873088333'));
  assert.ok(p.intents.includes('interested'));
  assert.ok(/atlantic/i.test(p.customerHint || ''));
});

test('note parser handles Spanish and empty input', () => {
  const p = parseNote('Cliente Gulf Trading, presupuesto para 1000 unidades de Vodka Absolut, precio 9.90 USD.');
  assert.equal(p.suggestedQuantity, 1000);
  assert.equal(p.suggestedCurrency, 'USD');
  assert.equal(p.language, 'es');
  assert.deepEqual(parseNote('').intents, []);
});

test('incoterms: who pays freight/insurance/duty', () => {
  assert.deepEqual(incoterms.rules('EXW'), { freight: 'buyer', insurance: 'buyer', duty: 'buyer', label: 'Ex Works', code: 'EXW', known: true });
  assert.equal(incoterms.rules('CIF').freight, 'seller');
  assert.equal(incoterms.rules('CIF').insurance, 'seller');
  assert.equal(incoterms.rules('CIF').duty, 'buyer');
  assert.equal(incoterms.rules('ddp').duty, 'seller');
  assert.equal(incoterms.rules('').known, false);
});

test('selectTier picks the quantity break', () => {
  const tiers = [{ min: 1, max: 9, price: 10 }, { min: 10, price: 9 }];
  assert.equal(selectTier(tiers, 5, 99, 'unit').price, 10);
  assert.equal(selectTier(tiers, 10, 99, 'unit').price, 9);
  assert.equal(selectTier(tiers, 100, 99, 'unit').applied, true);
  assert.equal(selectTier(null, 5, 99, 'unit').price, 99);
});

test('landed cost: EXW buyer pays every component', () => {
  const offer = { id: 1, supplier_code: 'S', price: 10, price_basis: 'unit', price_type: 'cost', currency: 'EUR', incoterm: 'EXW' };
  const supplier = { freight_per_unit: 0.5, insurance_pct: 2, duty_pct: 5, brokerage_per_unit: 0.1, handling_per_unit: 0.05, other_tax_pct: 0 };
  const r = computeLanded(offer, supplier, { quantity: 1, destination: 'US', baseCurrency: 'USD', fxRate: 1.1, settings: {} });
  assert.equal(r.purchaseUSD, 11);
  assert.equal(r.components.freight.value, 0.5);
  assert.equal(r.components.insurance.value, 0.22);
  assert.equal(r.components.duty.value, 0.55);
  assert.equal(r.landedUnitCost, 12.42);
  assert.equal(r.complete, true);
  assert.equal(r.executable, true);
});

test('landed cost: CIF/DDP already include seller-paid legs', () => {
  const offer = { id: 2, supplier_code: 'S', price: 10, price_basis: 'unit', price_type: 'cost', currency: 'EUR', incoterm: 'CIF' };
  const supplier = { freight_per_unit: 0.5, insurance_pct: 2, duty_pct: 5, brokerage_per_unit: 0.1, handling_per_unit: 0.05 };
  const cif = computeLanded(offer, supplier, { quantity: 1, baseCurrency: 'USD', fxRate: 1.1, settings: {} });
  assert.equal(cif.components.freight.source, 'included');
  assert.equal(cif.components.insurance.source, 'included');
  assert.equal(cif.components.duty.value, 0.55);
  assert.equal(cif.landedUnitCost, 11.7);

  const ddp = computeLanded({ ...offer, incoterm: 'DDP' }, supplier, { quantity: 1, baseCurrency: 'USD', fxRate: 1.1, settings: {} });
  assert.equal(ddp.components.duty.source, 'included');
  assert.equal(ddp.landedUnitCost, 11.15);
});

test('landed cost: missing inputs are flagged, never a false zero', () => {
  const offer = { id: 3, supplier_code: 'S', price: 10, price_basis: 'unit', price_type: 'cost', currency: 'EUR', incoterm: 'EXW' };
  const r = computeLanded(offer, {}, { quantity: 1, baseCurrency: 'USD', fxRate: 1, settings: {} });
  assert.equal(r.complete, false);
  assert.ok(r.missing.includes('freight'));
  assert.ok(r.flags.includes('incomplete-cost'));
  assert.equal(r.executable, true);
});

test('landed cost: case basis + RRP discount normalise per bottle', () => {
  const offer = { id: 4, supplier_code: 'S', price: 24, price_basis: 'case', units_per_case: 24, price_type: 'rrp', currency: 'EUR', incoterm: 'DDP' };
  const r = computeLanded(offer, { default_discount_pct: 40 }, { quantity: 1, baseCurrency: 'USD', fxRate: 1, settings: {} });
  assert.equal(r.acquisitionPerBottle, 0.6);
  assert.equal(r.purchaseUSD, 0.6);
});

test('landed cost: MOQ excludes a too-small order', () => {
  const offer = { id: 5, supplier_code: 'S', price: 10, price_basis: 'unit', price_type: 'cost', currency: 'USD', incoterm: 'DDP', moq: 12 };
  const r = computeLanded(offer, {}, { quantity: 5, baseCurrency: 'USD', fxRate: 1, settings: {} });
  assert.equal(r.moqOk, false);
  assert.equal(r.executable, false);
  assert.ok(r.flags.includes('below-moq'));
});

test('parse payment terms to days', () => {
  assert.equal(pricing.parseTermsDays('Net 30'), 30);
  assert.equal(pricing.parseTermsDays('Net 45'), 45);
  assert.equal(pricing.parseTermsDays('2/10 Net 30'), 30);
  assert.equal(pricing.parseTermsDays('14 days'), 14);
  assert.equal(pricing.parseTermsDays('Prepay'), 0);
  assert.equal(pricing.parseTermsDays('COD'), 0);
  assert.equal(pricing.parseTermsDays('Letter of Credit'), 0);
  assert.equal(pricing.parseTermsDays(null, 30), 30);
});

test('cashflow: peak capital, capital days and schedule', () => {
  const cf = pricing.cashflow({
    totalCost: 1000, totalRevenue: 1400,
    supplierPayDays: 0, customerPayDays: 30, leadTimeDays: 0, transitDays: 0, orderDate: '2026-01-01',
  });
  assert.equal(cf.supplierDue, '2026-01-01');
  assert.equal(cf.customerDue, '2026-01-31');
  assert.equal(cf.capitalDays, 30);
  assert.equal(cf.peakCapital, 1000);
  assert.equal(cf.negativeWorkingCapital, false);
  assert.equal(cf.schedule[cf.schedule.length - 1].balance, 400);
});

test('cashflow: negative working capital when supplier terms exceed customer terms', () => {
  const cf = pricing.cashflow({
    totalCost: 1000, totalRevenue: 1400,
    supplierPayDays: 60, customerPayDays: 30, orderDate: '2026-01-01',
  });
  assert.equal(cf.capitalDays, -30);
  assert.equal(cf.negativeWorkingCapital, true);
  assert.equal(cf.peakCapital, 0);
});

test('computeDeal: contribution, ROI, annualised and policy', () => {
  const d = pricing.computeDeal({
    quantity: 100, landedUnitCost: 10, sellingUnitPrice: 20,
    supplierPayDays: 0, customerPayDays: 30, orderDate: '2026-01-01',
    minMarginPct: 15, minMarkup: 0.75,
  });
  assert.equal(d.metrics.marginPct, 50);
  assert.equal(d.metrics.roiPct, 100);
  assert.equal(d.contribution.total, 1000);
  assert.equal(d.metrics.passesPolicy, true);
  assert.equal(d.cashflow.peakCapital, 1000);
  assert.equal(d.cashflow.capitalDays, 30);
  assert.equal(d.cashflow.annualisedRoiPct, pricing.round4(100 * (365 / 30)));
});

test('trend: latest vs previous observation and direction', () => {
  const rows = [
    { upload_id: 1, observed_at: '2026-01-01', unit_cost_base: 10 },
    { upload_id: 2, observed_at: '2026-02-01', unit_cost_base: 11 },
  ];
  const t = trends.computeTrend(rows);
  assert.equal(t.latest.unitCostBase, 11);
  assert.equal(t.previous.unitCostBase, 10);
  assert.equal(t.change, 1);
  assert.equal(t.changePct, 10);
  assert.equal(t.direction, 'up');
  assert.equal(t.observations, 2);
});

test('trend: duplicate barcodes within one list collapse to a single point', () => {
  const rows = [
    { id: 1, upload_id: 7, observed_at: '2026-01-01', unit_cost_base: 6.02 },
    { id: 2, upload_id: 7, observed_at: '2026-01-01', unit_cost_base: 26.01 },
    { id: 3, upload_id: 8, observed_at: '2026-02-01', unit_cost_base: 6.5 },
  ];
  const t = trends.computeTrend(rows);
  assert.equal(t.observations, 2);
  assert.equal(t.previous.unitCostBase, 26.01);
  assert.equal(t.latest.unitCostBase, 6.5);
  assert.equal(t.direction, 'down');
});

test('trend: single observation has no change', () => {
  const t = trends.computeTrend([{ upload_id: 1, unit_cost_base: 10 }]);
  assert.equal(t.change, null);
  assert.equal(t.changePct, null);
  assert.equal(t.direction, 'none');
  assert.equal(t.observations, 1);
});

test('severity bands scale with the alert threshold', () => {
  assert.equal(trends.severityForChange(3, 10), 'info');
  assert.equal(trends.severityForChange(-12, 10), 'warning');
  assert.equal(trends.severityForChange(30, 10), 'critical');
});

test('realise: fully paid order matches forecast margin', () => {
  const order = { quantity: 200, unit_cost: 8.5, unit_price: 12.5 };
  const payments = [
    { direction: 'outbound', amount: 1700 },
    { direction: 'inbound', amount: 2500 },
  ];
  const r = orders.realise(order, payments);
  assert.equal(r.forecastMargin, 800);
  assert.equal(r.realisedMargin, 800);
  assert.equal(r.settled, true);
  assert.equal(r.marginVariance, 0);
});

test('realise: partial payments leave outstanding balances', () => {
  const order = { quantity: 100, unit_cost: 10, unit_price: 15 };
  const payments = [
    { direction: 'outbound', amount: 1000 },
    { direction: 'inbound', amount: 600 },
  ];
  const r = orders.realise(order, payments);
  assert.equal(r.forecastMargin, 500);
  assert.equal(r.settled, false);
  assert.equal(r.revenueOutstanding, 900);
  assert.equal(r.costOutstanding, 0);
  assert.equal(r.marginVariance, null);
});

test('realise: no payments yields zero realised and full outstanding', () => {
  const r = orders.realise({ quantity: 50, unit_cost: 6, unit_price: 9 }, []);
  assert.equal(r.realisedMargin, 0);
  assert.equal(r.paidIn, 0);
  assert.equal(r.paidOut, 0);
  assert.equal(r.costOutstanding, 300);
  assert.equal(r.revenueOutstanding, 450);
  assert.equal(r.settled, false);
});

test('realise: overpayment shows positive margin variance once settled', () => {
  const order = { quantity: 10, unit_cost: 5, unit_price: 10 };
  const payments = [
    { direction: 'outbound', amount: 55 },
    { direction: 'inbound', amount: 130 },
  ];
  const r = orders.realise(order, payments);
  assert.equal(r.settled, true);
  assert.equal(r.realisedMargin, 75);
  assert.equal(r.marginVariance, 25);
});

test('scenarios: base, conservative, upside and stress cases', () => {
  const s = pricing.scenarios({
    quantity: 1000, landedUnitCost: 33, sellingUnitPrice: 40,
    minMarginPct: 15, minMarkup: 0.75, daysToCash: 90,
  });
  const kinds = s.map((x) => x.kind);
  assert.deepEqual(kinds, ['base', 'conservative', 'upside', 'stress_price_drop', 'stress_default']);

  const base = s.find((x) => x.kind === 'base');
  assert.equal(base.contributionTotal, 7000);

  const cons = s.find((x) => x.kind === 'conservative');
  const up = s.find((x) => x.kind === 'upside');
  assert.ok(cons.contributionTotal < base.contributionTotal);
  assert.ok(up.contributionTotal > base.contributionTotal);

  const def = s.find((x) => x.kind === 'stress_default');
  assert.equal(def.contributionTotal, -33000);
  assert.equal(def.survives, false);
});

test('scenarios: a thin deal can fail policy in the conservative case', () => {
  const s = pricing.scenarios({ quantity: 1000, landedUnitCost: 33, sellingUnitPrice: 40, minMarginPct: 15, minMarkup: 0.75 });
  const base = s.find((x) => x.kind === 'base');
  const cons = s.find((x) => x.kind === 'conservative');
  assert.equal(base.passesPolicy, true);
  assert.equal(cons.passesPolicy, false);
});

test('windowChange: measures over the window and reports gaps as no data', () => {
  const points = [
    { observedAt: '2026-01-01T00:00:00', unitCostBase: 10 },
    { observedAt: '2026-03-01T00:00:00', unitCostBase: 12 },
    { observedAt: '2026-04-01T00:00:00', unitCostBase: 15 },
  ];
  const d30 = trends.windowChange(points, 30);
  assert.ok(d30);
  assert.equal(d30.fromValue, 12);
  assert.equal(d30.toValue, 15);
  assert.equal(d30.changePct, 25);
  const recent = [
    { observedAt: '2026-03-25T00:00:00', unitCostBase: 14 },
    { observedAt: '2026-04-01T00:00:00', unitCostBase: 15 },
  ];
  assert.equal(trends.windowChange(recent, 30), null);
  assert.equal(trends.windowChange([points[0]], 30), null);
});

test('orderQuantityFor rounds demand up to MOQ then a whole order multiple', () => {
  assert.equal(roundUpTo(100, 12), 108);
  assert.equal(roundUpTo(120, 12), 120);
  assert.equal(roundUpTo(1, 6), 6);
  // Below MOQ: lift to MOQ, then the next whole multiple of it.
  assert.equal(orderQuantityFor({ moq: 24, order_multiple: 12 }, 10), 24);
  assert.equal(orderQuantityFor({ moq: 24, order_multiple: 12 }, 30), 36);
  assert.equal(orderQuantityFor({ moq: 12, order_multiple: 6 }, 300), 300);
  // No multiples configured: just satisfy the demand.
  assert.equal(orderQuantityFor({ moq: null, order_multiple: null }, 7), 7);
  assert.equal(orderQuantityFor(null, 5), 5);
});

test('purchasePlan consolidates demands per product and aggregates totals', () => {
  const plan = consolidateDemands({});
  assert.ok(Array.isArray(plan.items));
  assert.ok(plan.items.length >= 1);
  assert.ok(plan.totals && typeof plan.totals.count === 'number');
  assert.ok('actionable' in plan.totals && 'capital' in plan.totals && 'contribution' in plan.totals);
  const withCustomers = plan.items.find((i) => i.customers && i.customers.length);
  assert.ok(withCustomers);
  assert.ok(withCustomers.demandQty >= withCustomers.orderQty); // rounded up, never below
});

test('KPI suite reports profitability, cash, stock and buying blocks', () => {
  const k = analytics.kpis({});
  for (const block of ['summary', 'cash', 'stock', 'buying', 'quality']) {
    assert.ok(k[block] && typeof k[block] === 'object', `missing ${block}`);
  }
  assert.equal(k.summary.grossProfit, k.summary.revenue - k.summary.costPaid);
  assert.ok(k.cash.capitalLimit > 0);
  assert.equal(typeof k.quality.openExceptions, 'number');
});

test('reconciles the brief section 9 worked example', () => {
  // §9: buy 1,000 @ $30 (landed $33), sell @ $40, deal costs $2,000,
  // 90-day capital cycle. Every figure below is the acceptance target.
  const d = pricing.computeDeal({
    quantity: 1000, landedUnitCost: 33, sellingUnitPrice: 40,
    outboundPerUnit: 2,
    supplierPayDays: 0, customerPayDays: 90, orderDate: '2026-01-01',
    minMarginPct: 15, minMarkup: 0.75,
  });
  assert.equal(d.metrics.landedUnitCost, 33);
  assert.equal(d.metrics.grossProfitTotal, 7000);
  assert.equal(d.metrics.marginPct, 17.5);
  assert.equal(d.metrics.dealCostsTotal, 2000);
  assert.equal(d.contribution.total, 5000);
  assert.equal(d.metrics.contributionMarginPct, 12.5);
  assert.equal(d.return.deployedCapital, 35000);
  assert.equal(d.return.simpleReturnPct, 14.29);
  assert.equal(d.return.capitalDays, 90);
  assert.equal(d.return.annualisedReturnPct, 57.95);
});

test('deal contribution subtracts deal costs from gross profit', () => {
  const noCosts = pricing.dealMetrics({ quantity: 100, landedUnitCost: 10, sellingUnitPrice: 20 });
  assert.equal(noCosts.contributionTotal, 1000);
  assert.equal(noCosts.dealCostsTotal, 0);

  const withCosts = pricing.dealMetrics({
    quantity: 100, landedUnitCost: 10, sellingUnitPrice: 20,
    outboundPerUnit: 1.5, commissionPct: 5,
  });
  assert.equal(withCosts.grossProfitTotal, 1000);
  assert.equal(withCosts.dealCostsTotal, 250); // 1.5/unit + 5% of 20/unit = 2.5/unit
  assert.equal(withCosts.contributionTotal, 750);
  assert.equal(withCosts.contributionMarginPct, 37.5);
  assert.equal(withCosts.deployedCapital, 1250);
});

test('forecast baseline refuses to extrapolate thin history', () => {
  const enough = movingAverageForecast([80, 95, 110, 90, 120, 105]);
  assert.equal(enough.sufficient, true);
  assert.equal(enough.months, 6);
  assert.equal(enough.avgPerMonth, 100);
  assert.equal(enough.forecastQty30d, 100);
  assert.equal(enough.confidence, 'medium');

  const thin = movingAverageForecast([80, 95]);
  assert.equal(thin.sufficient, false);
  assert.equal(thin.forecastQty30d, 0);
  assert.equal(thin.confidence, 'insufficient');
  assert.match(thin.reason, /need >= 5/);

  assert.equal(movingAverageForecast([]).sufficient, false);
});
