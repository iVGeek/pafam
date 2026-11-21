'use strict';

const express = require('express');
const router = express.Router();
const { db, getSetting, audit } = require('../db');
const { compareProduct } = require('../services/comparison');
const auth = require('../services/auth');

router.get('/products', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Number(req.query.offset) || 0;
  const where = [];
  const params = [];
  if (req.query.q) {
    where.push('(p.display_name LIKE ? OR p.canonical_gtin LIKE ? OR p.category LIKE ?)');
    const like = '%' + req.query.q + '%';
    params.push(like, like, like);
  }
  if (req.query.multi === '1') {
    where.push(`p.id IN (SELECT product_id FROM offers WHERE product_id IS NOT NULL GROUP BY product_id HAVING COUNT(DISTINCT supplier_code) > 1)`);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM products p ${whereSql}`).get(...params).n;
  const rows = db.prepare(
    `SELECT p.*,
       (SELECT COUNT(*) FROM offers o WHERE o.product_id = p.id) AS offer_count,
       (SELECT COUNT(DISTINCT supplier_code) FROM offers o WHERE o.product_id = p.id) AS supplier_count
     FROM products p ${whereSql}
     ORDER BY supplier_count DESC, offer_count DESC, p.id
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  res.json({ total, limit, offset, rows });
});

router.get('/products/:id', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  if (!product) return res.status(404).json({ error: 'not found' });
  res.json(product);
});

router.get('/products/:id/compare', (req, res) => {
  const id = Number(req.params.id);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!product) return res.status(404).json({ error: 'not found' });
  const result = compareProduct(id, { baseCurrency: req.query.base || getSetting('base_currency', 'USD') });
  res.json({ product, ...result });
});

// Quick "find cheapest" by barcode.
router.get('/compare', (req, res) => {
  const raw = req.query.gtin;
  if (!raw) return res.status(400).json({ error: 'gtin required' });
  const gtin = require('../../src/lib/gtin');
  const g = gtin.analyse(raw);
  const product = g.valid
    ? db.prepare('SELECT * FROM products WHERE canonical_gtin = ?').get(g.canonical14)
    : null;
  if (!product) return res.json({ found: false, query: raw, analysis: g });
  const result = compareProduct(product.id, { baseCurrency: req.query.base || getSetting('base_currency', 'USD') });
  res.json({ found: true, query: raw, analysis: g, product, ...result });
});

// Merge two products (dedupe resolution). Reassigns every reference to the
// source before deleting it, all in one transaction: several dependent tables
// have product_id FKs with no cascade (quotes/orders/purchase_order_lines), so
// leaving one behind made the DELETE fail *after* the other moves had committed
// — a half-merged product with no source row to retry against.
const MERGE_TABLES = [
  'offers', 'product_aliases', 'inventory_lots', 'demands',
  'quotes', 'orders', 'price_history', 'purchase_order_lines',
  'alerts', 'shipment_allocations',
];
router.post('/products/merge', auth.requireRole('admin'), (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const srcId = Number(from);
  const dstId = Number(to);
  if (!Number.isInteger(srcId) || !Number.isInteger(dstId)) {
    return res.status(400).json({ error: 'from and to must be product ids' });
  }
  if (srcId === dstId) return res.status(400).json({ error: 'from and to must be different products' });
  const src = db.prepare('SELECT * FROM products WHERE id = ?').get(srcId);
  const dst = db.prepare('SELECT * FROM products WHERE id = ?').get(dstId);
  if (!src || !dst) return res.status(404).json({ error: 'product not found' });

  try {
    db.exec('BEGIN IMMEDIATE');
    for (const table of MERGE_TABLES) {
      db.prepare(`UPDATE ${table} SET product_id = ? WHERE product_id = ?`).run(dstId, srcId);
    }
    db.prepare('DELETE FROM products WHERE id = ?').run(srcId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    return res.status(409).json({ error: 'merge failed; no changes applied: ' + e.message });
  }
  audit('user', 'merge-products', 'product', dstId, `merged ${srcId} -> ${dstId}`);
  res.json({ ok: true, merged: { from: srcId, to: dstId } });
});

module.exports = router;
