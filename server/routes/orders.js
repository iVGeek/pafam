'use strict';

const express = require('express');
const router = express.Router();
const { audit } = require('../db');
const orders = require('../services/orders');
const auth = require('../services/auth');

router.get('/orders', (req, res) => {
  res.json(orders.listOrders(req.query.limit));
});

router.get('/orders/:id', (req, res) => {
  const o = orders.getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  res.json(o);
});

// Create an order (buyer+), optionally from a saved deal via quoteId.
router.post('/orders', auth.requireRole('buyer'), (req, res) => {
  const r = orders.createOrder(req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  audit(req.user ? req.user.username : 'user', 'order-create', 'order', r.id);
  res.json(r);
});

// Record a customer receipt (inbound) or supplier payment (outbound).
router.post('/orders/:id/payments', auth.requireRole('buyer'), (req, res) => {
  const r = orders.recordPayment(req.params.id, req.body || {});
  if (r.error) return res.status(r.error === 'order not found' ? 404 : 400).json({ error: r.error });
  audit(req.user ? req.user.username : 'user', 'payment-record', 'order', req.params.id,
    `${req.body.direction || 'inbound'} ${req.body.amount}`);
  res.json(r);
});

router.post('/orders/:id/status', auth.requireRole('buyer'), (req, res) => {
  const status = (req.body || {}).status;
  if (!status) return res.status(400).json({ error: 'status required' });
  res.json(orders.updateStatus(req.params.id, status));
});

module.exports = router;
