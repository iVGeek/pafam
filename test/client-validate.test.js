'use strict';

// Intake validator tests: build a realistic, valid client package in a temp
// directory, then mutate one thing per test to prove the check fires.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { validatePackage } = require('../scripts/validate-client-data');

const SUPPLIER_HEADER = [
  'code', 'name', 'baseCurrency', 'priceType', 'tradeDiscountPct', 'incoterm',
  'incotermPlace', 'paymentTerms', 'dutyPct', 'freightPerUnit', 'insurancePct',
  'brokeragePerUnit', 'handlingPerUnit', 'otherTaxPct', 'recoverableTaxPct',
  'stockCountry', 'originCountry', 'priceListFormat', 'contactName',
  'contactEmail', 'contactPhone', 'active', 'notes',
];
const SUPPLIER_ROWS = [
  ['ALCODIS', 'Alcodis Trading SL', 'EUR', 'cost', 0, 'EXW', 'Barcelona', '30 days', 0, 0.35, 0.5, 0.1, 0.05, 0, 0, 'ES', 'FR', 'ALCODIS', 'Ana Ruiz', 'sales@alcodis.example', '+34 900 000 000', 1, ''],
  ['IGAN', 'Igan Distribucion SA', 'EUR', 'rrp', 40, 'EXW', 'Lleida', '50% advance', 0, 0.25, 0.5, 0.1, 0.05, 0, 0, 'ES', 'ES', 'IGAN', 'Marc Soler', 'pedidos@igan.example', '+34 900 000 001', 1, ''],
];

const CUSTOMER_HEADER = [
  'code', 'name', 'baseCurrency', 'region', 'paymentTerms', 'creditLimit',
  'contactName', 'contactEmail', 'contactPhone', 'address', 'taxId',
  'sanctioned', 'active', 'notes',
];
const CUSTOMER_ROWS = [
  ['CUST-001', 'Acme Distribution LLC', 'USD', 'US', 'Net 45', 50000, 'John Doe', 'buying@acme.example', '+1 555 000 0000', '123 Main St, Miami FL', 'US-123456789', 0, 1, ''],
];

const FX_HEADER = ['base', 'quote', 'rate', 'rateDate', 'source', 'booked'];
const FX_ROWS = [['EUR', 'USD', 1.08, '2026-11-01', 'bank', 1]];

const RAW_LOG_HEADER = [
  'supplierCode', 'originalFileName', 'receivedDate', 'listValidFrom',
  'listValidTo', 'fileCurrency', 'priceBasis', 'tradeDiscountPctIfRrp',
  'defaultUnitsPerCase', 'hasBarcodeColumn', 'barcodeColumnHeader',
  'headerRowNumber', 'notes',
];
const RAW_LOG_ROWS = [
  ['ALCODIS', 'ALCODIS_RAW.xlsx', '2026-10-01', '2026-10-01', '2026-10-31', 'EUR', 'cost', 0, 6, 'YES', 'EAN (Bt', 1, ''],
  ['IGAN', 'IGAN_RAW.xlsx', '2026-09-28', '2026-09-28', '2026-10-28', 'EUR', 'rrp', 40, 12, 'YES', 'CodigoEAN', 1, ''],
];

const ALCODIS_RAW_ROWS = [
  ['EAN (Bt', 'DUN (Box)', 'Nº', 'Descripción', 'Volumen', '% Alc.', 'Precio'],
  ['3348901392020', '3348901392020', 'A1', 'Sauvage EDP 100ml', 0.1, 80, 61.5],
  ['3348901387033', '3348901387033', 'A2', 'Sauvage EDT 60ml', 0.06, 80, 38.1],
];
const IGAN_RAW_ROWS = [
  ['CodigoEAN', 'Artículo Descripción', 'Código', 'Vol. Ltr.', 'Und. Caja', 'Stock Pallet', 'PVP', 'min. pedido'],
  ['3348901392020', 'Sauvage EDP 100ml', 'I1', 0.1, 12, 5, 105, 1],
  ['3348901387033', 'Sauvage EDT 60ml', 'I2', 0.06, 12, 5, 78, 1],
];

const PREPARED_HEADER = [
  'ean', 'brand', 'product', 'concentration', 'sizeMl', 'gender', 'casePack',
  'supplierCode', 'supplierListDate', 'costPerUnit', 'costCurrency',
  'fxRateToSell', 'landedCost', 'sellPrice', 'sellCurrency', 'markupPct', 'rrp',
  'availability', 'validUntil', 'incoterm', 'leadTimeDays', 'notes',
];
const PREPARED_ROWS = [
  ['3348901392020', 'Dior', 'Sauvage EDP 100ml', 'EDP', 100, 'Men', 6, 'ALCODIS', '2026-10-01', 61.5, 'EUR', 1.08, 63.9, 82.5, 'USD', 29, 105, 'In stock', '2026-10-31', 'EXW', 7, ''],
  ['3348901387033', 'Dior', 'Sauvage EDT 60ml', 'EDT', 60, 'Men', 12, 'IGAN', '2026-09-28', 38.1, 'EUR', 1.08, 39.6, 54.9, 'USD', 38, 78, 'Low stock', '2026-10-28', 'EXW', 7, ''],
];

const COMPANY_ROWS = [
  ['OFFER — COMPANY COPY (INTERNAL) — NEVER SEND TO CUSTOMER'],
  [''],
  ['Offer reference', 'Q-0042', '', 'Date', '2026-10-19'],
  ['Customer code', 'CUST-001', '', 'Valid until', '2026-11-02'],
  ['Customer name', 'Acme Distribution LLC', '', 'Currency', 'USD'],
  ['Prepared by', 'Maria Serra', '', 'Status', 'DRAFT'],
  ['Approved by', '(if approval required)', '', 'Price list basis', 'ALCODIS 2026-10-01'],
  [''],
  ['line', 'sku', 'ean', 'brand', 'product', 'concentration', 'sizeMl', 'qty', 'unitPriceSell', 'lineTotal', 'supplierCode', 'unitCost', 'landedUnitCost', 'marginPct', 'markupPct', 'incoterm', 'leadTimeDays', 'notes'],
  [1, 'ALC-000123', '3348901392020', 'Dior', 'Sauvage EDP 100ml', 'EDP', 100, 240, 82.5, 19800, 'ALCODIS', 61.5, 63.9, 22.6, 29.1, 'EXW', 7, ''],
  [2, 'ALC-000456', '3348901387033', 'Dior', 'Sauvage EDT 60ml', 'EDT', 60, 120, 54.9, 6588, 'IGAN', 38.1, 39.6, 27.9, 38.6, 'EXW', 7, ''],
  [''],
  ['', '', '', '', '', 'Subtotal', '', '', '', 26388],
  ['', '', '', '', '', 'Freight / other (if charged)', '', '', '', 0],
  ['', '', '', '', '', 'TOTAL', '', '', '', 26388],
  ['', '', '', '', '', 'Blended margin % on this offer', '', '', '', '23.8'],
  [''],
  ['Payment terms', 'Net 45', '', 'Internal notes', 'floor price 78.50 USD'],
  [''],
  ['INTERNAL — contains cost and margin. Never send this copy.'],
];

const CUSTOMER_OFFER_ROWS = [
  ['OFFER — CUSTOMER COPY (as sent to the customer)'],
  [''],
  ['Offer reference', 'Q-0042', '', 'Date', '2026-10-19'],
  ['Customer', 'Acme Distribution LLC', '', 'Valid until', '2026-11-02'],
  ['Prepared by', 'Maria Serra', '', 'Currency', 'USD'],
  [''],
  ['line', 'brand', 'product', 'concentration', 'sizeMl', 'qty', 'unitPrice', 'lineTotal', 'availability', 'leadTimeDays', 'notes'],
  [1, 'Dior', 'Sauvage EDP 100ml', 'EDP', 100, 240, 82.5, 19800, 'In stock', 7, ''],
  [2, 'Dior', 'Sauvage EDT 60ml', 'EDT', 60, 120, 54.9, 6588, 'Low stock', 7, ''],
  [''],
  ['', '', '', '', '', 'Subtotal', 26388],
  ['', '', '', '', '', 'Freight (per Incoterm)', 0],
  ['', '', '', '', '', 'TOTAL', 26388],
  [''],
  ['Incoterm', 'EXW Barcelona', '', 'Payment terms', 'Net 45'],
  ['Delivery lead time', '7 days from order', '', 'Prices valid until', '2026-11-02'],
  [''],
  ['Terms: prices in USD, exclude/import duty unless stated. Authenticity guaranteed. Subject to prior sale.'],
];

const NAMING_HEADER = [
  'documentType', 'audience', 'pattern', 'example', 'format',
  'containsConfidential', 'yourCurrentNamePattern', 'notes',
];
const NAMING_ROWS = [
  ['Supplier raw price list (as received)', 'supplier -> us', 'KEEP ORIGINAL FILENAME (never rename the file itself)', 'LISTA OCTUBRE ALCODIS(v.2).xls', 'xls / xlsx', 'YES', 'CURRENT RAW', ''],
  ['Supplier raw price list (archive copy)', 'internal', 'SUP-{supplierCode}_RAW_{YYYYMMDD}_{seq}', 'SUP-ALCODIS_RAW_20261019_01.xlsx', 'xlsx', 'YES', 'CURRENT ARCHIVE', ''],
  ['Supplier quotation request (RFQ)', 'us -> supplier', 'RFQ-{supplierCode}_{YYYYMMDD}_{seq}', 'RFQ-IGAN_20261019_02.xlsx', 'xlsx', 'YES', 'CURRENT RFQ', ''],
  ['Supplier proforma invoice (PFI)', 'supplier -> us', '{supplierCode}_PFI_{YYYYMMDD}_{seq}', 'IGAN_PFI_20261105_01.xlsx', 'xlsx / pdf', 'YES', 'CURRENT PFI', ''],
  ['Prepared price list (sent to customer)', 'us -> customer', 'PL-{customerCode}_{YYYYMMDD}_R{rev}', 'PL-CUST-001_20261019_R1.xlsx', 'xlsx / pdf', 'NO', 'CURRENT PL', ''],
  ['Offer — company copy (internal)', 'internal', 'OFFER-{quoteRef}_INTERNAL_{YYYYMMDD}', 'OFFER-Q-0042_INTERNAL_20261019.xlsx', 'xlsx', 'YES — NEVER SEND', 'CURRENT OFFER INTERNAL', ''],
  ['Offer — customer copy (as sent)', 'us -> customer', 'OFFER-{quoteRef}_{customerCode}_{YYYYMMDD}', 'OFFER-Q-0042_CUST-001_20261019.pdf', 'pdf (and xlsx)', 'NO', 'CURRENT OFFER CUSTOMER', ''],
  ['Customer purchase order (received)', 'customer -> us', '{customerCode}_PO_{YYYYMMDD}_{seq}', 'CUST-001_PO_20261020_01.xlsx', 'xlsx / pdf', 'YES', 'CURRENT PO', ''],
  ['Supplier order placement (platform export)', 'us -> supplier', 'placement-{PO-ref} (system-generated)', 'placement-PO-0007.xlsx / .pdf', 'xlsx / pdf', 'YES', 'CURRENT PLACEMENT', ''],
  ['Cleaned supplier import (platform export)', 'internal', '{supplierCode}-upload-{n} (system-generated)', 'ALCODIS-upload-1.xlsx', 'xlsx', 'YES', 'CURRENT CLEAN', ''],
  ['Process capture (screenshot / video)', 'client -> us', 'PROC-{processId}_{step}_{YYYYMMDD}', 'PROC-P03_step1_20261019.mp4', 'png / mp4', 'YES — internal screens', 'CURRENT PROC', ''],
  ['VLOOKUP formula log', 'client -> us', '09-vlookup-formulas.xlsx (this pack)', '09-vlookup-formulas.xlsx', 'xlsx', 'YES', 'CURRENT FORMULA', ''],
];

const CAPTURE_HEADER = [
  'id', 'process', 'what to capture', 'captureType', 'fileNaming',
  'what to highlight / narrate', 'currentTools', 'receivedDate',
];
const CAPTURE_ROWS = Array.from({ length: 11 }, (_, i) => [
  `P${i + 1}`,
  `Process ${i + 1}`,
  `Capture process ${i + 1}`,
  'video',
  `PROC-P${i + 1}_{step}_{YYYYMMDD}.mp4`,
  'Narrate what you do and why',
  'Excel / Outlook',
  '',
]);

const FORMULA_HEADER = [
  'id', 'workbookFile', 'sheetName', 'cellOrColumn', 'formulaText (paste as TEXT)',
  'businessPurpose', 'inputColumns (source)', 'outputColumn (result)',
  'relatedProcessId', 'exampleInput', 'exampleResult',
];
const FORMULA_ROWS = [
  ['F10', 'my-price-prep.xlsx', 'Prepared', 'J2', '=VLOOKUP($A2,RAW!$A:$R,10,FALSE)', 'Looks up the supplier cost for the EAN from the raw list', 'raw A, raw J', 'costPerUnit', 'P3', '3348901392020', '61.5'],
];

function writeXlsx(file, sheets) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name);
  }
  XLSX.writeFile(wb, file);
}

function buildPackage(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-client-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  writeXlsx(path.join(dir, '01-supplier-master.xlsx'), [{
    name: 'Suppliers',
    rows: [SUPPLIER_HEADER, ...(opts.supplierRows || SUPPLIER_ROWS)],
  }]);
  writeXlsx(path.join(dir, '02-customer-master.xlsx'), [{
    name: 'Customers',
    rows: [CUSTOMER_HEADER, ...(opts.customerRows || CUSTOMER_ROWS)],
  }]);
  writeXlsx(path.join(dir, '10-fx-rates.xlsx'), [{
    name: 'FXRates',
    rows: [FX_HEADER, ...(opts.fxRows || FX_ROWS)],
  }]);
  writeXlsx(path.join(dir, '03-raw-price-list-log.xlsx'), [{
    name: 'RawPriceListLog',
    rows: [RAW_LOG_HEADER, ...(opts.rawLogRows || RAW_LOG_ROWS)],
  }]);
  writeXlsx(path.join(dir, '04-prepared-price-list.xlsx'), [{
    name: 'PreparedPriceList',
    rows: [PREPARED_HEADER, ...(opts.preparedRows || PREPARED_ROWS)],
  }]);
  writeXlsx(path.join(dir, '07-document-naming.xlsx'), [{
    name: 'Naming',
    rows: [NAMING_HEADER, ...(opts.namingRows || NAMING_ROWS)],
  }]);
  writeXlsx(path.join(dir, '08-process-capture-checklist.xlsx'), [{
    name: 'Processes',
    rows: [CAPTURE_HEADER, ...(opts.captureRows || CAPTURE_ROWS)],
  }]);
  writeXlsx(path.join(dir, '09-vlookup-formulas.xlsx'), [{
    name: 'Formulas',
    rows: [FORMULA_HEADER, ...(opts.formulaRows || FORMULA_ROWS)],
  }]);

  if (opts.rawFiles !== false) {
    writeXlsx(path.join(dir, 'raw-price-lists', 'ALCODIS_RAW.xlsx'), [{ name: 'Sheet1', rows: ALCODIS_RAW_ROWS }]);
    writeXlsx(path.join(dir, 'raw-price-lists', 'IGAN_RAW.xlsx'), [{ name: 'Sheet1', rows: IGAN_RAW_ROWS }]);
  }

  if (opts.media !== false) {
    for (let i = 1; i <= 11; i += 1) {
      const id = `P${String(i).padStart(2, '0')}`;
      const ext = i <= 8 ? 'mp4' : 'png';
      const file = path.join(dir, 'process-captures', `PROC-${id}_step1_20261019.${ext}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'placeholder');
    }
  }

  const companyRows = opts.companyRows || COMPANY_ROWS;
  const customerOfferRows = opts.customerOfferRows || CUSTOMER_OFFER_ROWS;
  writeXlsx(path.join(dir, 'offers', '05-offer-company-copy.xlsx'), [{ name: 'Offer-Internal', rows: companyRows }]);
  writeXlsx(path.join(dir, 'offers', '06-offer-customer-copy.xlsx'), [{ name: 'Offer-Customer', rows: customerOfferRows }]);

  return dir;
}

function messages(result, level) {
  return result.checks.filter((c) => c.level === level).map((c) => c.message).join('\n');
}

test('a complete real package passes with no blockers', (t) => {
  const dir = buildPackage(t);
  const result = validatePackage(dir, { base: 'USD' });
  assert.strictEqual(result.base, 'USD');
  assert.strictEqual(result.ok, true, messages(result, 'BLOCKER'));
  assert.ok(result.summary.passed > 0);
  assert.strictEqual(result.summary.blockers, 0);
});

test('missing FX path for a supplier currency is a blocker', (t) => {
  const dir = buildPackage(t, { fxRows: [['GBP', 'USD', 1.27, '2026-11-01', 'bank', 1]] });
  const result = validatePackage(dir, { base: 'USD' });
  assert.strictEqual(result.ok, false);
  assert.match(messages(result, 'BLOCKER'), /no FX path EUR -> USD/);
});

test('an invalid prepared-list barcode is a blocker', (t) => {
  const rows = PREPARED_ROWS.map((r) => r.slice());
  rows[0][0] = '3348901392025'; // fails the GS1 check digit
  const dir = buildPackage(t, { preparedRows: rows });
  const result = validatePackage(dir, { base: 'USD' });
  assert.strictEqual(result.ok, false);
  assert.match(messages(result, 'BLOCKER'), /fails the GS1 check digit/);
});

test('cost data on the customer offer copy is a blocker', (t) => {
  const rows = CUSTOMER_OFFER_ROWS.map((r) => r.slice());
  rows[6].push('unitCost');
  rows[7].push(61.5);
  rows[8].push(38.1);
  const dir = buildPackage(t, { customerOfferRows: rows });
  const result = validatePackage(dir, { base: 'USD' });
  assert.strictEqual(result.ok, false);
  assert.match(messages(result, 'BLOCKER'), /forbidden internal column\(s\): unitCost\s+\[cost\]/);
});

test('customer-friendly cost/supplier/margin headers are blockers too', (t) => {
  const rows = CUSTOMER_OFFER_ROWS.map((r) => r.slice());
  // Headers a real client might use instead of the internal template names.
  rows[6].push('Supplier', 'Cost', 'Buy price', 'Landed cost', 'margin', 'Mark-up');
  rows[7].push('ALCODIS', 61.5, 61.5, 63.9, '22.6%', '29.1%');
  rows[8].push('IGAN', 38.1, 38.1, 39.6, '27.9%', '38.6%');
  const dir = buildPackage(t, { customerOfferRows: rows });
  const result = validatePackage(dir, { base: 'USD' });
  assert.strictEqual(result.ok, false, messages(result, 'WARN'));
  const blockers = messages(result, 'BLOCKER');
  for (const word of ['Supplier', 'Cost', 'Buy price', 'margin', 'Mark-up']) {
    assert.match(blockers, new RegExp(word, 'i'), `friendly header "${word}" must be blocked`);
  }
});

test('unchanged FX template example rates are a blocker', (t) => {
  const dir = buildPackage(t, {
    fxRows: [
      ['EUR', 'USD', 1.08, '2026-10-19', 'ECB', 1],
      ['GBP', 'USD', 1.27, '2026-10-19', 'ECB', 1],
    ],
  });
  const result = validatePackage(dir, { base: 'USD' });
  assert.strictEqual(result.ok, false);
  assert.match(messages(result, 'BLOCKER'), /unchanged template example rate/);
});

test('word-boundary detection does not flag innocent product names', (t) => {
  const rows = CUSTOMER_OFFER_ROWS.map((r) => r.slice());
  rows[7][4] = 'Costume fragrance EDT 100ml';
  const dir = buildPackage(t, { customerOfferRows: rows });
  const result = validatePackage(dir, { base: 'USD' });
  assert.strictEqual(result.ok, true, messages(result, 'BLOCKER'));
});

test('a template-only supplier master is a blocker', (t) => {
  const dir = buildPackage(t, {
    supplierRows: [[
      'ALCODIS', 'Alcodis Trading SL', 'EUR', 'cost', 0, 'EXW', 'Barcelona', '30 days',
      0, 0.35, 0.5, 0.1, 0.05, 0, 0, 'ES', 'FR', 'ALCODIS', 'Ana Ruiz',
      'sales@alcodis.example', '+34 900 000 000', 1, 'EXAMPLE ROW — replace',
    ]],
  });
  const result = validatePackage(dir, { base: 'USD' });
  assert.strictEqual(result.ok, false);
  assert.match(messages(result, 'BLOCKER'), /no real supplier rows/);
});

test('a logged raw file that is not in the package is a blocker', (t) => {
  const dir = buildPackage(t, { rawFiles: false });
  const result = validatePackage(dir, { base: 'USD' });
  assert.strictEqual(result.ok, false);
  assert.match(messages(result, 'BLOCKER'), /raw file "ALCODIS_RAW\.xlsx" not found/);
});

test('offer totals that do not reconcile are a blocker', (t) => {
  const rows = COMPANY_ROWS.map((r) => r.slice());
  rows[12][9] = 26000; // subtotal was 26388
  rows[14][9] = 26000; // total was 26388
  const dir = buildPackage(t, { companyRows: rows });
  const result = validatePackage(dir, { base: 'USD' });
  assert.strictEqual(result.ok, false);
  assert.match(messages(result, 'BLOCKER'), /subtotal 26000 does not match the line sum 26388\.00/);
});

test('blank yourCurrentNamePattern values are warnings, not blockers', (t) => {
  const rows = NAMING_ROWS.map((r) => r.slice());
  rows[0][6] = '';
  rows[1][6] = '';
  const dir = buildPackage(t, { namingRows: rows });
  const result = validatePackage(dir, { base: 'USD' });
  assert.strictEqual(result.ok, true, messages(result, 'BLOCKER'));
  assert.match(messages(result, 'WARN'), /no yourCurrentNamePattern/);
});
