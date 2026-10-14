'use strict';

const express = require('express');
const router = express.Router();
const { forecastBaseline } = require('../services/forecast');

router.get('/forecast', (req, res) => {
  res.json(forecastBaseline({}));
});

module.exports = router;
