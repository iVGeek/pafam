'use strict';

const express = require('express');
const router = express.Router();
const analytics = require('../services/analytics');

router.get('/kpis', (req, res) => {
  res.json(analytics.kpis({ approvedOnly: req.query.approvedOnly === '1' }));
});

module.exports = router;
