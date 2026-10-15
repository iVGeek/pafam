'use strict';

// Stock reservations (brief section 11 / section 20).
//
// A reservation holds stock in an inventory lot for a specific customer demand
// or order so that two traders cannot sell the same bottle. Two rules from the
// brief are enforced here:
//
//   1. Sum of active reservations per lot <= usable stock.
//      Usable = on_hand - quarantined. In-transit stock is NOT available: it
//      is still inbound and only counts once received.
//   2. Reservations cannot be released/oversubscribed; releasing one always
//      frees stock back up for others.
//
// The inventory_lots.reserved column is kept in sync as a cache so the stock
// export and the UI do not have to aggregate every time; availableToSell()
// recomputes from the reservations table so drift is detectable.

const { db, audit } = require('../db');

function round4(n) { return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000; }

function getLot(lotId) {
  return db.prepare('SELECT * FROM inventory_lots WHERE id = ?').get(Number(lotId));
}

// Stock in a lot that is physically here and not quarantined.
function usableStock(lot) {
  return round4((Number(lot.on_hand) || 0) - (Number(lot.quarantined) || 0));
}

// Stock already committed to active reservations on this lot.
function reservedFor(lotId) {
  const row = db.prepare(
    "SELECT COALESCE(SUM(quantity),0) AS q FROM reservations WHERE lot_id = ? AND status = 'active'"
  ).get(Number(lotId));
  return round4(row.q);
}

// Authoritative availability. In-transit is excluded on purpose (section 11).
function availableToSell(lotId) {
  const lot = getLot(lotId);
  if (!lot) return null;
  return round4(usableStock(lot) - reservedFor(lotId));
}

function syncLotReserved(lotId) {
  db.prepare('UPDATE inventory_lots SET reserved = ? WHERE id = ?').run(reservedFor(lotId), Number(lotId));
}

// Reserve stock. Fails rather than overselling.
function reserve(input) {
  const lotId = Number(input.lotId);
  const quantity = round4(input.quantity);
  const lot = getLot(lotId);
  if (!lot) return { ok: false, error: 'lot not found' };
  if (!(quantity > 0)) return { ok: false, error: 'quantity must be greater than zero' };

  const usable = usableStock(lot);
  const alreadyReserved = reservedFor(lotId);
  const available = round4(usable - alreadyReserved);

  if (available <= 0) {
    return {
      ok: false,
      error: 'no stock available to reserve',
      lotId, usable, reserved: alreadyReserved, available: 0,
    };
  }
  if (quantity > available + 1e-9) {
    return {
      ok: false,
      error: `would oversell: only ${available} available`,
      lotId, usable, reserved: alreadyReserved, available, requested: quantity,
    };
  }

  const info = db.prepare(
    `INSERT INTO reservations(lot_id, demand_id, order_id, customer_id, quantity, status, notes, created_by)
     VALUES(?,?,?,?,?,'active',?,?)`
  ).run(
    lotId,
    input.demandId ? Number(input.demandId) : null,
    input.orderId ? Number(input.orderId) : null,
    input.customerId ? Number(input.customerId) : null,
    quantity,
    input.notes || null,
    input.actor || null
  );
  syncLotReserved(lotId);
  if (input.actor) audit(input.actor, 'reserve', 'reservation', info.lastInsertRowid, `lot ${lotId} qty ${quantity}`);
  return { ok: true, id: Number(info.lastInsertRowid), lotId, quantity, availableToSell: availableToSell(lotId) };
}

// Release a reservation, freeing the stock again. Idempotent-safe: only an
// active reservation can be released.
function release(reservationId, actor) {
  const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(Number(reservationId));
  if (!r) return { ok: false, error: 'reservation not found' };
  if (r.status !== 'active') return { ok: false, error: `reservation already ${r.status}` };

  db.prepare("UPDATE reservations SET status = 'released', released_at = datetime('now') WHERE id = ?")
    .run(Number(reservationId));
  syncLotReserved(r.lot_id);
  if (actor) audit(actor, 'release', 'reservation', Number(reservationId), `lot ${r.lot_id} qty ${r.quantity}`);
  return { ok: true, id: Number(reservationId), availableToSell: availableToSell(r.lot_id) };
}

// Mark a reservation as fulfilled by an actual shipment/receipt. The stock
// leaves the lot at the same time.
function fulfil(reservationId, actor) {
  const r = db.prepare('SELECT * FROM reservations WHERE id = ?').get(Number(reservationId));
  if (!r) return { ok: false, error: 'reservation not found' };
  if (r.status !== 'active') return { ok: false, error: `reservation already ${r.status}` };

  const lot = getLot(r.lot_id);
  const qty = Number(r.quantity) || 0;
  if (!lot) return { ok: false, error: 'lot not found' };
  db.prepare('UPDATE inventory_lots SET on_hand = on_hand - ?, reserved = reserved - ? WHERE id = ?')
    .run(qty, qty, Number(r.lot_id));
  db.prepare("UPDATE reservations SET status = 'fulfilled', released_at = datetime('now') WHERE id = ?")
    .run(Number(reservationId));
  syncLotReserved(r.lot_id);
  if (actor) audit(actor, 'fulfil', 'reservation', Number(reservationId), `lot ${r.lot_id} qty ${qty}`);
  return { ok: true, id: Number(reservationId), availableToSell: availableToSell(r.lot_id) };
}

// Reservations with live availability numbers, joined for display.
function list(opts = {}) {
  const where = [];
  const params = [];
  if (opts.lotId) { where.push('r.lot_id = ?'); params.push(Number(opts.lotId)); }
  if (opts.demandId) { where.push('r.demand_id = ?'); params.push(Number(opts.demandId)); }
  if (opts.status) { where.push('r.status = ?'); params.push(String(opts.status)); }
  const sql = `
    SELECT r.*, i.lot_reference, i.warehouse, i.on_hand, i.quarantined,
           p.display_name, c.name AS customer_name
      FROM reservations r
      JOIN inventory_lots i ON i.id = r.lot_id
      LEFT JOIN products p ON p.id = i.product_id
      LEFT JOIN customers c ON c.id = r.customer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT ?`;
  params.push(Number(opts.limit) || 200);
  const rows = db.prepare(sql).all(...params);
  for (const r of rows) {
    r.usable = usableStock(r);
    r.availableToSell = round4(r.usable - reservedFor(r.lot_id));
  }
  return rows;
}

// Per-lot availability roll-up, used by the inventory screen and stock export.
function lotAvailability() {
  const lots = db.prepare(
    `SELECT i.id, i.on_hand, i.quarantined, i.in_transit
       FROM inventory_lots i`
  ).all();
  return lots.map((l) => ({
    lotId: l.id,
    onHand: l.on_hand,
    quarantined: l.quarantined,
    inTransit: l.in_transit,
    usable: usableStock(l),
    reserved: reservedFor(l.id),
    availableToSell: round4(usableStock(l) - reservedFor(l.id)),
  }));
}

module.exports = {
  usableStock, reservedFor, availableToSell, syncLotReserved,
  reserve, release, fulfil, list, lotAvailability,
};