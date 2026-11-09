'use strict';

const express = require('express');
const router = express.Router();
const analytics = require('../services/analytics');

router.get('/kpis', (req, res) => {
  res.json(analytics.kpis({ approvedOnly: req.query.approvedOnly === '1' }));
});

// Inventory aging buckets (brief section 18). Viewer+.
router.get('/aging', (req, res) => {
  res.json(require('../services/aging').agingReport({ limit: req.query.limit }));
});

// Customer trading KPIs (brief section 18).
router.get('/customer-kpis', (req, res) => {
  res.json(require('../services/customerKpis').customerKpis());
});

module.exports = router;
