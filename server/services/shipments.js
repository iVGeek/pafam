'use strict';

// Shipment cost allocation (brief section 8, control 2).
//
// "Allocate shipment costs by a documented driver (chargeable weight / volume /
// value); allocated totals must reconcile to the shipment."
//
// This module implements exactly that and nothing more. It does not guess: a
// shipment declares its cost and one driver, each line declares the basis
// amount for that driver, and the cost is split proportionally. The rounding
// remainder is pushed onto the largest line so the allocations always add back
// to the shipment total exactly — a reconciliation that does not tie is
// reported as `reconciled: false` rather than being quietly rounded away.

const { db, audit } = require('../db');

const DRIVERS = {
  weight: { label: 'Chargeable weight (kg)', column: 'total_weight_kg' },
  volume: { label: 'Volume (m³)', column: 'total_volume_m3' },
  value: { label: 'Declared value', column: 'declared_value' },
};

const EPSILON = 1e-6;

function round4(n) { return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000; }
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function validDriver(d) { return Object.prototype.hasOwnProperty.call(DRIVERS, d); }

function drivers() {
  return Object.entries(DRIVERS).map(([key, d]) => ({ key, label: d.label }));
}

function getShipment(id) {
  return db.prepare('SELECT * FROM shipments WHERE id = ?').get(Number(id));
}

function allocations(shipmentId) {
  return db.prepare(
    `SELECT a.*, p.display_name
       FROM shipment_allocations a
       LEFT JOIN products p ON p.id = a.product_id
      WHERE a.shipment_id = ?
      ORDER BY a.basis_value DESC, a.id`
  ).all(Number(shipmentId));
}

function createShipment(input) {
  const driver = String(input.driver || 'value');
  if (!validDriver(driver)) {
    return { error: `driver must be one of ${Object.keys(DRIVERS).join(', ')}` };
  }
  const total = Number(input.totalCost);
  if (!(total > 0)) return { error: 'totalCost must be greater than zero' };

  const ref = input.ref || `SHP-${Date.now().toString(36).toUpperCase()}`;
  const info = db.prepare(
    `INSERT INTO shipments(ref, direction, supplier_code, customer_id, incoterm, cost_type,
                           total_cost, currency, driver, total_weight_kg, total_volume_m3,
                           declared_value, shipped_date, status, notes, created_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    ref,
    input.direction === 'outbound' ? 'outbound' : 'inbound',
    input.supplierCode || null,
    input.customerId ? Number(input.customerId) : null,
    input.incoterm || null,
    input.costType || 'freight',
    round4(total),
    input.currency || 'USD',
    driver,
    input.totalWeightKg != null ? Number(input.totalWeightKg) : null,
    input.totalVolumeM3 != null ? Number(input.totalVolumeM3) : null,
    input.declaredValue != null ? Number(input.declaredValue) : null,
    input.shippedDate || null,
    'draft',
    input.notes || null,
    input.createdBy || 'system'
  );
  const id = Number(info.lastInsertRowid);

  const lines = Array.isArray(input.lines) ? input.lines : [];
  for (const l of lines) {
    db.prepare(
      `INSERT INTO shipment_allocations(shipment_id, offer_id, order_id, product_id, quantity, basis_value)
       VALUES(?,?,?,?,?,?)`
    ).run(
      id,
      l.offerId ? Number(l.offerId) : null,
      l.orderId ? Number(l.orderId) : null,
      l.productId ? Number(l.productId) : null,
      Number(l.quantity) || 0,
      round4(l.basisValue)
    );
  }
  if (input.createdBy) audit(input.createdBy, 'shipment-create', 'shipment', id, `${ref} ${total}`);
  return { ok: true, id, ref };
}

// Split the shipment cost across its lines using the declared driver.
// Any rounding remainder goes to the largest line, so the sum ties exactly.
function allocate(shipmentId, actor) {
  const s = getShipment(shipmentId);
  if (!s) return { error: 'shipment not found' };
  if (!validDriver(s.driver)) return { error: 'invalid driver on shipment' };

  const lines = allocations(shipmentId);
  if (!lines.length) return { error: 'shipment has no lines to allocate across' };

  const totalBasis = lines.reduce((sum, l) => sum + (Number(l.basis_value) || 0), 0);
  if (totalBasis <= 0) {
    return {
      error: 'allocation basis is zero across all lines — cannot allocate by this driver',
      driver: s.driver, totalBasis: 0,
    };
  }

  const total = Number(s.total_cost) || 0;
  const allocatedTotal = round2(total);
  let running = 0;
  const biggest = lines.reduce((a, b) => ((Number(b.basis_value) || 0) > (Number(a.basis_value) || 0) ? b : a), lines[0]);
  const biggestId = biggest.id;

  const results = [];
  for (const l of lines) {
    const share = (Number(l.basis_value) || 0) / totalBasis;
    const cost = round2(total * share);
    results.push({ id: l.id, share, cost });
    running = round2(running + cost);
    db.prepare('UPDATE shipment_allocations SET allocated_cost = ? WHERE id = ?').run(cost, l.id);
  }

  // Push the rounding remainder onto the largest line so the totals tie.
  const remainder = round2(allocatedTotal - running);
  if (Math.abs(remainder) >= 0.005) {
    const target = results.find((r) => r.id === biggestId);
    if (target) {
      target.cost = round2(target.cost + remainder);
      db.prepare('UPDATE shipment_allocations SET allocated_cost = ? WHERE id = ?').run(target.cost, target.id);
    }
  }

  const report = reconcile(shipmentId);
  db.prepare("UPDATE shipments SET status = ? WHERE id = ?").run(report.reconciled ? 'reconciled' : 'allocated', Number(shipmentId));
  if (actor) audit(actor, 'shipment-allocate', 'shipment', Number(shipmentId), `${s.driver} total ${allocatedTotal}`);
  return { ok: true, ...report };
}

// The control the brief asks for: allocated totals must reconcile to the
// shipment. Returns the difference rather than hiding it.
function reconcile(shipmentId) {
  const s = getShipment(shipmentId);
  if (!s) return { error: 'shipment not found' };
  const lines = allocations(shipmentId);
  const allocated = round2(lines.reduce((sum, l) => sum + (Number(l.allocated_cost) || 0), 0));
  const total = round2(s.total_cost);
  const difference = round2(allocated - total);
  return {
    shipmentId: Number(shipmentId),
    ref: s.ref,
    driver: s.driver,
    driverLabel: DRIVERS[s.driver] ? DRIVERS[s.driver].label : s.driver,
    shipmentTotal: total,
    allocatedTotal: allocated,
    difference,
    reconciled: Math.abs(difference) < 0.01,
    lines: lines.map((l) => ({
      id: l.id,
      product: l.display_name,
      quantity: l.quantity,
      basisValue: l.basis_value,
      allocatedCost: l.allocated_cost,
    })),
  };
}

function list(opts = {}) {
  const where = [];
  const params = [];
  if (opts.status) { where.push('s.status = ?'); params.push(String(opts.status)); }
  if (opts.direction) { where.push('s.direction = ?'); params.push(String(opts.direction)); }
  const rows = db.prepare(
    `SELECT s.*,
            COALESCE((SELECT SUM(allocated_cost) FROM shipment_allocations a WHERE a.shipment_id = s.id), 0) AS allocated_total,
            (SELECT COUNT(*) FROM shipment_allocations a WHERE a.shipment_id = s.id) AS line_count
       FROM shipments s
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY s.id DESC LIMIT ?`
  ).all(...params, Number(opts.limit) || 100);
  return rows.map((r) => ({
    ...r,
    difference: round2(round2(r.allocated_total) - round2(r.total_cost)),
    reconciled: r.line_count > 0 && Math.abs(round2(round2(r.allocated_total) - round2(r.total_cost))) < 0.01,
  }));
}

module.exports = { DRIVERS, drivers, createShipment, allocate, reconcile, list, getShipment, allocations, validDriver };