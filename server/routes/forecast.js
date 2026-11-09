'use strict';

const express = require('express');
const router = express.Router();
const { forecastBaseline, backtest } = require('../services/forecast');

router.get('/forecast', (req, res) => {
  res.json(forecastBaseline({}));
});

// Walk-forward backtest (brief section 12). Viewer+.
router.get('/forecast/backtest', (req, res) => {
  res.json(backtest({ limit: req.query.limit }));
});

module.exports = router;
