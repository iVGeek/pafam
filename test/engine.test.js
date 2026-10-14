'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const pricing = require('../server/services/pricing');
const gtin = require('../src/lib/gtin');
const { parsePackSize } = require('../src/lib/pack');
const { parseNote } = require('../src/lib/notes');

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
