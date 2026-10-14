'use strict';

const express = require('express');
const router = express.Router();
const { consolidateDemands } = require('../services/purchasePlan');

router.get('/purchase-plan', (req, res) => {
  const plan = consolidateDemands({
    approvedOnly: req.query.approvedOnly,
    actionableOnly: false,
    destination: req.query.destination,
  });
  res.json(plan);
});

module.exports = router;
