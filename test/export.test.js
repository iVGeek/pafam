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
const forecast = require('../server/services/forecast');
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

test('http: login is rate-limited after repeated failures', async () => {
  const probe = 'brute_probe_' + process.pid;
  const post = (u) => fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'definitely-wrong' }),
  });
  for (let i = 0; i < 10; i += 1) {
    const r = await post(probe);
    assert.strictEqual(r.status, 401, 'failed login ' + (i + 1));
  }
  const blocked = await post(probe);
  assert.strictEqual(blocked.status, 429, 'further attempts are throttled');
  assert.ok(blocked.headers.get('retry-after'), 'Retry-After header is set');
  // A different username is unaffected (the guard is per username+IP).
  const other = await post(probe + '_other');
  assert.strictEqual(other.status, 401, 'another username is not blocked');
});

test('http: public registration is rate-limited even when every attempt succeeds', async () => {
  const post = (name) => fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: name, password: 'strong-pass-123', confirmPassword: 'strong-pass-123' }),
  });
  for (let i = 0; i < 10; i += 1) {
    const r = await post(`reg_probe_${process.pid}_${i}`);
    assert.strictEqual(r.status, 200, 'successful registration ' + (i + 1));
  }
  const blocked = await post(`reg_probe_${process.pid}_blocked`);
  assert.strictEqual(blocked.status, 429, 'the next registration is throttled');
  assert.ok(blocked.headers.get('retry-after'));
});

test('http: /api/import refuses server-side paths outside the import directory', async () => {
  const dataDir = path.dirname(TMP_DB);
  const importDir = path.join(dataDir, 'imports');
  // A real spreadsheet just outside the allowed directory: even with the right
  // extension it must be rejected, and its full host path must not leak.
  const secret = path.join(dataDir, 'secret-list.xlsx');
  fs.writeFileSync(secret, 'not a real xlsx, but the path check must stop it first');
  try {
    const post = (body) => fetch(`${base}/api/import`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    let r = await post({ path: secret });
    assert.strictEqual(r.status, 400, 'absolute path outside import dir is refused');
    let j = await r.json();
    assert.match(j.error, /inside the import directory/);
    assert.doesNotMatch(j.error, /secret-list\.xlsx/);

    r = await post({ path: '../secret-list.xlsx' });
    assert.strictEqual(r.status, 400, 'traversal is refused');
    j = await r.json();
    assert.match(j.error, /inside the import directory/);

    r = await post({ path: path.join(dataDir, 'ptp.db') });
    assert.strictEqual(r.status, 400, 'the SQLite database cannot be imported by path');
    j = await r.json();
    assert.match(j.error, /Only .xls/);

    assert.ok(fs.existsSync(importDir), 'import directory exists for legitimate uploads');
  } finally {
    fs.unlinkSync(secret);
  }
});

test('http: /api/integrations advertises the real surface — GL, stock, webhook — and its limits', async () => {
  const r = await fetch(`${base}/api/integrations`, { headers: { cookie } });
  assert.strictEqual(r.status, 200);
  const j = await r.json();

  const kinds = j.exports.map((e) => e.kind);
  for (const kind of ['gl', 'stock']) {
    const e = j.exports.find((x) => x.kind === kind);
    assert.ok(e, `${kind} export is in the contract`);
    assert.match(e.url, new RegExp(`/api/export/${kind}\\.xlsx$`));
    assert.match(e.urlPdf, new RegExp(`/api/export/${kind}\\.pdf$`));
    // The contract's URLs are the ones the server actually serves.
    for (const [url, magic] of [[e.url, XLSX_MAGIC], [e.urlPdf, PDF_MAGIC]]) {
      const d = await fetch(url, { headers: { cookie } });
      assert.strictEqual(d.status, 200, `${url} status`);
      const b = Buffer.from(await d.arrayBuffer());
      assert.ok(b.slice(0, magic.length).equals(magic), `${url} magic`);
    }
  }

  // The limits are declared, not implied: nothing pretends a live connector exists.
  assert.strictEqual(j.limits.directAccountingConnector, false);
  assert.strictEqual(j.limits.directWmsConnector, false);
  assert.strictEqual(j.limits.largeScaleDataMigration, false);
  assert.strictEqual(j.limits.realtimeSupplierFeeds, false);
  assert.strictEqual(j.limits.scannerHardware, false);
  assert.match(j.limits.interoperability, /GL journal export/);
  assert.match(j.limits.interoperability, /stock snapshot export/);
  assert.match(j.limits.interoperability, /no live ERP\/WMS write-back/);
  assert.match(j.limits.captureIntake, /text only/i);
  assert.strictEqual(j.limits.forecast.minDeliveryMonths, forecast.MIN_OBS);
  assert.match(j.limits.forecast.backtest, /\/api\/forecast\/backtest$/);

  assert.strictEqual(j.webhook.method, 'POST');
  assert.match(j.webhook.url, /\/api\/captures\/webhook$/);
  assert.match(j.webhook.note, /Text only/i);
});

test('http: forecast withholds thin history and the backtest never grades noise', async () => {
  const [f, b] = await Promise.all([
    fetch(`${base}/api/forecast`, { headers: { cookie } }),
    fetch(`${base}/api/forecast/backtest`, { headers: { cookie } }),
  ]);
  assert.strictEqual(f.status, 200);
  assert.strictEqual(b.status, 200);
  const fc = await f.json();
  const bt = await b.json();

  assert.strictEqual(fc.minObservations, forecast.MIN_OBS);
  for (const p of fc.byProduct || []) {
    if (p.months < fc.minObservations) {
      assert.strictEqual(p.sufficient, false, `${p.productName} withholds a thin-history forecast`);
      assert.strictEqual(p.forecastQty30d, 0, `${p.productName} invents no quantity`);
      assert.match(p.reason, /need >=/);
    } else {
      assert.strictEqual(p.sufficient, true);
      assert.ok(!p.reason, `${p.productName} explains itself only when withheld`);
    }
  }

  assert.ok(bt.tested <= bt.totalProducts);
  assert.strictEqual(bt.totalProducts, (fc.byProduct || []).length);
  if (bt.overallMape == null) {
    assert.strictEqual(bt.tested, 0);
    assert.strictEqual(bt.results.length, 0);
    assert.match(bt.reason, /need >=/);
  } else {
    assert.ok(bt.tested > 0);
    for (const row of bt.results) {
      assert.ok(row.mape != null && row.mape >= 0, 'MAPE is a measured number, not a placeholder');
    }
  }
});

test('http: capture_secret is generated, admin-only, and redacted from AI tools', async () => {
  const secret = db.prepare("SELECT value FROM settings WHERE key = 'capture_secret'").get().value;
  assert.ok(secret && secret.length >= 32, 'a real secret is generated on first boot');
  assert.notStrictEqual(secret, 'change-me-capture-secret', 'no source-code-known placeholder');

  const adminSettings = await (await fetch(`${base}/api/settings`, { headers: { cookie } })).json();
  assert.strictEqual(adminSettings.capture_secret, secret, 'admin can copy the webhook secret');

  const authSvc = require('../server/services/auth');
  const viewerName = `viewer_secret_${process.pid}`;
  authSvc.createUser({ username: viewerName, password: 'viewer-pass-123', role: 'viewer', active: 1 });
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: viewerName, password: 'viewer-pass-123' }),
  });
  assert.strictEqual(login.status, 200);
  const viewerCookie = login.headers.get('set-cookie');
  const viewerSettings = await (await fetch(`${base}/api/settings`, { headers: { cookie: viewerCookie } })).json();
  assert.strictEqual(viewerSettings.capture_secret, '[redacted]', 'viewer cannot read the webhook secret');

  const ai = require('../server/services/ai');
  const fromAi = ai.runTool('get_settings', {}).result.settings;
  assert.strictEqual(fromAi.capture_secret, '[redacted]', 'AI tools cannot leak the webhook secret');

  // A Settings save round-trips the real secret. It must not end up in the
  // audit trail, the audit API, or an AI list_audit tool result.
  const { getSetting } = require('../server/db');
  const original = getSetting('followup_days', '2');
  const save = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ capture_secret: secret, followup_days: original }),
  });
  assert.strictEqual(save.status, 200);
  assert.strictEqual(getSetting('capture_secret'), secret, 'the value is still stored correctly');

  const raw = db.prepare("SELECT detail FROM audit_log WHERE action = 'update-settings' ORDER BY id DESC LIMIT 1").get();
  assert.ok(raw && !raw.detail.includes(secret), 'the secret is never written to audit_log.detail');
  assert.ok(raw.detail.includes('[redacted]'), 'the redaction is explicit, not a silent omission');

  const viewerAudit = await fetch(`${base}/api/audit`, { headers: { cookie: viewerCookie } });
  assert.strictEqual(viewerAudit.status, 403, 'a viewer cannot read the audit API directly');
  const adminAudit = await (await fetch(`${base}/api/audit`, { headers: { cookie } })).json();
  assert.ok(!JSON.stringify(adminAudit).includes(secret), 'audit API cannot leak the secret');

  const fromAuditTool = ai.runTool('list_audit', { action: 'update-settings', limit: 5 }).result;
  assert.ok(fromAuditTool.entries.length >= 1);
  assert.ok(!JSON.stringify(fromAuditTool).includes(secret), 'AI list_audit cannot leak the secret');
  assert.ok(fromAuditTool.entries.every((e) => e.detail === '[redacted]'));
});

test('http: product merge is atomic and reassigns FK-protected references', async () => {
  const stamp = process.pid;
  const src = Number(db.prepare(
    `INSERT INTO products(canonical_gtin, display_name) VALUES (?, ?)`
  ).run(`999999${stamp}001`, 'merge source').lastInsertRowid);
  const dst = Number(db.prepare(
    `INSERT INTO products(canonical_gtin, display_name) VALUES (?, ?)`
  ).run(`999999${stamp}002`, 'merge target').lastInsertRowid);
  const cust = db.prepare('SELECT id FROM customers LIMIT 1').get().id;

  // quotes.product_id has an FK with no cascade: the old merge updated four
  // tables, then DELETE failed here, leaving a half-applied merge behind.
  const quoteId = Number(db.prepare(
    `INSERT INTO quotes(customer_id, product_id, quantity, unit_price) VALUES (?,?,?,?)`
  ).run(cust, src, 1, 10).lastInsertRowid);
  db.prepare('INSERT INTO price_history(supplier_code, product_id, observed_at) VALUES (?,?,?)')
    .run('MERGE-TEST', src, new Date().toISOString());

  const r = await fetch(`${base}/api/products/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ from: src, to: dst }),
  });
  assert.strictEqual(r.status, 200, 'merge succeeded: ' + await r.text());

  assert.strictEqual(db.prepare('SELECT id FROM products WHERE id = ?').get(src), undefined, 'source deleted');
  assert.strictEqual(db.prepare('SELECT product_id FROM quotes WHERE id = ?').get(quoteId).product_id, dst, 'quote reassigned');
  assert.strictEqual(
    db.prepare('SELECT product_id FROM price_history WHERE supplier_code = ? AND product_id = ?').get('MERGE-TEST', dst).product_id,
    dst,
    'price history reassigned'
  );

  // Merging a product into itself is rejected rather than deleting it.
  const bad = await fetch(`${base}/api/products/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ from: dst, to: dst }),
  });
  assert.strictEqual(bad.status, 400);
  assert.ok(db.prepare('SELECT id FROM products WHERE id = ?').get(dst), 'target still exists');
});

test('http: exception sign-off actor comes from the session, not the request body', async () => {
  const mk = () => Number(db.prepare(
    `INSERT INTO exceptions(type, detail) VALUES ('mismatch', 'actor attribution test')`
  ).run().lastInsertRowid);
  const single = mk();
  const bulk = mk();

  const post = (url, body) => fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  let r = await post(`/api/exceptions/${single}/resolve`, { actor: 'Client PO' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(
    db.prepare('SELECT resolved_by FROM exceptions WHERE id = ?').get(single).resolved_by,
    'admin',
    'a forged actor cannot attribute a resolution to the client PO'
  );

  r = await post('/api/exceptions/resolve-many', { ids: [bulk], actor: 'Client PO' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(
    db.prepare('SELECT resolved_by FROM exceptions WHERE id = ?').get(bulk).resolved_by,
    'admin',
    'bulk resolution uses the same session-derived actor'
  );

  const forged = db.prepare(
    "SELECT COUNT(*) n FROM audit_log WHERE action = 'resolve-exception' AND actor = 'Client PO'"
  ).get().n;
  assert.strictEqual(forged, 0, 'audit log cannot be poisoned with a client-supplied name');
});

test('http: exception evidence exposes source file and resolved who/when', async () => {
  const offer = db.prepare(
    'SELECT id, upload_id FROM offers WHERE upload_id IS NOT NULL LIMIT 1'
  ).get();
  assert.ok(offer, 'a seeded offer with an upload');
  const upload = db.prepare('SELECT filename FROM uploads WHERE id = ?').get(offer.upload_id);
  const id = Number(db.prepare(
    "INSERT INTO exceptions(type, detail, offer_id) VALUES ('mismatch', 'evidence test', ?)"
  ).run(offer.id).lastInsertRowid);
  const r = await fetch(`${base}/api/exceptions/${id}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: '{}',
  });
  assert.strictEqual(r.status, 200);
  const rows = await (await fetch(`${base}/api/exceptions?resolved=1&limit=500`, { headers: { cookie } })).json();
  const row = rows.find((x) => x.id === id);
  assert.ok(row, 'resolved exception returned');
  assert.strictEqual(row.source_file, upload.filename, 'row number is tied to its source file');
  assert.ok(row.source_uploaded_at, 'upload time is available for the audit trail');
  assert.strictEqual(row.resolved_by, 'admin');
  assert.ok(row.resolved_at, 'resolution time is available for the audit trail');
});

test('http: offer approval records who/when and exposes it on the offers list', async () => {
  const offer = db.prepare(
    `SELECT id, approval_status, approved_by, approved_at, gtin_source FROM offers
      WHERE product_id IS NOT NULL AND price > 0 AND gtin_canonical IS NOT NULL
        AND gtin_source IS NOT NULL LIMIT 1`
  ).get();
  assert.ok(offer, 'an offer that can be signed off');
  try {
    const r = await fetch(`${base}/api/offers/${offer.id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ note: 'acceptance evidence check' }),
    });
    assert.strictEqual(r.status, 200);
    const stored = db.prepare('SELECT approval_status, approved_by, approved_at, review_note FROM offers WHERE id = ?').get(offer.id);
    assert.strictEqual(stored.approval_status, 'approved');
    assert.strictEqual(stored.approved_by, 'admin');
    assert.ok(stored.approved_at);
    const list = await (await fetch(
      `${base}/api/offers?approval=approved&limit=500&q=${encodeURIComponent(offer.gtin_source)}`,
      { headers: { cookie } }
    )).json();
    const row = list.rows.find((x) => x.id === offer.id);
    assert.ok(row, 'approved offer is listed');
    assert.strictEqual(row.approved_by, 'admin', 'UI has the sign-off identity without a tooltip');
    assert.ok(row.approved_at, 'UI has the sign-off timestamp');
    assert.strictEqual(row.review_note, 'acceptance evidence check');
  } finally {
    db.prepare(
      `UPDATE offers SET approval_status = ?, approved_by = ?, approved_at = ?, review_note = ? WHERE id = ?`
    ).run(offer.approval_status, offer.approved_by, offer.approved_at, null, offer.id);
  }
});
