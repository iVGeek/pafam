'use strict';

const express = require('express');
const router = express.Router();
const { db, getSetting } = require('../db');
const { normalizeOffer } = require('../services/comparison');

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
  res.json({ total, limit, offset, rows });
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
