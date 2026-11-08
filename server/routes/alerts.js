'use strict';

const express = require('express');
const router = express.Router();
const alerts = require('../services/alerts');
const trends = require('../services/trends');
const auth = require('../services/auth');

// ---- Alerts ----
router.get('/alerts', (req, res) => {
  const rows = alerts.listAlerts({
    unreadOnly: req.query.unread === '1',
    limit: req.query.limit,
  });
  res.json({ rows, counts: alerts.counts() });
});

// Scan the catalogue and raise any new alerts (buyer+).
router.post('/alerts/refresh', auth.requireRole('buyer'), (req, res) => {
  res.json(alerts.generateAlerts({ actor: req.user ? req.user.username : 'user' }));
});

// Per-brand/SKU thresholds (brief section 13). Admin-only writes.
const alertThresholds = require('../services/alertThresholds');
router.get('/alert-thresholds', (req, res) => {
  res.json({ rows: alertThresholds.list(), scopes: alertThresholds.SCOPES });
});
router.post('/alert-thresholds', auth.requireRole('admin'), (req, res) => {
  const r = alertThresholds.setThreshold({ ...(req.body || {}), actor: req.user.username });
  if (r.error) return res.status(400).json(r);
  res.json(r);
});
router.delete('/alert-thresholds/:id', auth.requireRole('admin'), (req, res) => {
  res.json(alertThresholds.removeThreshold(Number(req.params.id), req.user.username));
});

router.post('/alerts/read-all', (req, res) => res.json(alerts.markAllRead()));

router.post('/alerts/:id/read', (req, res) => res.json(alerts.markRead(req.params.id)));

// ---- Price trends ----
router.get('/trends', (req, res) => {
  if (req.query.productId) {
    const id = Number(req.query.productId);
    const rows = trends.productTrends(id);
    const series = trends.productSeries(id);
    return res.json({ productId: id, rows, series });
  }
  const rows = trends.allTrends({ onlyChanged: req.query.changed === '1' });
  res.json({ rows: rows.slice(0, Math.min(Number(req.query.limit) || 100, 1000)) });
});

module.exports = router;
