'use strict';

const express = require('express');
const router = express.Router();
const { db, getSetting } = require('../db');
const { normalizeOffer } = require('../services/comparison');
const approvals = require('../services/approvals');
const auth = require('../services/auth');

function paging(req) {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Number(req.query.offset) || 0;
  return { limit, offset };
}

router.get('/offers', (req, res) => {
  const { limit, offset } = paging(req);
  const where = [];
  const params = [];
  if (req.query.supplier) { where.push('o.supplier_code = ?'); params.push(req.query.supplier); }
  if (req.query.status) { where.push('o.status = ?'); params.push(req.query.status); }
  if (req.query.approval) { where.push('o.approval_status = ?'); params.push(req.query.approval); }
  if (req.query.category) { where.push('o.category = ?'); params.push(req.query.category); }
  if (req.query.q) {
    where.push('(o.description LIKE ? OR o.gtin_source LIKE ? OR o.internal_sku LIKE ?)');
    const like = '%' + req.query.q + '%';
    params.push(like, like, like);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM offers o ${whereSql}`).get(...params).n;
  const rows = db.prepare(
    `SELECT o.*, s.name AS supplier_name FROM offers o
     LEFT JOIN suppliers s ON s.code = o.supplier_code
     ${whereSql} ORDER BY o.id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  res.json({ total, limit, offset, rows, approvals: approvals.counts(), approvalRequired: approvals.approvalRequired() });
});

// GET /api/approvals/summary — how much is awaiting sign-off
router.get('/approvals/summary', (req, res) => {
  res.json({ ...approvals.counts(), required: approvals.approvalRequired() });
});

// POST /api/offers/:id/approve|reject|review — record a staff decision (buyer+)
router.post('/offers/:id/approve', auth.requireRole('buyer'), (req, res) => {
  const r = approvals.decide(req.params.id, 'approved', req.user.username, (req.body || {}).note);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

router.post('/offers/:id/reject', auth.requireRole('buyer'), (req, res) => {
  const r = approvals.decide(req.params.id, 'rejected', req.user.username, (req.body || {}).note);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

router.post('/offers/:id/submit', auth.requireRole('buyer'), (req, res) => {
  const r = approvals.decide(req.params.id, 'review', req.user.username, (req.body || {}).note);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

// POST /api/imports/:id/approve — sign off a whole uploaded list (buyer+)
router.post('/imports/:id/approve', auth.requireRole('buyer'), (req, res) => {
  const r = approvals.decideUpload(req.params.id, 'approved', req.user.username, (req.body || {}).note);
  res.json(r);
});

router.post('/imports/:id/reject', auth.requireRole('buyer'), (req, res) => {
  const r = approvals.decideUpload(req.params.id, 'rejected', req.user.username, (req.body || {}).note);
  res.json(r);
});

router.get('/offers/:id', (req, res) => {
  const row = db.prepare(
    `SELECT o.*, s.name AS supplier_name, s.default_discount_pct FROM offers o
     LEFT JOIN suppliers s ON s.code = o.supplier_code WHERE o.id = ?`
  ).get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  row.normalized = normalizeOffer(row, getSetting('base_currency', 'USD'));
  res.json(row);
});

router.get('/categories', (req, res) => {
  res.json(db.prepare('SELECT category, COUNT(*) n FROM offers WHERE category IS NOT NULL AND category <> \'\' GROUP BY category ORDER BY n DESC').all());
});

module.exports = router;
