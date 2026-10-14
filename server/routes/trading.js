'use strict';

const express = require('express');
const router = express.Router();
const { db, getSetting, audit } = require('../db');
const pricing = require('../services/pricing');
const auth = require('../services/auth');

// ---- Pricing calculator (stateless) ----
router.post('/pricing/calculate', (req, res) => {
  const b = req.body || {};
  const landed = pricing.landedUnitCost({
    purchaseUnitPrice: b.purchaseUnitPrice != null ? b.purchaseUnitPrice : b.price,
    dutyPct: b.dutyPct,
    freightPerUnit: b.freightPerUnit,
    insurancePerUnit: b.insurancePerUnit,
    brokeragePerUnit: b.brokeragePerUnit,
    handlingPerUnit: b.handlingPerUnit,
    otherTaxesPerUnit: b.otherTaxesPerUnit,
  });
  const metrics = pricing.dealMetrics({
    quantity: b.quantity,
    landedUnitCost: landed.total,
    sellingUnitPrice: b.sellingUnitPrice,
    discountPct: b.discountPct,
    rebatePct: b.rebatePct,
    returnsAllowancePct: b.returnsAllowancePct,
    customerDeductionPct: b.customerDeductionPct,
    paymentTermsCostPct: b.paymentTermsCostPct,
    daysToCash: b.daysToCash,
    minMarginPct: Number(getSetting('min_margin_pct', '15')),
    minMarkup: Number(getSetting('min_markup', '0.75')),
  });
  res.json({ landed, metrics, discountOffRrpPct: pricing.discountOffRrpPct(b.sellingUnitPrice, b.rrp) });
});

// Calculate a deal directly from an offer id.
router.post('/pricing/from-offer', (req, res) => {
  const b = req.body || {};
  const offer = db.prepare(
    `SELECT o.*, s.default_discount_pct FROM offers o JOIN suppliers s ON s.code = o.supplier_code WHERE o.id = ?`
  ).get(Number(b.offerId));
  if (!offer) return res.status(404).json({ error: 'offer not found' });
  const acq = pricing.unitAcquisitionPrice(offer, { discountOffRrpPct: b.discountOffRrpPct });
  const landed = pricing.landedUnitCost({
    purchaseUnitPrice: acq.perBottle,
    dutyPct: b.dutyPct || getSetting('default_duty_pct', '0'),
    freightPerUnit: b.freightPerUnit,
    insurancePerUnit: b.insurancePerUnit,
    brokeragePerUnit: b.brokeragePerUnit || getSetting('default_brokerage', '0'),
    handlingPerUnit: b.handlingPerUnit,
    otherTaxesPerUnit: b.otherTaxesPerUnit,
  });
  const sell = b.sellingUnitPrice != null ? b.sellingUnitPrice : (offer.rrp || offer.price);
  const metrics = pricing.dealMetrics({
    quantity: b.quantity,
    landedUnitCost: landed.total,
    sellingUnitPrice: sell,
    discountPct: b.discountPct,
    rebatePct: b.rebatePct,
    returnsAllowancePct: b.returnsAllowancePct,
    customerDeductionPct: b.customerDeductionPct,
    paymentTermsCostPct: b.paymentTermsCostPct,
    daysToCash: b.daysToCash,
    minMarginPct: Number(getSetting('min_margin_pct', '15')),
    minMarkup: Number(getSetting('min_markup', '0.75')),
  });
  res.json({ offer, acquisition: acq, landed, metrics });
});

// ---- Inventory ----
router.get('/inventory', (req, res) => {
  const rows = db.prepare(
    `SELECT i.*, p.display_name, p.canonical_gtin, p.category
     FROM inventory_lots i JOIN products p ON p.id = i.product_id
     ORDER BY i.id DESC LIMIT 500`
  ).all();
  const totals = db.prepare(
    `SELECT COALESCE(SUM(on_hand),0) on_hand, COALESCE(SUM(reserved),0) reserved,
            COALESCE(SUM(in_transit),0) in_transit, COALESCE(SUM(quarantined),0) quarantined
     FROM inventory_lots`
  ).get();
  res.json({ rows, totals });
});

router.post('/inventory', auth.requireRole('buyer'), (req, res) => {
  const b = req.body || {};
  if (!b.productId) return res.status(400).json({ error: 'productId required' });
  const info = db.prepare(
    `INSERT INTO inventory_lots(product_id, supplier_code, warehouse, lot_reference, on_hand, reserved, in_transit, quarantined, unit_cost, currency, expiry_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    Number(b.productId), b.supplierCode || null, b.warehouse || null, b.lotReference || null,
    Number(b.onHand) || 0, Number(b.reserved) || 0, Number(b.inTransit) || 0, Number(b.quarantined) || 0,
    b.unitCost != null ? Number(b.unitCost) : null, b.currency || 'USD', b.expiryDate || null
  );
  audit('user', 'inventory-add', 'inventory_lot', Number(info.lastInsertRowid));
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

// ---- Customers ----
router.get('/customers', (req, res) => {
  res.json(db.prepare('SELECT * FROM customers ORDER BY id DESC LIMIT 500').all());
});
router.post('/customers', auth.requireRole('buyer'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const info = db.prepare(
    `INSERT INTO customers(code, name, region, currency, payment_terms, credit_limit, sanctioned)
     VALUES (?,?,?,?,?,?,?)`
  ).run(b.code || null, b.name, b.region || null, b.currency || 'USD', b.paymentTerms || null,
    b.creditLimit != null ? Number(b.creditLimit) : null, b.sanctioned ? 1 : 0);
  audit('user', 'customer-add', 'customer', Number(info.lastInsertRowid), b.name);
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

// ---- Demands ----
router.get('/demands', (req, res) => {
  const rows = db.prepare(
    `SELECT d.*, c.name AS customer_name, p.display_name, p.canonical_gtin
     FROM demands d JOIN customers c ON c.id = d.customer_id JOIN products p ON p.id = d.product_id
     ORDER BY d.id DESC LIMIT 500`
  ).all();
  res.json(rows);
});
router.post('/demands', auth.requireRole('buyer'), (req, res) => {
  const b = req.body || {};
  if (!b.customerId || !b.productId) return res.status(400).json({ error: 'customerId and productId required' });
  const info = db.prepare(
    `INSERT INTO demands(customer_id, product_id, status, quantity, target_price, currency, needed_by, source, approved, expiry_date, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    Number(b.customerId), Number(b.productId), b.status || 'open', Number(b.quantity) || 0,
    b.targetPrice != null ? Number(b.targetPrice) : null, b.currency || 'USD', b.neededBy || null,
    b.source || 'manual', b.approved ? 1 : 0, b.expiryDate || null, b.notes || null
  );
  audit('user', 'demand-add', 'demand', Number(info.lastInsertRowid));
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

// ---- Quotes ----
router.get('/quotes', (req, res) => {
  const rows = db.prepare(
    `SELECT q.*, c.name AS customer_name, p.display_name
     FROM quotes q JOIN customers c ON c.id = q.customer_id JOIN products p ON p.id = q.product_id
     ORDER BY q.id DESC LIMIT 500`
  ).all();
  res.json(rows);
});
router.post('/quotes', auth.requireRole('buyer'), (req, res) => {
  const b = req.body || {};
  if (!b.customerId || !b.productId || !b.quantity || !b.unitPrice) {
    return res.status(400).json({ error: 'customerId, productId, quantity, unitPrice required' });
  }
  const landedUnitCost = b.landedUnitCost != null ? Number(b.landedUnitCost) : null;
  const unitPrice = Number(b.unitPrice);
  const marginPct = landedUnitCost != null && unitPrice > 0 ? pricing.round4(((unitPrice - landedUnitCost) / unitPrice) * 100) : null;
  const info = db.prepare(
    `INSERT INTO quotes(demand_id, customer_id, product_id, quantity, unit_price, currency, landed_unit_cost, margin_pct, validity_date, terms, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.demandId ? Number(b.demandId) : null, Number(b.customerId), Number(b.productId), Number(b.quantity),
    unitPrice, b.currency || 'USD', landedUnitCost, marginPct, b.validityDate || null, b.terms || null, b.status || 'draft'
  );
  if (b.demandId) db.prepare("UPDATE demands SET status = 'quoted' WHERE id = ?").run(Number(b.demandId));
  audit('user', 'quote-create', 'quote', Number(info.lastInsertRowid), `margin ${marginPct}`);
  res.json({ ok: true, id: Number(info.lastInsertRowid), marginPct });
});

module.exports = router;
