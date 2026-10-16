'use strict';
// Tests run against a throwaway database so they never touch the dev DB
// (and never leave stray rows behind). Must be set before requiring the db.
//
// The DB-backed tests need realistic offers/products, which means running the
// real import of the sample Excel files (~45s). We therefore seed once and
// snapshot the result; later runs copy the snapshot instead of re-importing.
// Delete the snapshot (or set PTP_TEST_NO_CACHE=1) to force a fresh seed.
const os = require('os');
const path = require('path');
const fs = require('fs');
const TMP_DB = path.join(os.tmpdir(), `ptp-test-${process.pid}.db`);
const SNAP = path.join(os.tmpdir(), 'ptp-test-fixture.db');
const useCache = process.env.PTP_TEST_NO_CACHE !== '1' && fs.existsSync(SNAP);

process.env.PTP_DATA_DIR = path.dirname(TMP_DB);
process.env.PTP_DB = TMP_DB;
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch (e) { /* ignore */ }
  }
});

const { test } = require('node:test');

// Restore the cached fixture BEFORE anything opens the database. Requiring
// server/db first would create an empty file and SQLite would then be reading
// through a handle that no longer matches what we copied in.
if (useCache) {
  fs.copyFileSync(SNAP, TMP_DB);
}
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
const reservations = require('../server/services/reservations');
const tasks = require('../server/services/tasks');
const shipments = require('../server/services/shipments');
const sourcing = require('../server/services/sourcing');
const demands = require('../server/services/demands');
const template = require('../server/services/template');
const listdiff = require('../server/services/listdiff');
const placements = require('../server/services/placements');
const pfi = require('../server/services/pfi');
const XLSX = require('xlsx');

// No cached fixture: run the real import pipeline so the DB-backed tests
// (purchase plan, KPIs, approvals, GL, shipments) see realistic data, then
// snapshot it for next time.
if (!useCache) {
  require('../server/seedData').seedData({ log: () => {} });
  if (process.env.PTP_TEST_NO_CACHE !== '1') {
    try {
      // Flush the WAL into the main file first, otherwise the snapshot is
      // missing everything still sitting in the log.
      require('../server/db').db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      fs.copyFileSync(TMP_DB, SNAP);
      for (const suffix of ['-wal', '-shm']) { try { fs.unlinkSync(SNAP + suffix); } catch (e) { /* ignore */ } }
    } catch (e) { /* no snapshot just means we re-seed next time */ }
  }
}

const { db } = require('../server/db');

// Creates a throwaway inventory lot for reservation tests so they do not
// depend on whatever demo data the seeded database happens to contain.
function seedLot({ onHand = 0, quarantined = 0, inTransit = 0 } = {}) {
  const product = db.prepare('SELECT id FROM products ORDER BY id LIMIT 1').get();
  const info = db.prepare(
    `INSERT INTO inventory_lots(product_id, supplier_code, warehouse, lot_reference, on_hand, quarantined, in_transit, unit_cost, currency)
     VALUES(?, 'TEST', 'TEST', 'LOT-' || ?, ?, ?, ?, 1, 'USD')`
  ).run(product ? product.id : 1, 'RES-TEST', onHand, quarantined, inTransit);
  return Number(info.lastInsertRowid);
}

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
  assert.equal(parsePackSize('CHANEL N°5 EDT 4*6 100ML'), 24);
  assert.equal(parsePackSize('Bleu de Chanel Eau de Parfum 6 Pack 100 ml'), 6);
  assert.equal(parsePackSize('Coco Mademoiselle Eau de Parfum 100 ml'), null);
  assert.equal(parsePackSize('PACO RABANNE 1 MILLION 24 Uds 100ml'), 24);
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

test('offer builder: selling price from both margin conventions', () => {
  // cost 100, target 20%.
  //   markup on cost   -> 100 * 1.20 = 120  (margin then 16.67%)
  //   margin on selling -> 100 / 0.80 = 125 (margin 20%)
  const o = pricing.priceFromMargin(100, 20);
  assert.equal(o.markupOnCost.sellingUnitPrice, 120);
  assert.equal(o.markupOnCost.marginPctOnSell, 16.6667);
  assert.equal(o.marginOnSelling.sellingUnitPrice, 125);
  assert.equal(o.marginOnSelling.marginPctOnSell, 20);
  assert.equal(o.marginOnSelling.markupPerUnit, 25);
});

test('selling price helpers agree with their definitions', () => {
  assert.equal(pricing.sellingPriceFromMarkup(80, 25), 100);
  assert.equal(pricing.sellingPriceFromMargin(80, 20), 100);
  assert.equal(pricing.sellingPriceFromMargin(80, 100), null);
});

test('price policy flags a below-minimum margin', () => {
  const good = pricing.pricePolicy(100, 125, 15, 0.75);
  assert.equal(good.marginPct, 20);
  assert.equal(good.passesPolicy, true);
  const thin = pricing.pricePolicy(100, 105, 15, 0.75);
  assert.equal(thin.passesPolicy, false);
});

test('list diff: matches by barcode and reports add/remove/price/quantity', () => {
  const ean = (base12) => base12 + String(gtin.checkDigit(base12));
  const mk = (rows) => {
    const aoa = [['EAN', 'Description', 'Precio', 'Stock'], ...rows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Lista');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  };
  const b1 = ean('509987308833');
  const b2 = ean('509987308834');
  const b3 = ean('509987308835');
  const b4 = ean('509987308836');
  const a = listdiff.parseList(mk([
    [b1, 'Chanel N°5 EDP 100ml', '120,00', '50'],
    [b2, 'Dior Sauvage EDT 100ml', '90.50', '20'],
    [b3, 'Bleu de Chanel', '80', '10'],
  ]));
  const b = listdiff.parseList(mk([
    [b1, 'Chanel N°5 EDP 100ml', '132,00', '40'],
    [b2, 'Dior Sauvage EDT 100ml', '90.50', '20'],
    [b4, 'Acqua di Gio', '75', '30'],
  ]));
  assert.equal(a.columns.barcode, 0);
  assert.equal(a.columns.price, 2);
  assert.equal(a.rows.length, 3);
  const d = listdiff.diffLists(a, b);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].description, 'Acqua di Gio');
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].description, 'Bleu de Chanel');
  assert.equal(d.priceChanges.length, 1);
  assert.equal(d.priceChanges[0].from, 120);
  assert.equal(d.priceChanges[0].to, 132);
  assert.equal(d.priceChanges[0].pct, 10);
  assert.equal(d.quantityChanges.length, 1);
  assert.equal(d.quantityChanges[0].diff, -10);
  assert.equal(d.summary.priceUp, 1);
});

test('list diff: falls back to description when the barcode is unusable', () => {
  assert.equal(listdiff.toNum('1.234,50'), 1234.5);
  assert.equal(listdiff.toNum('1,234.50'), 1234.5);
  assert.equal(listdiff.toNum('12,5'), 12.5);
});


test('note parser extracts quantity, price, barcode, intent', () => {
  const p = parseNote('Customer: Atlantic Beauty. Interested in 500 bottles of Bleu de Chanel Eau de Parfum, target 18.50 EUR. Barcode 5099873088333.');
  assert.equal(p.suggestedQuantity, 500);
  assert.equal(p.suggestedPrice, 18.5);
  assert.equal(p.suggestedCurrency, 'EUR');
  assert.ok(p.barcodes.includes('05099873088333'));
  assert.ok(p.intents.includes('interested'));
  assert.ok(/atlantic/i.test(p.customerHint || ''));
});

test('note parser handles Spanish and empty input', () => {
  const p = parseNote('Cliente Gulf Trading, presupuesto para 1000 unidades de Dior Sauvage Eau de Parfum, precio 9.90 USD.');
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

test('reservations: usable stock excludes quarantined stock', () => {
  const lot = { on_hand: 100, quarantined: 10, in_transit: 500 };
  assert.equal(reservations.usableStock(lot), 90);
});

test('reservations: cannot reserve more than usable stock (section 20)', () => {
  const lotId = seedLot({ onHand: 100, quarantined: 10 });

  // 90 usable, not 100 and not 110.
  assert.equal(reservations.availableToSell(lotId), 90);

  const tooBig = reservations.reserve({ lotId, quantity: 95 });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error, /oversell/);
  assert.equal(tooBig.available, 90);

  const exact = reservations.reserve({ lotId, quantity: 90 });
  assert.equal(exact.ok, true);
  assert.equal(reservations.availableToSell(lotId), 0);

  // Second reservation cannot oversell what is left.
  const second = reservations.reserve({ lotId, quantity: 1 });
  assert.equal(second.ok, false);
  assert.match(second.error, /no stock available/);
});

test('reservations: partial reservations accumulate and release frees stock', () => {
  const lotId = seedLot({ onHand: 50 });
  const a = reservations.reserve({ lotId, quantity: 20 });
  const b = reservations.reserve({ lotId, quantity: 15 });
  assert.ok(a.ok && b.ok);
  assert.equal(reservations.reservedFor(lotId), 35);
  assert.equal(reservations.availableToSell(lotId), 15);

  // Releasing frees the stock again.
  const rel = reservations.release(a.id);
  assert.equal(rel.ok, true);
  assert.equal(reservations.reservedFor(lotId), 15);
  assert.equal(reservations.availableToSell(lotId), 35);

  // Releasing twice is refused rather than double-counting.
  assert.equal(reservations.release(a.id).ok, false);
});

test('reservations: fulfilling consumes stock and reserved together', () => {
  const lotId = seedLot({ onHand: 40 });
  const r = reservations.reserve({ lotId, quantity: 25 });
  assert.ok(r.ok);
  const f = reservations.fulfil(r.id);
  assert.equal(f.ok, true);
  const lot = db.prepare('SELECT on_hand, reserved FROM inventory_lots WHERE id = ?').get(lotId);
  assert.equal(lot.on_hand, 15);   // stock physically left
  assert.equal(lot.reserved, 0);   // and is no longer held
  assert.equal(reservations.availableToSell(lotId), 15);
});

test('reservations: in-transit stock is not available to sell', () => {
  const lotId = seedLot({ onHand: 0, inTransit: 500 });
  assert.equal(reservations.availableToSell(lotId), 0);
  assert.equal(reservations.reserve({ lotId, quantity: 1 }).ok, false);
});

test('xirr: annualises dated cash flows and declines when unsupported', () => {
  // -1000 today, +1100 in 364 days -> ~10.03% annualised.
  const r = pricing.xirr([
    { date: '2026-01-01', amount: -1000 },
    { date: '2026-12-31', amount: 1100 },
  ]);
  assert.ok(r.xirrPct > 10 && r.xirrPct < 10.1, `got ${r.xirrPct}`);
  assert.equal(r.days, 364);
  assert.equal(r.flows, 2);

  // Several receipts: money-weighted, not the same as a simple average.
  const multi = pricing.xirr([
    { date: '2026-01-01', amount: -1200 },
    { date: '2026-04-01', amount: 400 },
    { date: '2026-07-01', amount: 400 },
    { date: '2026-10-01', amount: 500 },
  ]);
  assert.ok(multi.xirrPct > 0 && Number.isFinite(multi.xirrPct));
  assert.equal(multi.flows, 4);

  // Honest refusals rather than a meaningless number.
  assert.equal(pricing.xirr([]).xirrPct, null);
  assert.equal(pricing.xirr([{ date: '2026-01-01', amount: -1000 }]).xirrPct, null);
  const sameDay = pricing.xirr([
    { date: '2026-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 1100 },
  ]);
  assert.equal(sameDay.xirrPct, null);
  assert.match(sameDay.reason, /same day/);
  const noInflow = pricing.xirr([
    { date: '2026-01-01', amount: -1000 },
    { date: '2026-02-01', amount: -100 },
  ]);
  assert.equal(noInflow.xirrPct, null);
  assert.match(noInflow.reason, /inflow and one outflow/);
});

test('daily funding tracks the peak deficit across dated movements', () => {
  const f = pricing.dailyFunding([
    { date: '2026-01-01', amount: -1000 },
    { date: '2026-01-11', amount: -200 },
    { date: '2026-02-01', amount: 1400 },
  ]);
  assert.equal(f.spanDays, 31);
  assert.equal(f.peakDeficit, -1200);
  assert.equal(f.daysFunded, 31);
  assert.ok(f.days.length >= 32);

  const clean = pricing.dailyFunding([
    { date: '2026-01-01', amount: -500 },
    { date: '2026-01-11', amount: 550 },
  ]);
  assert.equal(clean.peakDeficit, -500);
  assert.equal(clean.daysFunded, 10);
});

test('realise: reports XIRR only when dated payments support it', () => {
  const order = { quantity: 100, unit_cost: 10, unit_price: 13 };
  const dated = orders.realise(order, [
    { direction: 'outbound', amount: 1000, paid_date: '2026-01-01' },
    { direction: 'inbound', amount: 1300, paid_date: '2027-01-01' },
  ]);
  assert.ok(dated.xirrPct > 25 && dated.xirrPct < 35, `got ${dated.xirrPct}`);
  assert.equal(dated.xirrReason, null);
  assert.equal(dated.datedPayments, 2);

  // Undated payments: we say so rather than inventing a return.
  const undated = orders.realise(order, [
    { direction: 'outbound', amount: 1000 },
    { direction: 'inbound', amount: 1300 },
  ]);
  assert.equal(undated.xirrPct, null);
  assert.ok(undated.xirrReason);
});

test('demand revisions create a new version and never edit the old one', () => {
  const cust = db.prepare('SELECT id FROM customers LIMIT 1').get().id;
  const prod = db.prepare('SELECT id FROM products LIMIT 1').get().id;
  const mk = (qty, notes) => Number(db.prepare(
    "INSERT INTO demands(customer_id, product_id, status, quantity, target_price, currency, source, notes) VALUES(?,?,'open',?,12.0,'USD','manual',?)"
  ).run(cust, prod, qty, notes).lastInsertRowid);

  const v1 = mk(100, 'original');
  const v2 = demands.revise(v1, { quantity: 250, notes: 'customer confirmed 250' }, 'buyer');
  assert.equal(v2.ok, true);
  assert.equal(v2.supersedes, v1);

  // The original row is intact, just retired — not overwritten.
  const original = demands.get(v1);
  assert.equal(original.quantity, 100, 'the original quantity must survive');
  assert.equal(original.notes, 'original');
  assert.equal(original.status, 'superseded');
  assert.equal(original.superseded_by_demand_id, v2.id);

  const v3 = demands.revise(v2.id, { quantity: 300, target_price: 11.5 }, 'buyer');
  assert.equal(v3.supersedes, v2.id);

  const chain = demands.history(v3.id);
  assert.deepEqual(chain.map((v) => v.id), [v1, v2.id, v3.id]);
  assert.equal(chain[0].quantity, 100);
  assert.equal(chain[2].quantity, 300);
  assert.equal(chain[2].current, true);
  // Traversable from any version in the chain.
  assert.deepEqual(demands.history(v1).map((v) => v.id), [v1, v2.id, v3.id]);
});

test('a demand already on an order cannot be silently rewritten (15)', () => {
  const cust = db.prepare('SELECT id FROM customers LIMIT 1').get().id;
  const prod = db.prepare('SELECT id FROM products LIMIT 1').get().id;
  const id = Number(db.prepare(
    "INSERT INTO demands(customer_id, product_id, status, quantity, target_price, currency, source) VALUES(?,?,'open',50,12.0,'USD','manual')"
  ).run(cust, prod).lastInsertRowid);
  db.prepare(
    "INSERT INTO orders(ref, demand_id, customer_id, product_id, quantity, status, order_date) VALUES(?,?,?,?,?,'closed',?)"
  ).run('ORD-HIST-TEST', id, cust, prod, 50, '2026-01-01');

  const r = demands.revise(id, { quantity: 999 }, 'buyer');
  assert.equal(r.ok, undefined);
  assert.equal(r.locked, true);
  assert.match(r.error, /already on order/);
  // And the confirmed quantity is untouched.
  assert.equal(demands.get(id).quantity, 50);

  // Unknown fields and missing rows are refused cleanly. (The order lock is
  // checked first, so these use a fresh, unlocked demand.)
  const fresh = Number(db.prepare(
    "INSERT INTO demands(customer_id, product_id, status, quantity, target_price, currency, source) VALUES(?,?,'open',10,12.0,'USD','manual')"
  ).run(cust, prod).lastInsertRowid);
  assert.match(demands.revise(fresh, { customer_id: 99 }, 'buyer').error, /cannot revise/);
  assert.equal(demands.revise(999999, { quantity: 1 }, 'buyer').notFound, true);
});

test('recoverable tax ties up cash but never touches cost or margin (8.3)', () => {
  const base = {
    quantity: 100, landedUnitCost: 10, sellingUnitPrice: 20,
    supplierPayDays: 0, customerPayDays: 30, orderDate: '2026-01-01',
  };
  const plain = pricing.computeDeal(base);
  const taxed = pricing.computeDeal({ ...base, recoverableTaxTotal: 210 });

  // It is cash, not cost.
  assert.equal(taxed.metrics.landedUnitCost, plain.metrics.landedUnitCost);
  assert.equal(taxed.metrics.costTotal, plain.metrics.costTotal);
  assert.equal(taxed.metrics.marginPct, plain.metrics.marginPct);
  assert.equal(taxed.contribution.total, plain.contribution.total);

  // But it does consume funding while outstanding.
  assert.equal(taxed.cashflow.recoverableTax, 210);
  assert.equal(taxed.cashflow.peakCapital, plain.cashflow.peakCapital + 210);
  assert.equal(taxed.cashflow.peakCapitalExcludingTax, plain.cashflow.peakCapital);

  // And it nets out of the cash cycle rather than being lost.
  const net = taxed.cashflow.schedule.reduce((s, e) => s + e.amount, 0);
  assert.equal(Math.round(net * 100) / 100, plain.cashflow.schedule.reduce((s, e) => s + e.amount, 0));
});

test('deposits and advances move cash to the order date (8.4)', () => {
  const base = {
    quantity: 100, landedUnitCost: 10, sellingUnitPrice: 20,
    supplierPayDays: 0, customerPayDays: 30, orderDate: '2026-01-01',
  };
  const plain = pricing.computeDeal(base);
  const withTerms = pricing.computeDeal({ ...base, supplierAdvancePct: 30, customerDepositPct: 20 });

  assert.equal(withTerms.cashflow.supplierAdvance, 300);
  assert.equal(withTerms.cashflow.customerDeposit, 400);
  // Net 100 in on day 0, so less capital is tied up.
  assert.equal(withTerms.cashflow.peakCapital < plain.cashflow.peakCapital, true);

  const first = withTerms.cashflow.schedule.find((e) => e.label === 'Order placed');
  assert.equal(first.amount, 100, 'deposit less advance lands on the order date');

  // Total economics are unchanged by timing.
  const net = withTerms.cashflow.schedule.reduce((s, e) => s + e.amount, 0);
  assert.equal(Math.round(net * 100) / 100, plain.cashflow.schedule.reduce((s, e) => s + e.amount, 0));
  assert.equal(withTerms.metrics.marginPct, plain.metrics.marginPct);
});

test('case price with unknown pack size is never treated as a bottle price', () => {
  const opts = { quantity: 12, destination: 'US', baseCurrency: 'USD', fxRate: 1, settings: {} };
  const base = { supplier_code: 'S', price: 240, price_basis: 'case', price_type: 'cost', currency: 'USD', incoterm: 'DDP' };

  const known = computeLanded({ ...base, id: 1, units_per_case: 24 }, {}, opts);
  assert.equal(known.acquisitionPerBottle, 10);
  assert.equal(known.executable, true);
  assert.equal(known.packKnown, true);

  // Unknown pack size: we must not divide by an assumed 1.
  const unknown = computeLanded({ ...base, id: 2, units_per_case: null }, {}, opts);
  assert.equal(unknown.executable, false, 'a case price with no pack size is not executable');
  assert.ok(unknown.flags.includes('units-per-case-unknown'));
  assert.ok(unknown.missing.includes('units per case'));

  // The old importer coerced unknown -> 1, which silently produced a bottle
  // price. That must now be refused too.
  const coerced = computeLanded({ ...base, id: 3, units_per_case: 1 }, {}, opts);
  assert.equal(coerced.executable, false);
  assert.ok(coerced.flags.includes('units-per-case-unknown'));

  // Unit-basis offers are unaffected by any of this.
  const unit = computeLanded({ ...base, id: 4, price: 10, price_basis: 'unit', units_per_case: null }, {}, opts);
  assert.equal(unit.acquisitionPerBottle, 10);
  assert.equal(unit.executable, true);
  assert.equal(unit.flags.includes('units-per-case-unknown'), false);
});

test('approvals: staff sign-off is recorded and can be enforced', () => {
  const approvals = require('../server/services/approvals');
  const { setSetting } = require('../server/db');
  const row = db.prepare(
    `SELECT product_id FROM offers WHERE product_id IS NOT NULL AND price > 0 AND gtin_canonical IS NOT NULL
     GROUP BY product_id ORDER BY COUNT(*) DESC LIMIT 1`
  ).get();
  const pid = row.product_id;

  // Baseline: enforcement off, everything tradeable.
  setSetting('require_offer_approval', '0');
  assert.equal(approvals.approvalRequired(), false);
  const open = sourcing.sourceLowest({ productId: pid, quantity: 12, destination: 'US' });
  assert.equal(approvals.counts().review > 0, true);

  // Enforcement on: unapproved offers drop out of the executable set.
  setSetting('require_offer_approval', '1');
  try {
    assert.equal(approvals.approvalRequired(), true);
    const enforced = sourcing.sourceLowest({ productId: pid, quantity: 12, destination: 'US' });
    assert.ok(enforced.counts.executable <= open.counts.executable);
    for (const r of enforced.ranked) {
      assert.equal(r.approvalStatus, 'approved', 'only approved offers may be executable');
    }
  } finally {
    setSetting('require_offer_approval', '0');
  }
});

test('approvals: cannot sign off an offer with no price or no barcode', () => {
  const approvals = require('../server/services/approvals');
  const noPrice = db.prepare('SELECT id FROM offers WHERE price IS NULL OR price <= 0 LIMIT 1').get();
  if (noPrice) {
    const r = approvals.decide(noPrice.id, 'approved', 'buyer');
    assert.equal(r.ok, false);
    assert.match(r.error, /no price/);
  }
  const noGtin = db.prepare("SELECT id FROM offers WHERE (gtin_canonical IS NULL OR gtin_canonical = '') AND price > 0 LIMIT 1").get();
  if (noGtin) {
    const r = approvals.decide(noGtin.id, 'approved', 'buyer');
    assert.equal(r.ok, false);
    assert.match(r.error, /no valid barcode/);
  }
  assert.match(approvals.decide(1, 'banana', 'buyer').error, /decision must be one of/);
});

test('GL journal balances per currency and never totals across currencies', () => {
  const reporting = require('../server/services/reporting');
  const order = db.prepare('SELECT id FROM orders LIMIT 1').get();
  db.prepare("INSERT INTO payments(order_id,direction,amount,currency,paid_date) VALUES(?,?,?,?,?)")
    .run(order.id, 'outbound', 500, 'EUR', '2026-01-05');
  db.prepare("INSERT INTO payments(order_id,direction,amount,currency,paid_date) VALUES(?,?,?,?,?)")
    .run(order.id, 'inbound', 900, 'GBP', '2026-02-05');

  const sheet = reporting.BUILDERS.gl();
  const eur = sheet.currencies.find((c) => c.currency === 'EUR');
  const gbp = sheet.currencies.find((c) => c.currency === 'GBP');
  assert.ok(eur && gbp, 'each currency must get its own total');
  assert.equal(eur.debit, eur.credit, 'EUR must balance');
  assert.equal(gbp.debit, gbp.credit, 'GBP must balance');
  // The critical part: no single figure mixes currencies.
  assert.equal(sheet.currencies.length >= 3, true);
  for (const c of sheet.currencies) assert.equal(c.debit, c.credit);
});

test('shipment: allocates cost by the declared driver and reconciles exactly', () => {
  const s = shipments.createShipment({
    ref: 'SHIP-TEST-W', direction: 'inbound', supplierCode: 'ALCODIS', costType: 'freight',
    totalCost: 1000, currency: 'USD', driver: 'value', declaredValue: 6000, createdBy: 'test',
    lines: [{ productId: 1, quantity: 10, basisValue: 4000 }, { productId: 2, quantity: 5, basisValue: 2000 }],
  });
  assert.ok(s.id);
  const r = shipments.allocate(s.id, 'test');
  assert.equal(r.reconciled, true);
  assert.equal(r.shipmentTotal, 1000);
  assert.equal(r.allocatedTotal, 1000);
  assert.equal(r.difference, 0);
  // 4000/6000 of 1000 = 666.67, 2000/6000 = 333.33
  assert.equal(r.lines[0].allocatedCost, 666.67);
  assert.equal(r.lines[1].allocatedCost, 333.33);
});

test('shipment: rounding remainder still reconciles to the total', () => {
  // 100 / 3 splits into thirds that cannot each be exact.
  const s = shipments.createShipment({
    ref: 'SHIP-TEST-R', totalCost: 100, driver: 'weight', totalWeightKg: 3, createdBy: 'test',
    lines: [{ productId: 1, quantity: 1, basisValue: 1 }, { productId: 2, quantity: 1, basisValue: 1 }, { productId: 3, quantity: 1, basisValue: 1 }],
  });
  const r = shipments.allocate(s.id, 'test');
  assert.equal(r.reconciled, true);
  assert.equal(r.allocatedTotal, 100);
  const sum = r.lines.reduce((a, l) => a + l.allocatedCost, 0);
  assert.equal(Math.round(sum * 100) / 100, 100, 'allocations must add back to the shipment total');
});

test('shipment: refuses an unknown driver or a zero allocation basis', () => {
  assert.equal(shipments.createShipment({ totalCost: 100, driver: 'vibes' }).error != null, true);
  assert.equal(shipments.createShipment({ totalCost: 0, driver: 'value' }).error != null, true);

  const s = shipments.createShipment({
    ref: 'SHIP-TEST-Z', totalCost: 500, driver: 'weight', createdBy: 'test',
    lines: [{ productId: 1, quantity: 1, basisValue: 0 }],
  });
  const r = shipments.allocate(s.id, 'test');
  assert.match(r.error, /basis is zero/);
});

test('shipment: an empty shipment is not reported as reconciled', () => {
  const s = shipments.createShipment({ ref: 'SHIP-TEST-E', totalCost: 750, driver: 'volume', createdBy: 'test', lines: [] });
  assert.match(shipments.allocate(s.id, 'test').error, /no lines/);
  const rec = shipments.reconcile(s.id);
  assert.equal(rec.reconciled, false);
  assert.equal(rec.allocatedTotal, 0);
});

test('tasks: a captured lead gets an automatic follow-up, noise does not', () => {
  const lead = parseNote('Customer: Atlantic Beauty. Interested in 500 bottles of Bleu de Chanel Eau de Parfum, target 18.50 EUR.');
  const noise = parseNote('ok');
  assert.equal(tasks.looksLikeLead(lead), true);
  assert.equal(tasks.looksLikeLead(noise), false);
  assert.equal(tasks.looksLikeLead(null), false);

  const capId = Number(db.prepare(
    "INSERT INTO captures(source, title, raw_text, parsed_json, created_by) VALUES('plaud','Call back','x','{}','test')"
  ).run().lastInsertRowid);

  const id = tasks.taskForCapture({ id: capId, source: 'plaud', title: 'Call back' }, lead, 'test');
  assert.ok(id, 'expected an automatic follow-up task');
  const t = tasks.list({ openOnly: '1' }).find((x) => x.id === id);
  assert.ok(t);
  assert.equal(t.status, 'open');
  assert.equal(t.capture_id, capId);
  assert.ok(t.due_date, 'task must have a due date');
  assert.match(t.detail, /500 units/);

  // A note with no signals must not manufacture work.
  assert.equal(tasks.taskForCapture({ id: capId, source: 'manual' }, noise, 'test'), null);
});

test('tasks: completing is guarded and closing a capture task releases it', () => {
  const parsed = parseNote('Interested in 200 units, price 12.00 USD.');
  const capId = Number(db.prepare(
    "INSERT INTO captures(source, title, raw_text, parsed_json, created_by) VALUES('manual','Lead','x','{}','test')"
  ).run().lastInsertRowid);
  const id = tasks.taskForCapture({ id: capId, source: 'manual', title: 'Lead' }, parsed, 'test');
  assert.ok(id);

  assert.equal(tasks.complete(id, 'test').ok, true);
  assert.equal(tasks.complete(id, 'test').ok, false, 'completing twice must be refused');
  assert.equal(tasks.list({ status: 'done' }).some((t) => t.id === id), true);

  const id2 = tasks.taskForCapture({ id: capId, source: 'manual', title: 'Lead 2' }, parsed, 'test');
  assert.equal(tasks.closeForCapture(capId, 'test', 'promoted'), 1);
  assert.equal(tasks.list({ status: 'done' }).some((t) => t.id === id2), true);
});

test('tasks: an overdue task is flagged, not dropped', () => {
  const id = tasks.create({ title: 'Chase overdue', dueDate: '2020-01-01', createdBy: 'test' });
  const t = tasks.list({ openOnly: '1' }).find((x) => x.id === id);
  assert.ok(t);
  assert.equal(t.overdue, true);
  assert.ok(tasks.summary().overdue >= 1);
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

// ---------------------------------------------------------------------------
// Standard-template cleaning (auto-run after every import)
// ---------------------------------------------------------------------------

test('cleaning: concentration, gender, retail pack and confidence normalise', () => {
  assert.equal(template.parseConcentration('Eau de Toilette 50ml'), 'EDT');
  assert.equal(template.parseConcentration('EAU DE PARFUM 100 ML'), 'EDP');
  assert.equal(template.parseConcentration('EXTRAIT DE PARFUM'), 'Parfum');
  assert.equal(template.parseConcentration('EDC 200ml'), 'EDC');
  assert.equal(template.parseConcentration('no idea'), '');

  assert.equal(template.parseGender('PERFUME MUJER'), 'Women');
  assert.equal(template.parseGender('PERFUME HOMBRE'), 'Men');
  assert.equal(template.parseGender('UNISEX'), 'Unisex');
  assert.equal(template.parseGender('EAU DE PARFUM'), '');

  assert.equal(template.parseRetailPack('DIOR SAUVAGE TESTER 100ML'), 'Tester');
  assert.equal(template.parseRetailPack('CHANEL COFFRET GIFT SET'), 'Gift set');
  assert.equal(template.parseRetailPack('RECARGA REFILL 100ML'), 'Refill');
  assert.equal(template.parseRetailPack('BLEU DE CHANEL 100ML'), 'Retail');

  assert.equal(template.normUs('Eligible'), 'Eligible');
  assert.equal(template.normUs('not eligible'), 'Not eligible');
  assert.equal(template.normUs(''), '');
  assert.equal(template.normConfidence('on request'), 'On request');
  assert.equal(template.normConfidence('confirmed'), 'Firm');
});

test('cleaning: brand and fragrance split out of the supplier description', () => {
  const a = template.parseBrand('CHANEL BLEU DE CHANEL EAU DE PARFUM 100 ML');
  assert.equal(a.brand, 'Chanel');
  assert.equal(template.parseFragrance(a.rest, 100), 'Bleu De Chanel');

  const b = template.parseBrand('Tom Ford Lost Cherry EDP 50ml');
  assert.equal(b.brand, 'Tom Ford');
  assert.equal(template.parseFragrance(b.rest, 50), 'Lost Cherry');

  const unknown = template.parseBrand('Acme Wonderland 100ml');
  assert.equal(unknown.brand, 'Acme');

  const n5 = template.parseBrand('Chanel N°5 Eau de Parfum Vaporizador 30 ml');
  assert.equal(n5.brand, 'Chanel');
  assert.equal(template.parseFragrance(n5.rest, 30), 'N°5');

  const iga = template.parseBrand('VERSACE EROS Parfum VAP. 50ML');
  assert.equal(iga.brand, 'Versace');
  assert.equal(template.parseFragrance(iga.rest, 50), 'Eros');
});

test('cleaning: an offer maps onto the standard template columns', () => {
  const out = template.mapOffer({
    id: 7, supplier_code: 'ACME', supplier_name: 'Acme Fragrances',
    description: 'CHANEL BLEU DE CHANEL EAU DE PARFUM 100 ML', category: 'PERFUME HOMBRE',
    size_ml: 100, price: 540, price_basis: 'case', units_per_case: 12, currency: 'EUR',
    source_row: 3, us_suitability: 'eligible', stock_confidence: 'confirmed',
    incoterm: 'dap', incoterm_place: 'New York',
  });
  assert.equal(out.length, template.TEMPLATE_COLUMNS.length);
  assert.equal(out[0], 'ACME');
  assert.equal(out[1], 'Acme Fragrances');
  assert.equal(out[10], 'Chanel');
  assert.equal(out[11], 'Bleu De Chanel');
  assert.equal(out[12], 'EDP');
  assert.equal(out[13], 100);
  assert.equal(out[14], 'Men');
  assert.equal(out[16], 'Retail');
  assert.equal(out[25], 'Case');
  assert.equal(out[26], 12);
  assert.equal(out[36], 'DAP');
  assert.equal(out[44], 'Eligible');
  assert.equal(out[48], 'Firm');
});

test('cleaning: the Offers sheet matches the shipped standard template', () => {
  const templatePath = path.join(__dirname, '..', 'supplier-template.xlsx');
  if (!fs.existsSync(templatePath)) return;
  const wb = XLSX.readFile(templatePath);
  const header = XLSX.utils.sheet_to_json(wb.Sheets.Offers, { header: 1, defval: '' })[0]
    .map((x) => String(x).trim()).filter((x) => x.length);
  assert.deepEqual(template.TEMPLATE_COLUMNS, header);
});

test('cleaning: every seeded import has a cleaned snapshot on disk', () => {
  const up = db.prepare('SELECT id FROM uploads ORDER BY id LIMIT 1').get();
  assert.ok(up, 'seed should have produced at least one upload');
  const out = template.cleanedBuffer(up.id);
  assert.ok(out && out.buffer.length > 0);
  const wb = XLSX.read(out.buffer, { type: 'buffer' });
  for (const sheet of ['Offers', 'FieldGuide', 'Enum', 'Instructions']) {
    assert.ok(wb.Sheets[sheet], `cleaned workbook should contain ${sheet}`);
  }
  assert.equal(
    XLSX.utils.sheet_to_json(wb.Sheets.Offers, { header: 1, defval: '' })[0].filter((x) => String(x).trim()).length,
    template.TEMPLATE_COLUMNS.length
  );
});

test('cleaning: cleanUpload writes a snapshot and records it on the upload', () => {
  const up = db.prepare('SELECT id FROM uploads ORDER BY id LIMIT 1').get();
  const info = template.cleanUpload(up.id);
  assert.ok(info && info.rows >= 1);
  const row = db.prepare('SELECT cleaned_path, cleaned_rows, cleaned_at FROM uploads WHERE id = ?').get(up.id);
  assert.equal(row.cleaned_rows, info.rows);
  assert.ok(row.cleaned_at);
  assert.ok(fs.existsSync(row.cleaned_path));
  const offers = XLSX.utils.sheet_to_json(XLSX.readFile(row.cleaned_path).Sheets.Offers, { header: 1, defval: '' });
  assert.equal(offers.length, info.rows + 1);
});

test('placements: full-box rounding never leaves a part box', () => {
  assert.deepEqual(placements.toFullBoxes(10, 12), { unitsPerCase: 12, units: 12, boxes: 1, roundedUpFrom: 10 });
  assert.deepEqual(placements.toFullBoxes(24, 12), { unitsPerCase: 12, units: 24, boxes: 2, roundedUpFrom: 24 });
  assert.equal(placements.toFullBoxes(25, 12).units, 36);
  assert.equal(placements.toFullBoxes(7, 1).boxes, 7);
  assert.equal(placements.toFullBoxes(3, 0).boxes, 3);
});

test('placements: a line derives cost, pack size and totals from the offer', () => {
  const offer = db.prepare('SELECT id, units_per_case, currency FROM offers WHERE units_per_case > 1 AND price > 0 LIMIT 1').get();
  if (!offer) return;
  const line = placements.normalizeLine({ offerId: offer.id, boxes: 2 });
  const upc = Number(offer.units_per_case);
  assert.equal(line.units, 2 * upc);
  assert.equal(line.boxes, 2);
  assert.equal(line.currency, offer.currency);
  assert.ok(Number.isFinite(line.unit_cost) && line.unit_cost > 0);
  assert.equal(line.line_total, pricing.round4(line.unit_cost * line.units));
});

test('placements: a saved order is stored, totalled and exportable', () => {
  const plan = placements.planForSupplier();
  if (!plan.lines.length || !plan.suppliers.length) return;
  const code = plan.suppliers[0];
  const chosen = placements.planForSupplier(code).lines.slice(0, 3);
  const created = placements.createPlacement({
    supplierCode: code,
    lines: chosen.map((l) => ({ productId: l.productId, offerId: l.offerId, boxes: l.suggestedBoxes || 1 })),
  });
  assert.ok(created.ok && created.id, 'placement should be created');

  const got = placements.getPlacement(created.id);
  assert.equal(got.supplier_code, code);
  assert.equal(got.lines.length, chosen.length);
  assert.equal(got.totals.units, got.lines.reduce((s, l) => s + l.units, 0));
  assert.ok(got.totals.total > 0);

  const wb = placements.placementWorkbook(created.id);
  assert.ok(wb && wb.buffer.length > 0);
  const sheet = XLSX.read(wb.buffer, { type: 'buffer' }).Sheets.Placement;
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  assert.ok(rows.some((r) => String(r[0]).includes('order placement')));
  assert.equal(rows.filter((r) => typeof r[0] === 'number').length, chosen.length);
  assert.equal(placements.getPlacement(999999), null);
  assert.ok(placements.listPlacements().some((p) => p.id === created.id));
});

test('pfi: a proforma is matched to the placed order and variances reported', () => {
  const mkPfi = (rows) => {
    const ws = XLSX.utils.aoa_to_sheet([['Descripcion', 'Precio', 'Cantidad'], ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'PFI');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  };
  const placement = {
    currency: 'EUR',
    lines: [
      { barcode: '', description: 'Chanel N5 EDP 100ml', units: 24, unit_cost: 50, line_total: 1200 },
      { barcode: '', description: 'Dior Sauvage EDT 100ml', units: 12, unit_cost: 40, line_total: 480 },
    ],
  };
  const parsed = pfi.parsePfi(mkPfi([
    ['Chanel N5 EDP 100ml', 55, 24],
    ['Dior Sauvage EDT 100ml', 40, 10],
    ['Extra freebie', 9, 3],
  ]));
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.pfiTotal, 1747);

  const cmp = pfi.compareToPlacement(placement, parsed);
  assert.equal(cmp.summary.matched, 2);
  assert.equal(cmp.summary.priceChanges, 1);
  assert.equal(cmp.summary.quantityChanges, 1);
  assert.equal(cmp.summary.extra, 1);
  assert.equal(cmp.summary.missing, 0);
  assert.equal(cmp.orderTotal, 1680);
  assert.equal(cmp.varianceTotal, 67);

  const priceLine = cmp.matched.find((m) => m.priceDiff != null && m.priceDiff !== 0);
  assert.equal(priceLine.priceDiff, 5);
  assert.equal(priceLine.pricePct, 10);
  const qtyLine = cmp.matched.find((m) => m.qtyDiff);
  assert.equal(qtyLine.qtyDiff, 2);
});

test('pfi: a comparison is recorded, listed and can carry the reference PDF', () => {
  const plan = placements.planForSupplier();
  if (!plan.lines.length || !plan.suppliers.length) return;
  const code = plan.suppliers[0];
  const chosen = placements.planForSupplier(code).lines.slice(0, 2);
  const created = placements.createPlacement({ supplierCode: code, lines: chosen.map((l) => ({ offerId: l.offerId, boxes: l.suggestedBoxes || 1 })) });
  const pl = placements.getPlacement(created.id);

  const ws = XLSX.utils.aoa_to_sheet([['EAN', 'Descripcion', 'Precio', 'Cantidad'],
    ...pl.lines.map((l) => [l.barcode, l.description, l.unit_cost, l.units])]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'PFI');
  const parsed = pfi.parsePfi(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  const cmp = pfi.compareToPlacement(pl, parsed);
  assert.equal(cmp.summary.priceChanges, 0);
  assert.equal(cmp.summary.quantityChanges, 0);

  const id = pfi.savePfi(pl.id, { filename: 'pfi.xlsx', currency: pl.currency, orderTotal: cmp.orderTotal, pfiTotal: cmp.pfiTotal, varianceTotal: cmp.varianceTotal, detail: { matched: cmp.matched }, createdBy: 'test' });
  assert.ok(id);
  assert.equal(pfi.listPfi(pl.id).length, 1);
  assert.ok(pfi.getPfi(id).filename === 'pfi.xlsx');

  pfi.attachPdf(id, { originalname: 'supplier-pfi.pdf', buffer: Buffer.from('%PDF-1.4 fake') });
  const att = pfi.attachment(id);
  assert.ok(att && att.buffer.length > 0);

  assert.equal(pfi.removePfi(id), true);
  assert.equal(pfi.getPfi(id), null);
});

test('quote comparison: percentage difference between two offers we prepared', () => {
  const quoteCompare = require('../server/services/quoteCompare');
  const cust = db.prepare('SELECT id FROM customers LIMIT 1').get().id;
  const prod = db.prepare('SELECT id FROM products LIMIT 1').get().id;
  const ins = db.prepare(
    `INSERT INTO quotes(customer_id, product_id, quantity, unit_price, currency, landed_unit_cost,
        margin_pct, contribution_total, roi_pct, capital_required, capital_days, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const aId = Number(ins.run(cust, prod, 100, 20, 'USD', 10, 50, 1000, 30, 1000, 40, 'draft').lastInsertRowid);
  const bId = ins.run(cust, prod, 120, 25, 'USD', 10, 60, 1800, 36, 1200, 45, 'sent').lastInsertRowid;

  const r = quoteCompare.compareQuotes(Number(aId), Number(bId));
  const price = r.money.find((x) => x.key === 'unit_price');
  assert.equal(price.a, 20);
  assert.equal(price.b, 25);
  assert.equal(price.diff, 5);
  assert.equal(price.pctDiff, 25);

  const qty = r.plain.find((x) => x.key === 'quantity');
  assert.equal(qty.pctDiff, 20);
  assert.equal(r.percent.find((x) => x.key === 'margin_pct').diff, 10);
  assert.equal(r.summary.maxAbsPctDiff, 80);
  assert.equal(r.summary.changedNumeric, 7);
  assert.equal(r.currencyMismatch, false);
  assert.ok(r.text.find((t) => t.key === 'status' && t.changed));

  assert.ok(quoteCompare.compareQuotes(999999, r.b.id).notFound);
});



