'use strict';
// New vendor layouts seen in real client files. Fixtures are synthetic — the
// actual price lists are never copied into the repository.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const { detectProfile } = require('../src/importers/profiles');
const { extract } = require('../src/importers/genericImporter');

const dir = path.join(os.tmpdir(), `ptp-vendor-profiles-${process.pid}`);
fs.mkdirSync(dir, { recursive: true });
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } });

function workbook(name, rows) {
  const file = path.join(dir, name);
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Prices');
  XLSX.writeFile(wb, file);
  return file;
}

test('vendor profiles: L\'Oréal analysis sheet uses NEW CP as cost and SP as reference', () => {
  const headers = ['BRAND', 'EAN', 'DESCRIPTION', 'QTY', 'NEW CP', 'GCS CP', '(-+)CP Var', 'SP', '% margin'];
  assert.strictEqual(detectProfile(headers).id, 'LOREAL');

  const file = workbook('loreal.xlsx', [
    headers,
    ['Lancome', '3614272639638', 'IDOLE EDP V25ML DEV', 1000, ' $31.76 ', ' $34.65 ', ' $2.89 ', ' $38.46 ', '17%'],
    // Totals/footer row: no product identity, must not become an exception.
    ['', '', '', 29600, '', '', '', '', ''],
  ]);
  const out = extract(file, { supplierId: 'LOREAL', supplierName: "L'Oréal" });
  assert.strictEqual(out.profile.id, 'LOREAL');
  assert.strictEqual(out.offers.length, 1, 'footer row skipped');

  const o = out.offers[0];
  assert.strictEqual(o.gtinSource, '3614272639638');
  assert.strictEqual(o._gtin.valid, true);
  assert.strictEqual(o.price, 31.76, 'NEW CP is our cost');
  assert.strictEqual(o.rrp, 38.46, 'SP is only a selling-price reference');
  assert.strictEqual(o.availableQuantity, 1000);
  assert.strictEqual(o.quantityUnit, 'units', 'not pallets');
  assert.strictEqual(o.currency, 'USD');
});

test('vendor profiles: raw L\'Oréal EXWHK list uses EXWHK USD as cost', () => {
  const headers = ['BRAND', 'EAN', 'DESCRIPTION', 'EXWHK USD', 'QTY'];
  assert.strictEqual(detectProfile(headers).id, 'LOREAL');

  const file = workbook('loreal-raw.xlsx', [
    headers,
    ['Armani', '3614274222142', 'EMPORIO CLASSIC HE EDT 100ML', '35.29', 800],
    ['', '', '', '', 29600], // totals/footer row
  ]);
  const out = extract(file, { supplierId: 'LOREAL', supplierName: "L'Oréal" });
  assert.strictEqual(out.profile.id, 'LOREAL');
  assert.strictEqual(out.offers.length, 1, 'footer row skipped');

  const o = out.offers[0];
  assert.strictEqual(o.gtinSource, '3614274222142');
  assert.strictEqual(o._gtin.valid, true);
  assert.strictEqual(o.price, 35.29, 'EXWHK USD is our cost');
  assert.strictEqual(o.rrp, null, 'no reference price in the raw list');
  assert.strictEqual(o.availableQuantity, 800);
  assert.strictEqual(o.quantityUnit, 'units');
  assert.strictEqual(o.currency, 'USD');
});

test('vendor profiles: GE Wholesale keeps leading zeros and reads stock as units', () => {
  const headers = ['SKU', 'UPC', 'Brand', 'Description', 'Price (USD)', 'Stock'];
  assert.strictEqual(detectProfile(headers).id, 'GEWHOLESALE');

  const file = workbook('ge.xls', [
    headers,
    ['GXP-11466', '085715167613', 'Abercrombie & Fitch', 'FIRST INSTINCT SHEER 3.4oz', 17.5, 115],
    ['GXP-99999', '', 'No barcode', 'Something without a UPC', 9, 5],
    ['', '', '', '', '', ''],
  ]);
  const out = extract(file, { supplierId: 'GEWHOLESALE', supplierName: 'GE Wholesale' });
  assert.strictEqual(out.profile.id, 'GEWHOLESALE');
  assert.strictEqual(out.offers.length, 2, 'blank row skipped, blank-UPC row kept for exceptions');

  const [a, b] = out.offers;
  assert.strictEqual(a.gtinSource, '085715167613', 'leading zero survives as text');
  assert.strictEqual(a._gtin.canonical14, '00085715167613');
  assert.strictEqual(a.internalSku, 'GXP-11466');
  assert.strictEqual(a.price, 17.5);
  assert.strictEqual(a.availableQuantity, 115);
  assert.strictEqual(a.quantityUnit, 'units');
  assert.strictEqual(a.currency, 'USD');
  assert.strictEqual(b.gtinSource, null, 'unidentifiable barcodes stay blank, never invented');
  assert.strictEqual(b.internalSku, 'GXP-99999');
});

test('vendor profiles: the new matchers do not steal the existing Igan layout', () => {
  assert.strictEqual(detectProfile(['CodigoEAN', 'Descripcion', 'PVP']).id, 'IGAN');
});
