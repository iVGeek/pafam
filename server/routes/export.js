'use strict';

const express = require('express');
const router = express.Router();
const reporting = require('../services/reporting');
const analytics = require('../services/analytics');
const template = require('../services/template');
const placements = require('../services/placements');
const pdf = require('../services/pdf');
const XLSX = require('xlsx');

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF_TYPE = 'application/pdf';

// Every export exists in both Excel and PDF: "/export/quote/4.xlsx" and
// "/export/quote/4.pdf" return the same document in two formats.
function splitFormat(value, fallback) {
  const raw = String(value || '');
  if (/\.pdf$/i.test(raw)) return { id: raw.replace(/\.pdf$/i, ''), format: 'pdf' };
  if (/\.xlsx$/i.test(raw)) return { id: raw.replace(/\.xlsx$/i, ''), format: 'xlsx' };
  return { id: raw, format: fallback || 'xlsx' };
}

function send(res, buffer, filename, format) {
  if (format === 'pdf') {
    res.setHeader('Content-Type', PDF_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/\.xlsx$/i, '.pdf')}"`);
    return res.send(buffer);
  }
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/\.pdf$/i, '.xlsx')}"`);
  return res.send(buffer);
}

// GET /api/reports — supplier performance + win mix + overview for the page.
router.get('/reports', (req, res) => {
  res.json({ overview: analytics.overview(), suppliers: analytics.supplierStats(), wins: analytics.winsByType() });
});

// GET /api/integrations — machine-readable contract for the exports and the
// inbound capture webhook, so accounting / WMS / lab systems can wire up.
router.get('/integrations', (req, res) => {
  const base = req.protocol + '://' + req.get('host') + '/api';
  const formats = ['.xlsx', '.pdf'];
  res.json({
    exports: Object.keys(reporting.BUILDERS).map((kind) => ({
      kind,
      method: 'GET',
      url: `${base}/export/${kind}.xlsx`,
      urlPdf: `${base}/export/${kind}.pdf`,
      format: XLSX_TYPE,
      formatPdf: PDF_TYPE,
      auth: 'session cookie (viewer+)',
    })),
    quote: { method: 'GET', url: `${base}/export/quote/:id.xlsx`, urlPdf: `${base}/export/quote/:id.pdf`, auth: 'session cookie (viewer+)', note: 'cost-masked, customer-facing' },
    cleanedImport: {
      method: 'GET',
      url: `${base}/export/cleaned/:uploadId.xlsx`,
      urlPdf: `${base}/export/cleaned/:uploadId.pdf`,
      auth: 'session cookie (viewer+)',
      note: 'the standard-template snapshot auto-generated for each import',
    },
    placement: {
      method: 'GET',
      url: `${base}/export/placement/:id.xlsx`,
      urlPdf: `${base}/export/placement/:id.pdf`,
      auth: 'session cookie (viewer+)',
      note: 'supplier-facing order placement: cost price and full-box quantities',
    },
    adhoc: {
      method: 'POST',
      url: `${base}/export/table?format=pdf`,
      auth: 'session cookie (viewer+)',
      body: { title: 'string', columns: ['string'], rows: [[ 'any' ]], meta: [['Label', 'value']] },
      note: 'render any table (e.g. the screen you are looking at) as Excel or PDF',
    },
    formats,
    webhook: {
      method: 'POST',
      url: `${base}/captures/webhook`,
      auth: 'X-Capture-Secret header (set capture_secret in Settings)',
      body: { source: 'string (e.g. lab, forwarder)', reference: 'string', payload: 'object' },
      note: 'Public endpoint; unauthenticated requests are rejected unless the shared secret matches.',
    },
  });
});

// GET /api/export/table?format=xlsx|pdf  — render an ad-hoc grid (the screen
// you are looking at) as a downloadable document. Auth: session (viewer+).
router.post('/export/table', (req, res) => {
  const body = req.body || {};
  const format = String(req.query.format || body.format || 'xlsx').toLowerCase() === 'pdf' ? 'pdf' : 'xlsx';
  const columns = (Array.isArray(body.columns) ? body.columns : []).map((c) => String(c == null ? '' : c).slice(0, 80)).slice(0, 80);
  const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 20000).map((r) =>
    columns.map((_, i) => (Array.isArray(r) ? r[i] : (r && r[i]))));
  const meta = (Array.isArray(body.meta) ? body.meta : []).slice(0, 40)
    .map((p) => [String((p && p[0]) || '').slice(0, 60), String((p && p[1]) || '').slice(0, 400)]);
  const title = String(body.title || 'Export').slice(0, 120);
  const stamp = new Date().toISOString().slice(0, 10);
  const name = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'export';

  try {
    if (format === 'pdf') {
      const buffer = pdf.gridPdf(columns, rows, { title, meta, orientation: columns.length > 5 ? 'landscape' : 'portrait' });
      return buffer.then((buf) => send(res, buf, `${name}-${stamp}.pdf`, 'pdf'));
    }
    const ws = XLSX.utils.aoa_to_sheet([columns, ...rows]);
    ws['!cols'] = columns.map((c) => ({ wch: Math.min(40, Math.max(12, c.length + 4)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Export'.slice(0, 31));
    return send(res, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), `${name}-${stamp}.xlsx`, 'xlsx');
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// GET /api/export/quote/:id.xlsx|pdf — customer-facing, cost-masked quotation.
router.get('/export/quote/:id', async (req, res) => {
  const { id, format } = splitFormat(req.params.id);
  if (format === 'pdf') {
    const data = reporting.quoteRows(id);
    if (!data) return res.status(404).json({ error: 'quote not found' });
    const buffer = await pdf.gridPdf(
      ['Field', 'Value'],
      data.rows.filter((r) => String(r[0]).length).map((r) => [r[0], r[1] == null ? '' : r[1]]),
      { title: `Quote ${data.rows[1] ? data.rows[1][1] : ''}`.trim() || 'Customer quotation', orientation: 'portrait' }
    );
    return send(res, buffer, `${data.filename}.pdf`, 'pdf');
  }
  const buffer = reporting.quoteWorkbook(id);
  if (!buffer) return res.status(404).json({ error: 'quote not found' });
  return send(res, buffer, `ptp-quote-${id}.xlsx`, 'xlsx');
});

// GET /api/export/cleaned/:id.xlsx|pdf — the standard-template snapshot that
// is generated automatically after every import. Serves the stored snapshot if
// present, otherwise rebuilds it from the stored offers.
router.get('/export/cleaned/:id', async (req, res) => {
  const { id, format } = splitFormat(req.params.id);
  const key = isNaN(Number(id)) ? id : Number(id);
  if (format === 'pdf') {
    const grid = template.cleanedGrid(key);
    if (!grid) return res.status(404).json({ error: 'upload not found' });
    const buffer = await pdf.gridPdf(grid.header, grid.rows, {
      title: `Cleaned supplier list — ${grid.supplier || ''}`.trim(),
      orientation: 'landscape',
      notes: ['Standard supplier template. Blank cells are intentionally unfilled (not supplied).'],
    });
    return send(res, buffer, `${grid.filename}.pdf`, 'pdf');
  }
  const out = template.cleanedBuffer(key);
  if (!out) return res.status(404).json({ error: 'upload not found' });
  return send(res, out.buffer, out.filename, 'xlsx');
});

// GET /api/export/placement/:id.xlsx|pdf — supplier-facing order placement.
router.get('/export/placement/:id', async (req, res) => {
  const { id, format } = splitFormat(req.params.id);
  if (format === 'pdf') {
    const out = await placements.placementPdf(id);
    if (!out) return res.status(404).json({ error: 'placement not found' });
    return send(res, out.buffer, out.filename, 'pdf');
  }
  const out = placements.placementWorkbook(id);
  if (!out) return res.status(404).json({ error: 'placement not found' });
  return send(res, out.buffer, out.filename, 'xlsx');
});

// GET /api/export/:kind.xlsx|pdf  (viewer+ via global auth)
router.get('/export/:kind', async (req, res) => {
  const { id: kind, format } = splitFormat(req.params.kind);
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'pdf') {
    const sheet = reporting.sheetFor(kind);
    if (!sheet) return res.status(404).json({ error: 'unknown export', available: Object.keys(reporting.BUILDERS) });
    const buffer = await pdf.sheetPdf(
      { title: sheet.name || kind, columns: sheet.columns, rows: sheet.rows },
      { orientation: (sheet.columns || []).length > 5 ? 'landscape' : 'portrait' }
    );
    return send(res, buffer, `ptp-${kind}-${stamp}.pdf`, 'pdf');
  }
  const buffer = reporting.build(kind);
  if (!buffer) return res.status(404).json({ error: 'unknown export', available: Object.keys(reporting.BUILDERS) });
  return send(res, buffer, `ptp-${kind}-${stamp}.xlsx`, 'xlsx');
});

module.exports = router;
