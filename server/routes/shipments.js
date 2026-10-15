'use strict';

const express = require('express');
const router = express.Router();
const shipments = require('../services/shipments');
const auth = require('../services/auth');

const actor = (req) => (req.user ? req.user.username : 'user');

// GET /api/shipments/drivers  — the documented allocation bases we accept
router.get('/shipments/drivers', (req, res) => {
  res.json(shipments.drivers());
});

// GET /api/shipments  — shipments with allocated totals + reconciliation flag
router.get('/shipments', (req, res) => {
  res.json(shipments.list({ status: req.query.status, direction: req.query.direction, limit: req.query.limit }));
});

// GET /api/shipments/:id  — shipment + its allocations + reconciliation report
router.get('/shipments/:id', (req, res) => {
  const r = shipments.reconcile(req.params.id);
  if (r.error) return res.status(404).json(r);
  res.json(r);
});

// POST /api/shipments  — declare a shipment and its lines (analyst+)
router.post('/shipments', auth.requireRole('analyst'), (req, res) => {
  const r = shipments.createShipment({ ...(req.body || {}), createdBy: actor(req) });
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

// POST /api/shipments/:id/allocate  — split the cost by the declared driver (analyst+)
router.post('/shipments/:id/allocate', auth.requireRole('analyst'), (req, res) => {
  const r = shipments.allocate(req.params.id, actor(req));
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

module.exports = router;