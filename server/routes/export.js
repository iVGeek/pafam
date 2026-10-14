'use strict';

const express = require('express');
const router = express.Router();
const reporting = require('../services/reporting');
const analytics = require('../services/analytics');

// GET /api/reports  — supplier performance + win mix + overview for the page.
router.get('/reports', (req, res) => {
  res.json({ overview: analytics.overview(), suppliers: analytics.supplierStats(), wins: analytics.winsByType() });
});

// GET /api/integrations — machine-readable contract for the exports and the
// inbound capture webhook, so accounting / WMS / lab systems can wire up.
router.get('/integrations', (req, res) => {
  const base = req.protocol + '://' + req.get('host') + '/api';
  res.json({
    exports: Object.keys(reporting.BUILDERS).map((kind) => ({
      kind,
      method: 'GET',
      url: `${base}/export/${kind}.xlsx`,
      format: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      auth: 'session cookie (viewer+)',
    })),
    quote: { method: 'GET', url: `${base}/export/quote/:id.xlsx`, auth: 'session cookie (viewer+)', note: 'cost-masked, customer-facing' },
    webhook: {
      method: 'POST',
      url: `${base}/captures/webhook`,
      auth: 'X-Capture-Secret header (set capture_secret in Settings)',
      body: { source: 'string (e.g. lab, forwarder)', reference: 'string', payload: 'object' },
      note: 'Public endpoint; unauthenticated requests are rejected unless the shared secret matches.',
    },
  });
});

// GET /api/export/quote/:id.xlsx — customer-facing, cost-masked quotation.
router.get('/export/quote/:id', (req, res) => {
  const id = String(req.params.id || '').replace(/\.xlsx$/i, '');
  const buffer = reporting.quoteWorkbook(id);
  if (!buffer) return res.status(404).json({ error: 'quote not found' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="ptp-quote-${id}.xlsx"`);
  res.send(buffer);
});

// GET /api/export/:kind.xlsx  (viewer+ via global auth)
router.get('/export/:kind', (req, res) => {
  let kind = String(req.params.kind || '').replace(/\.xlsx$/i, '');
  const buffer = reporting.build(kind);
  if (!buffer) return res.status(404).json({ error: 'unknown export', available: Object.keys(reporting.BUILDERS) });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="ptp-${kind}-${stamp}.xlsx"`);
  res.send(buffer);
});

module.exports = router;
