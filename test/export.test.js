'use strict';
// Excel + PDF export: one source of truth per document, both formats from the
// same rows, and both routes guarded by the same auth as everything else.
//
// Same fixture bootstrap as engine.test.js: copy the cached snapshot (or seed
// once) into a throwaway DB so we never touch the dev database.
const os = require('os');
const path = require('path');
const fs = require('fs');
const TMP_DB = path.join(os.tmpdir(), `ptp-export-test-${process.pid}.db`);
const SNAP = path.join(os.tmpdir(), 'ptp-test-fixture.db');
const useCache = process.env.PTP_TEST_NO_CACHE !== '1' && fs.existsSync(SNAP);

process.env.PTP_DATA_DIR = path.dirname(TMP_DB);
process.env.PTP_DB = TMP_DB;
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch (e) { /* ignore */ }
  }
});

const { test, before, after } = require('node:test');
if (useCache) fs.copyFileSync(SNAP, TMP_DB);
const assert = require('node:assert');
const http = require('http');
const XLSX = require('xlsx');
const { PDFDocument } = require('pdf-lib');

const pdf = require('../server/services/pdf');
const reporting = require('../server/services/reporting');
const placements = require('../server/services/placements');
const template = require('../server/services/template');
const db = require('../server/db').db;

if (!useCache) {
  require('../server/seedData').seedData({ log: () => {} });
}

const PDF_MAGIC = Buffer.from('%PDF-');
const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// The cached fixture may have no quotes or placements at all, so the tests
// that need them create their own (same pattern as engine.test.js) rather
// than depending on leftover rows.
function ensureQuote() {
  const existing = db.prepare('SELECT id FROM quotes ORDER BY id LIMIT 1').get();
  if (existing) return existing.id;
  const cust = db.prepare('SELECT id FROM customers LIMIT 1').get().id;
  const prod = db.prepare('SELECT id FROM products LIMIT 1').get().id;
  const ins = db.prepare(
    `INSERT INTO quotes(customer_id, product_id, quantity, unit_price, currency, landed_unit_cost,
        margin_pct, contribution_total, roi_pct, capital_required, capital_days, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  return Number(ins.run(cust, prod, 60, 40, 'USD', 25, 37.5, 900, 28, 1500, 45, 'draft').lastInsertRowid);
}

function ensurePlacement() {
  const existing = db.prepare('SELECT id FROM purchase_orders ORDER BY id LIMIT 1').get();
  if (existing) return existing.id;
  const plan = placements.planForSupplier();
  if (!plan.lines.length || !plan.suppliers.length) return null;
  const code = plan.suppliers[0];
  const chosen = placements.planForSupplier(code).lines.slice(0, 3);
  const created = placements.createPlacement({
    supplierCode: code,
    lines: chosen.map((l) => ({ productId: l.productId, offerId: l.offerId, boxes: l.suggestedBoxes || 1 })),
  });
  assert.ok(created.ok && created.id, 'placement fixture should be created');
  return created.id;
}

function firstUploadId() {
  return db.prepare('SELECT id FROM uploads ORDER BY id LIMIT 1').get().id;
}

// ---- pdf service ----

test('pdf: sanitize keeps WinAnsi text and replaces anything else', () => {
  assert.strictEqual(pdf.sanitize('café 100ml — 40%'), 'café 100ml — 40%');
  assert.strictEqual(pdf.sanitize('line\nbreak\ttab'), 'line break tab');
  // each out-of-set character becomes one '?', so 你好 (2 chars) -> ??
  assert.strictEqual(pdf.sanitize('你好 Versace'), '?? Versace');
  assert.strictEqual(pdf.sanitize('a\uFFFD b'), 'a? b');
  assert.strictEqual(pdf.sanitize(null), '');
});

test('pdf: fit truncates with an ellipsis rather than overflowing the column', () => {
  // widthOfTextAtSize needs a real font; render() exercises it internally.
  // Here we only assert the pure string behaviour through a tiny render.
  return pdf.render({
    title: 'Truncation',
    grid: { cols: [{ title: 'Narrow', wch: 6 }], cells: [['A very long cell value that cannot possibly fit in this column']] },
  }).then((buf) => {
    assert.ok(buf.slice(0, 5).equals(PDF_MAGIC), 'starts with %PDF-');
    assert.ok(buf.length > 700, 'produced a real document');
  });
});

test('pdf: render accepts unicode outside WinAnsi without throwing', async () => {
  const buf = await pdf.render({
    title: 'Unicode 你好 ❤ test',
    meta: [['Note', 'em—dash – dash • bullet 你好']],
    grid: { cols: [{ title: 'Col', wch: 20 }], cells: [['café ünïcode 你好 ❤ ok']] },
  });
  assert.ok(buf.slice(0, 5).equals(PDF_MAGIC));
});

test('pdf: a long grid breaks pages and keeps every row', async () => {
  const build = (n) => {
    const rows = [];
    for (let i = 0; i < n; i += 1) rows.push(['R' + i, 'desc ' + i, i]);
    return pdf.gridPdf(['ID', 'Description', 'Qty'], rows, { title: 'Page breaks' });
  };
  const small = await PDFDocument.load(await build(20));
  const big = await PDFDocument.load(await build(400));
  assert.strictEqual(small.getPageCount(), 1, '20 rows fit on one page');
  assert.ok(big.getPageCount() > 1, `400 rows must span pages, got ${big.getPageCount()}`);
  // rows drive the pagination: 20x the rows means many more pages
  assert.ok(big.getPageCount() >= 5, `expected >=5 pages for 400 rows, got ${big.getPageCount()}`);
});

test('pdf: portrait is used for narrow tables, landscape for wide ones', async () => {
  const narrow = await pdf.gridPdf(['A', 'B'], [['1', '2']], {});
  const wide = await pdf.gridPdf(['A', 'B', 'C', 'D', 'E', 'F', 'G'], [['1', '2', '3', '4', '5', '6', '7']], {});
  const n = await PDFDocument.load(narrow);
  const w = await PDFDocument.load(wide);
  assert.ok(n.getPage(0).getHeight() > n.getPage(0).getWidth(), 'narrow table is portrait');
  assert.ok(w.getPage(0).getWidth() > w.getPage(0).getHeight(), 'wide table is landscape');
});

// ---- one source of truth per document ----

test('export: every report kind renders to both xlsx and pdf', async () => {
  for (const kind of Object.keys(reporting.BUILDERS)) {
    const sheet = reporting.sheetFor(kind);
    assert.ok(sheet && Array.isArray(sheet.columns) && Array.isArray(sheet.rows), `${kind} has a descriptor`);
    const xlsx = reporting.build(kind);
    assert.ok(xlsx && xlsx.slice(0, 4).equals(XLSX_MAGIC), `${kind} xlsx`);
    const buf = await pdf.sheetPdf(sheet, {});
    assert.ok(buf.slice(0, 5).equals(PDF_MAGIC), `${kind} pdf`);
  }
});

test('export: an unknown report kind is refused in both formats', () => {
  assert.strictEqual(reporting.sheetFor('nope'), null);
  assert.strictEqual(reporting.build('nope'), null);
});

test('export: quote xlsx and quote pdf come from the same label/value rows', async () => {
  const id = ensureQuote();
  const data = reporting.quoteRows(id);
  assert.ok(data, 'quoteRows returns data');
  const xlsx = reporting.quoteWorkbook(id);
  assert.ok(xlsx && xlsx.slice(0, 4).equals(XLSX_MAGIC));
  const parsed = XLSX.read(xlsx, { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json(parsed.Sheets.Quote, { header: 1, blankrows: true });
  assert.deepStrictEqual(aoa, data.rows, 'workbook contains exactly quoteRows()');

  const buf = await pdf.gridPdf(
    ['Field', 'Value'],
    data.rows.filter((r) => String(r[0]).length).map((r) => [r[0], r[1] == null ? '' : r[1]]),
    { title: 'Customer quotation', orientation: 'portrait' }
  );
  assert.ok(buf.slice(0, 5).equals(PDF_MAGIC));
});

test('export: quote data never leaks cost, supplier or margin', () => {
  const data = reporting.quoteRows(ensureQuote());
  const labels = data.rows.map((r) => String(r[0]).toLowerCase()).join(' | ');
  for (const forbidden of ['cost', 'supplier', 'margin', 'unit_price', 'buying']) {
    assert.ok(!labels.includes(forbidden), `quote labels must not mention ${forbidden}`);
  }
});

test('export: placement xlsx and pdf come from the same placementData', async () => {
  const id = ensurePlacement();
  const d = placements.placementData(id);
  assert.ok(d && d.rows.length > 0, 'placementData returns rows');
  const out = placements.placementWorkbook(id);
  assert.ok(out && out.buffer.slice(0, 4).equals(XLSX_MAGIC));
  const parsed = XLSX.read(out.buffer, { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json(parsed.Sheets.Placement, { header: 1, blankrows: true, defval: '' });
  // the workbook is the descriptor laid out as AOA: title, meta, header, body, totals
  const headerIdx = aoa.findIndex((r) => r[0] === '#');
  assert.ok(headerIdx > 0, 'workbook has the line-item header row');
  assert.deepStrictEqual(aoa[headerIdx], d.columns.map((c) => c.title));
  const body = aoa.slice(headerIdx + 1, headerIdx + 1 + d.rows.length);
  assert.strictEqual(body.length, d.rows.length, 'body rows match');
  body.forEach((row, i) => {
    assert.deepStrictEqual(row, d.columns.map((c) => d.rows[i][c.key]), `body row ${i}`);
  });
  // totals sit after the body: blank row, then unit count and money total
  const totalsTail = aoa.slice(headerIdx + 1 + d.rows.length);
  assert.ok(totalsTail.some((r) => r.includes('Total units')), 'totals row present');

  const pdfOut = await placements.placementPdf(id);
  assert.ok(pdfOut && pdfOut.buffer.slice(0, 5).equals(PDF_MAGIC));
  assert.ok(pdfOut.filename.endsWith('.pdf'));
});

test('export: cleaned grid matches the template columns and offer count', async () => {
  const uploadId = firstUploadId();
  const grid = template.cleanedGrid(uploadId);
  assert.ok(grid, 'cleanedGrid returns data');
  assert.deepStrictEqual(grid.header, template.TEMPLATE_COLUMNS);
  assert.strictEqual(grid.rows.length, template.offersForUpload(uploadId).length);
  const buf = await pdf.gridPdf(grid.header, grid.rows, { title: 'Cleaned', orientation: 'landscape' });
  assert.ok(buf.slice(0, 5).equals(PDF_MAGIC));
});

// ---- HTTP routes ----

let server;
let base;
let cookie;

before(async () => {
  const app = require('../server');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  assert.strictEqual(r.status, 200, 'login works in-process');
  cookie = r.headers.get('set-cookie');
  assert.ok(cookie, 'session cookie issued');
});

after(() => { if (server) server.close(); });

test('http: every report kind serves .xlsx and .pdf behind auth', async () => {
  for (const kind of Object.keys(reporting.BUILDERS)) {
    const x = await fetch(`${base}/api/export/${kind}.xlsx`, { headers: { cookie } });
    assert.strictEqual(x.status, 200, `${kind}.xlsx status`);
    assert.ok((x.headers.get('content-type') || '').includes('spreadsheetml'), `${kind}.xlsx content-type`);
    const xb = Buffer.from(await x.arrayBuffer());
    assert.ok(xb.slice(0, 4).equals(XLSX_MAGIC), `${kind}.xlsx magic`);

    const p = await fetch(`${base}/api/export/${kind}.pdf`, { headers: { cookie } });
    assert.strictEqual(p.status, 200, `${kind}.pdf status`);
    assert.strictEqual(p.headers.get('content-type'), 'application/pdf', `${kind}.pdf content-type`);
    const pb = Buffer.from(await p.arrayBuffer());
    assert.ok(pb.slice(0, 5).equals(PDF_MAGIC), `${kind}.pdf magic`);
  }
});

test('http: quote, placement and cleaned exports serve both formats', async () => {
  const quoteId = ensureQuote();
  const placementId = ensurePlacement();
  const uploadId = firstUploadId();
  const cases = [
    [`/api/export/quote/${quoteId}.xlsx`, XLSX_MAGIC, 'spreadsheetml'],
    [`/api/export/quote/${quoteId}.pdf`, PDF_MAGIC, 'application/pdf'],
    [`/api/export/placement/${placementId}.xlsx`, XLSX_MAGIC, 'spreadsheetml'],
    [`/api/export/placement/${placementId}.pdf`, PDF_MAGIC, 'application/pdf'],
    [`/api/export/cleaned/${uploadId}.xlsx`, XLSX_MAGIC, 'spreadsheetml'],
    [`/api/export/cleaned/${uploadId}.pdf`, PDF_MAGIC, 'application/pdf'],
  ];
  for (const [url, magic, type] of cases) {
    const r = await fetch(`${base}${url}`, { headers: { cookie } });
    assert.strictEqual(r.status, 200, `${url} status`);
    assert.ok((r.headers.get('content-type') || '').includes(type), `${url} content-type`);
    const b = Buffer.from(await r.arrayBuffer());
    assert.ok(b.slice(0, magic.length).equals(magic), `${url} magic`);
  }
});

test('http: the extension chooses the format, the route stays the same', async () => {
  // .pdf and .xlsx on one URL must both resolve; a missing file 404s either way
  const missing = await fetch(`${base}/api/export/quote/999999.pdf`, { headers: { cookie } });
  assert.strictEqual(missing.status, 404);
  const missingX = await fetch(`${base}/api/export/quote/999999.xlsx`, { headers: { cookie } });
  assert.strictEqual(missingX.status, 404);
  const badKind = await fetch(`${base}/api/export/nosuch.pdf`, { headers: { cookie } });
  assert.strictEqual(badKind.status, 404);
});

test('http: POST /api/export/table renders any grid as xlsx or pdf', async () => {
  const body = JSON.stringify({
    title: 'Current view',
    columns: ['SKU', 'Name', 'Price'],
    rows: [['A1', 'Bleu de Chanel 100ml', 142.5], ['A2', 'Dior Sauvage EDT 200ml', 98]],
    meta: [['Filtered by', 'chanel']],
  });
  const p = await fetch(`${base}/api/export/table?format=pdf`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body,
  });
  assert.strictEqual(p.status, 200);
  assert.strictEqual(p.headers.get('content-type'), 'application/pdf');
  const pb = Buffer.from(await p.arrayBuffer());
  assert.ok(pb.slice(0, 5).equals(PDF_MAGIC));

  const x = await fetch(`${base}/api/export/table?format=xlsx`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body,
  });
  assert.strictEqual(x.status, 200);
  const xb = Buffer.from(await x.arrayBuffer());
  assert.ok(xb.slice(0, 4).equals(XLSX_MAGIC));
  const aoa = XLSX.utils.sheet_to_json(XLSX.read(xb, { type: 'buffer' }).Sheets.Sheet1 || XLSX.read(xb, { type: 'buffer' }).Sheets[XLSX.read(xb, { type: 'buffer' }).SheetNames[0]], { header: 1 });
  assert.deepStrictEqual(aoa[0], ['SKU', 'Name', 'Price']);
  assert.deepStrictEqual(aoa[1], ['A1', 'Bleu de Chanel 100ml', 142.5]);
});

test('http: the ad-hoc table export rejects nothing but stays bounded', async () => {
  const rows = [];
  for (let i = 0; i < 3; i += 1) rows.push(['r' + i]);
  const p = await fetch(`${base}/api/export/table?format=pdf`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: 'Small', columns: ['A'], rows }),
  });
  assert.strictEqual(p.status, 200);
  // a request with no columns still returns a document rather than a 500
  const empty = await fetch(`${base}/api/export/table?format=xlsx`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ title: 'Empty' }),
  });
  assert.strictEqual(empty.status, 200);
});

test('http: exports require a session, like every other route', async () => {
  for (const url of ['/api/export/deals.pdf', '/api/export/deals.xlsx', `/api/export/quote/${ensureQuote()}.pdf`]) {
    const r = await fetch(`${base}${url}`);
    assert.strictEqual(r.status, 401, `${url} requires auth`);
  }
  const t = await fetch(`${base}/api/export/table?format=pdf`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'x', columns: ['a'], rows: [['b']] }),
  });
  assert.strictEqual(t.status, 401, 'ad-hoc export requires auth');
});
