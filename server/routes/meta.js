'use strict';

const express = require('express');
const router = express.Router();
const { db, getSetting, setSetting, audit } = require('../db');
const { listSuppliers } = require('../services/suppliers');
const fx = require('../services/fx');
const analytics = require('../services/analytics');
const auth = require('../services/auth');

router.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

router.get('/dashboard', (req, res) => {
  const opp = analytics.opportunities(15);
  res.json({
    overview: analytics.overview(),
    opportunities: opp.plausible,
    reviewItems: opp.review,
    supplierStats: analytics.supplierStats(),
    wins: analytics.winsByType(),
  });
});

router.get('/suppliers', (req, res) => res.json(listSuppliers()));

router.post('/suppliers/:code', auth.requireRole('admin'), (req, res) => {
  const code = req.params.code;
  const b = req.body || {};
  const current = db.prepare('SELECT * FROM suppliers WHERE code = ?').get(code);
  if (!current) return res.status(404).json({ error: 'supplier not found' });
  const numOr = (v, fallback) => (v === undefined ? fallback : (v === null || v === '' ? null : Number(v)));
  db.prepare(
    `UPDATE suppliers SET name = ?, currency = ?, incoterm = ?, incoterm_place = ?,
       price_type = ?, default_discount_pct = ?, stock_country = ?, payment_terms = ?, active = ?,
       origin_country = ?, duty_pct = ?, freight_per_unit = ?, insurance_pct = ?,
       brokerage_per_unit = ?, handling_per_unit = ?, other_tax_pct = ?, recoverable_tax_pct = ?
     WHERE code = ?`
  ).run(
    b.name != null ? b.name : current.name,
    b.currency != null ? b.currency : current.currency,
    b.incoterm !== undefined ? b.incoterm : current.incoterm,
    b.incotermPlace !== undefined ? b.incotermPlace : current.incoterm_place,
    b.priceType != null ? b.priceType : current.price_type,
    b.defaultDiscount != null ? Number(b.defaultDiscount) : current.default_discount_pct,
    b.stockCountry !== undefined ? b.stockCountry : current.stock_country,
    b.paymentTerms !== undefined ? b.paymentTerms : current.payment_terms,
    b.active != null ? (b.active ? 1 : 0) : current.active,
    b.originCountry !== undefined ? b.originCountry : current.origin_country,
    numOr(b.dutyPct, current.duty_pct),
    numOr(b.freightPerUnit, current.freight_per_unit),
    numOr(b.insurancePct, current.insurance_pct),
    numOr(b.brokeragePerUnit, current.brokerage_per_unit),
    numOr(b.handlingPerUnit, current.handling_per_unit),
    numOr(b.otherTaxPct, current.other_tax_pct),
    numOr(b.recoverableTaxPct, current.recoverable_tax_pct),
    code
  );
  audit('user', 'update-supplier', 'supplier', code, JSON.stringify(b));
  res.json(db.prepare('SELECT * FROM suppliers WHERE code = ?').get(code));
});

router.get('/uploads', (req, res) => {
  res.json(db.prepare('SELECT * FROM uploads ORDER BY uploaded_at DESC').all());
});

router.get('/exceptions', (req, res) => {
  const resolved = req.query.resolved === '1' ? 1 : 0;
  const supplier = req.query.supplier;
  let sql = `SELECT e.*, o.description, o.gtin_source, o.source_row, o.supplier_code
             FROM exceptions e LEFT JOIN offers o ON o.id = e.offer_id
             WHERE e.resolved = ?`;
  const params = [resolved];
  if (supplier) { sql += ' AND o.supplier_code = ?'; params.push(supplier); }
  sql += ' ORDER BY e.created_at DESC LIMIT 500';
  res.json(db.prepare(sql).all(...params));
});

router.post('/exceptions/:id/resolve', auth.requireRole('analyst'), (req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE exceptions SET resolved = 1, resolved_by = ?, resolved_at = datetime(\'now\') WHERE id = ?')
    .run(req.body && req.body.actor || 'user', id);
  audit(req.body && req.body.actor || 'user', 'resolve-exception', 'exception', id);
  res.json({ ok: true });
});

router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  res.json(out);
});

router.post('/settings', auth.requireRole('admin'), (req, res) => {
  const body = req.body || {};
  for (const [k, v] of Object.entries(body)) setSetting(k, v);
  audit('user', 'update-settings', 'settings', null, JSON.stringify(body));
  res.json({ ok: true });
});

router.get('/fx', (req, res) => res.json(fx.listRates()));
router.post('/fx', auth.requireRole('buyer'), (req, res) => {
  const { base, quote, rate, rateDate, source, booked } = req.body || {};
  if (!base || !quote || !rate) return res.status(400).json({ error: 'base, quote, rate required' });
  fx.setRate(base, quote, Number(rate), { rateDate, source, booked });
  res.json({ ok: true });
});

router.get('/audit', (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200').all());
});

module.exports = router;
