'use strict';

// Customer demand version history (brief section 15).
//
// "supersedes_demand_fk (version history — never silently overwrites a
// confirmed order)".
//
// The rule we enforce: a demand is NEVER edited in place. Revising one creates
// a new row that points back at the version it replaces, and the old row is
// marked superseded rather than deleted. If a demand has already been quoted or
// turned into an order, revising it is refused outright — a confirmed order is
// never quietly rewritten by a later note or correction.

const { db, audit } = require('../db');

// Statuses that represent a commitment. These must not be silently revised.
const LOCKED_STATUSES = ['won', 'quoted'];

const REVISEABLE_FIELDS = [
  'quantity', 'target_price', 'currency', 'needed_by', 'notes',
  'expiry_date', 'status', 'approved',
];

function get(demandId) {
  return db.prepare('SELECT * FROM demands WHERE id = ?').get(Number(demandId));
}

function isLocked(demand) {
  return LOCKED_STATUSES.includes(demand.status);
}

// Has this demand already become a real order?
function hasOrder(demandId) {
  const o = db.prepare('SELECT id, ref FROM orders WHERE demand_id = ? ORDER BY id DESC LIMIT 1').get(Number(demandId));
  return o || null;
}

// Create a new version that supersedes the given one. Returns the new row id.
function revise(demandId, changes, actor) {
  const current = get(demandId);
  if (!current) return { error: 'demand not found', notFound: true };

  const order = hasOrder(current.id);
  if (order) {
    // A confirmed order is never overwritten. The correction has to be raised
    // as a new demand so both the old commitment and the new truth survive.
    return {
      error: `demand is already on order ${order.ref}; raise a new demand rather than rewriting history`,
      locked: true,
      orderId: order.id,
      orderRef: order.ref,
    };
  }
  if (isLocked(current)) {
    return { error: `demand is ${current.status} and cannot be revised in place`, locked: true };
  }

  const unknown = Object.keys(changes || {}).filter((k) => !REVISEABLE_FIELDS.includes(k));
  if (unknown.length) return { error: `cannot revise: ${unknown.join(', ')}` };

  // Build the new version from the old one plus the changes.
  const next = {
    customer_id: current.customer_id,
    product_id: current.product_id,
    status: changes.status !== undefined ? changes.status : current.status,
    quantity: changes.quantity !== undefined ? Number(changes.quantity) : current.quantity,
    target_price: changes.target_price !== undefined
      ? (changes.target_price === null ? null : Number(changes.target_price)) : current.target_price,
    currency: changes.currency || current.currency,
    needed_by: changes.needed_by !== undefined ? changes.needed_by : current.needed_by,
    source: current.source,
    approved: changes.approved !== undefined ? (changes.approved ? 1 : 0) : current.approved,
    expiry_date: changes.expiry_date !== undefined ? changes.expiry_date : current.expiry_date,
    notes: changes.notes !== undefined ? changes.notes : current.notes,
  };

  const info = db.prepare(
    `INSERT INTO demands(customer_id, product_id, status, quantity, target_price, currency,
                         needed_by, source, approved, expiry_date, notes, supersedes_demand_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    next.customer_id, next.product_id, next.status, next.quantity, next.target_price,
    next.currency, next.needed_by, next.source, next.approved, next.expiry_date,
    next.notes, current.id
  );
  const newId = Number(info.lastInsertRowid);

  // Retire the old version, but keep it.
  db.prepare("UPDATE demands SET status = 'superseded', superseded_by_demand_id = ? WHERE id = ?")
    .run(newId, current.id);

  audit(actor || 'system', 'demand-revise', 'demand', newId,
    `supersedes demand ${current.id} (qty ${current.quantity} -> ${next.quantity})`);
  return { ok: true, id: newId, supersedes: current.id, previous: current };
}

// The full chain of versions for a demand, oldest first, whichever version you
// start from.
function history(demandId) {
  const start = get(demandId);
  if (!start) return null;

  // Walk back to the root, then walk forward.
  let root = start;
  const seen = new Set();
  while (root.supersedes_demand_id && !seen.has(root.id)) {
    seen.add(root.id);
    const prev = get(root.supersedes_demand_id);
    if (!prev) break;
    root = prev;
  }

  const chain = [root];
  let cur = root;
  while (cur.superseded_by_demand_id) {
    const next = get(cur.superseded_by_demand_id);
    if (!next) break;
    chain.push(next);
    cur = next;
  }

  return chain.map((d) => ({
    id: d.id,
    status: d.status,
    quantity: d.quantity,
    target_price: d.target_price,
    approved: !!d.approved,
    captured_at: d.captured_at,
    supersedes: d.supersedes_demand_id,
    superseded_by: d.superseded_by_demand_id,
    current: d.id === start.id,
    locked: isLocked(d) || !!hasOrder(d.id),
    notes: d.notes,
  }));
}

module.exports = { REVISEABLE_FIELDS, LOCKED_STATUSES, get, revise, history, hasOrder, isLocked };