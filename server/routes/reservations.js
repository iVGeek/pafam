'use strict';

const express = require('express');
const router = express.Router();
const reservations = require('../services/reservations');
const auth = require('../services/auth');

const actor = (req) => (req.user ? req.user.username : 'user');

// GET /api/reservations  — active and historical reservations with availability
router.get('/reservations', (req, res) => {
  res.json({
    rows: reservations.list({
      lotId: req.query.lotId,
      demandId: req.query.demandId,
      status: req.query.status,
      limit: req.query.limit,
    }),
    lots: reservations.lotAvailability(),
  });
});

// GET /api/inventory/availability — per-lot usable / reserved / available
router.get('/inventory/availability', (req, res) => {
  res.json(reservations.lotAvailability());
});

// POST /api/reservations  — hold stock for a demand or order (buyer+)
router.post('/reservations', auth.requireRole('buyer'), (req, res) => {
  const b = req.body || {};
  const r = reservations.reserve({ ...b, actor: actor(req) });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

// POST /api/reservations/:id/release — free the stock again (buyer+)
router.post('/reservations/:id/release', auth.requireRole('buyer'), (req, res) => {
  const r = reservations.release(req.params.id, actor(req));
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

// POST /api/reservations/:id/fulfil — ship the stock: reservation consumed and
// the lot's on-hand reduced accordingly (buyer+)
router.post('/reservations/:id/fulfil', auth.requireRole('buyer'), (req, res) => {
  const r = reservations.fulfil(req.params.id, actor(req));
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

module.exports = router;