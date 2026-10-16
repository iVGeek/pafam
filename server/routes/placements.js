'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../services/auth');
const placements = require('../services/placements');

const actor = (req) => (req.user ? req.user.username : 'user');

// Supplier order placements: cost price + full-box quantities, ready to send
// to a supplier. Read (viewer+), write (buyer+).
router.get('/placements', (req, res) => {
  res.json({ rows: placements.listPlacements(req.query.limit) });
});

// Auto-fill candidates from the purchase plan for one supplier (or all).
// Declared before /placements/:id so "plan" is not read as an id.
router.get('/placements/plan', (req, res) => {
  res.json(placements.planForSupplier(req.query.supplier ? String(req.query.supplier) : null));
});

router.get('/placements/:id', (req, res) => {
  const id = String(req.params.id || '').replace(/\.xlsx$/i, '');
  const p = placements.getPlacement(id);
  if (!p) return res.status(404).json({ error: 'placement not found' });
  res.json(p);
});

router.post('/placements', auth.requireRole('buyer'), (req, res) => {
  const out = placements.createPlacement(Object.assign({}, req.body || {}, { createdBy: actor(req) }));
  if (out.error) return res.status(400).json({ error: out.error });
  res.json(placements.getPlacement(out.id));
});

module.exports = router;
