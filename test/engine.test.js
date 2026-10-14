'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const pricing = require('../server/services/pricing');
const gtin = require('../src/lib/gtin');
const { parsePackSize } = require('../src/lib/pack');
const { parseNote } = require('../src/lib/notes');
const { computeLanded, selectTier } = require('../server/services/landing');
const incoterms = require('../src/lib/incoterms');

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
