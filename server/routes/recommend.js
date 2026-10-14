'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../services/auth');
const recommend = require('../services/recommend');

// Buying recommendations: match open customer demand to the cheapest
// executable supplier and price it against policy (brief section 10 / 4.6).
router.get('/recommendations', (req, res) => {
  const rows = recommend.recommendations({
    limit: req.query.limit,
    actionableOnly: req.query.actionable === '1' || req.query.actionable === 'true',
    destination: req.query.destination,
  });
  const summary = {
    count: rows.length,
    actionable: rows.filter((r) => r.actionable).length,
    totalContribution: Math.round(rows.reduce((s, r) => s + (r.contribution || 0), 0) * 100) / 100,
    totalCapital: Math.round(rows.reduce((s, r) => s + (r.cashRequirement || 0), 0) * 100) / 100,
  };
  res.json({ rows, summary });
});

router.get('/recommendations/:productId', (req, res) => {
  const rec = recommend.recommendationFor(Number(req.params.productId), { destination: req.query.destination });
  if (!rec) return res.status(404).json({ error: 'no open demand for product' });
  res.json(rec);
});

module.exports = router;
