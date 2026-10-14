'use strict';

const express = require('express');
const router = express.Router();
const reporting = require('../services/reporting');
const analytics = require('../services/analytics');

// GET /api/reports  — supplier performance + win mix + overview for the page.
router.get('/reports', (req, res) => {
  res.json({ overview: analytics.overview(), suppliers: analytics.supplierStats(), wins: analytics.winsByType() });
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
