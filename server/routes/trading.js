'use strict';

const express = require('express');
const router = express.Router();
const { db, getSetting, audit } = require('../db');
const pricing = require('../services/pricing');
const deal = require('../services/deal');
const fx = require('../services/fx');
const demandsSvc = require('../services/demands');
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

// ---- CP & SP offer builder (stateless) ----
// Turn a cost price into a selling price at a target margin. The cost can come
// from an existing offer (offerId) or be typed in (costPrice + costCurrency).
// Freight/duty/insurance/brokerage/handling are the per-unit landed-cost slots;
// the FX slot converts the cost currency into the base currency. Both margin
// conventions are returned side by side: markup on cost and margin on selling.
router.post('/pricing/offer', (req, res) => {
  const b = req.body || {};
  const base = b.baseCurrency || getSetting('base_currency', 'USD');
  const quantity = Number(b.quantity) > 0 ? Number(b.quantity) : 1;

  // ---- Acquisition cost per bottle, expressed in the base currency ----
  let acquisition;
  let offerId = null;
  if (b.offerId) {
    const offer = db.prepare(
      `SELECT o.*, s.default_discount_pct FROM offers o JOIN suppliers s ON s.code = o.supplier_code WHERE o.id = ?`
    ).get(Number(b.offerId));
    if (!offer) return res.status(404).json({ error: 'offer not found' });
    const acq = pricing.unitAcquisitionPrice(offer, { discountOffRrpPct: b.discountOffRrpPct });
    if (!Number.isFinite(acq.perBottle)) return res.status(400).json({ error: 'offer has no usable price' });
    const rate = b.fxRate != null ? Number(b.fxRate) : (fx.getRate(offer.currency, base) || 1);
    offerId = offer.id;
    acquisition = {
      perBottle: pricing.round4(acq.perBottle), currency: offer.currency, rate,
      perBottleBase: pricing.round4(acq.perBottle * rate), source: acq.source,
      notes: acq.notes, description: offer.description,
    };
  } else {
    const costPrice = Number(b.costPrice);
    if (!Number.isFinite(costPrice)) return res.status(400).json({ error: 'costPrice or offerId required' });
    const costCurrency = b.costCurrency || base;
    const rate = b.fxRate != null ? Number(b.fxRate) : (fx.getRate(costCurrency, base) || 1);
    acquisition = {
      perBottle: costPrice, currency: costCurrency, rate,
      perBottleBase: pricing.round4(costPrice * rate), source: 'cost', notes: '',
    };
  }

  // ---- Landed build-up in the base currency ----
  const landed = pricing.landedUnitCost({
    purchaseUnitPrice: acquisition.perBottleBase,
    dutyPct: b.dutyPct != null && b.dutyPct !== '' ? b.dutyPct : getSetting('default_duty_pct', '0'),
    freightPerUnit: b.freightPerUnit,
    insurancePerUnit: b.insurancePerUnit,
    brokeragePerUnit: b.brokeragePerUnit != null && b.brokeragePerUnit !== '' ? b.brokeragePerUnit : getSetting('default_brokerage', '0'),
    handlingPerUnit: b.handlingPerUnit,
    otherTaxesPerUnit: b.otherTaxesPerUnit,
  });

  // ---- Selling price at the target margin, both conventions ----
  const targetMarginPct = Number(b.targetMarginPct != null ? b.targetMarginPct : getSetting('min_margin_pct', '15'));
  const minMarginPct = Number(getSetting('min_margin_pct', '15'));
  const minMarkup = Number(getSetting('min_markup', '0.75'));
  const options = pricing.priceFromMargin(landed.total, targetMarginPct);
  for (const k of ['markupOnCost', 'marginOnSelling']) {
    const o = options[k];
    o.marginTotal = o.valid ? pricing.round4((o.sellingUnitPrice - landed.total) * quantity) : null;
    o.revenueTotal = o.valid ? pricing.round4(o.sellingUnitPrice * quantity) : null;
    o.passesPolicy = o.valid ? pricing.pricePolicy(landed.total, o.sellingUnitPrice, minMarginPct, minMarkup).passesPolicy : false;
  }

  res.json({
    baseCurrency: base, costCurrency: acquisition.currency, fxRate: acquisition.rate,
    quantity, offerId, acquisition, landed, targetMarginPct, options,
    policy: { minMarginPct, minMarkup },
  });
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

// ---- Deals: profitability + dated cash flow / capital ----
// Stateless compute (viewer+); pass an offerId (buy side) and/or a customerId.
router.post('/deals/compute', (req, res) => {
  const result = deal.buildDeal(req.body || {});
  if (!result.found) return res.status(result.error === 'offer not found' ? 404 : 400).json({ error: result.error });
  res.json(result);
});

// Persist a computed deal as a quote (buyer+).
router.post('/deals', auth.requireRole('buyer'), (req, res) => {
  const b = req.body || {};
  const result = deal.buildDeal(b);
  if (!result.found) return res.status(result.error === 'offer not found' ? 404 : 400).json({ error: result.error });

  const productId = b.productId != null ? Number(b.productId) : (result.offer ? result.offer.productId : null);
  if (!productId) return res.status(400).json({ error: 'productId required' });
  if (!b.customerId) return res.status(400).json({ error: 'customerId required' });

  const m = result.deal.metrics;
  const cf = result.deal.cashflow;
  const info = db.prepare(
    `INSERT INTO quotes(demand_id, customer_id, product_id, quantity, unit_price, currency,
       landed_unit_cost, margin_pct, offer_id, supplier_code, net_unit_revenue, contribution_total,
       roi_pct, annualised_roi_pct, capital_required, capital_days, order_date, supplier_due_date,
       customer_due_date, selling_unit_price, validity_date, terms, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.demandId ? Number(b.demandId) : null, Number(b.customerId), productId, result.quantity,
    result.selling.sellingUnitPrice, result.baseCurrency, m.landedUnitCost, m.marginPct,
    result.offer ? result.offer.id : null, result.supplier ? result.supplier.code : null,
    m.netUnitRevenue, result.deal.contribution.total, m.roiPct, cf.annualisedRoiPct,
    cf.peakCapital, cf.capitalDays, cf.orderDate, cf.supplierDue, cf.customerDue,
    result.selling.sellingUnitPrice, b.validityDate || null, b.terms || null, b.status || 'draft'
  );
  if (b.demandId) db.prepare("UPDATE demands SET status = 'quoted' WHERE id = ?").run(Number(b.demandId));
  audit('user', 'deal-create', 'quote', Number(info.lastInsertRowid), `margin ${m.marginPct} roi ${m.roiPct}`);
  res.json({ ok: true, id: Number(info.lastInsertRowid), deal: result });
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

// Revise a demand: creates a NEW version that supersedes the old one rather
// than editing it in place (section 15). Refused once it is on an order.
router.post('/demands/:id/revise', auth.requireRole('buyer'), (req, res) => {
  const r = demandsSvc.revise(req.params.id, req.body || {}, req.user.username);
  if (r.error) return res.status(r.notFound ? 404 : (r.locked ? 409 : 400)).json(r);
  res.json(r);
});

// Full version chain for a demand, oldest first.
router.get('/demands/:id/history', (req, res) => {
  const h = demandsSvc.history(req.params.id);
  if (!h) return res.status(404).json({ error: 'demand not found' });
  res.json({ demandId: Number(req.params.id), versions: h });
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
