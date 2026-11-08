'use strict';

// Observed supply pools (brief section 11).
//
// "Avoid duplicate supply: several brokers can offer one owner's lot. Link
// confirmed duplicates to one stock pool. Where ownership is unknown, flag
// possible overlap and show a range or unverified quantity separately."
//
// Pooling rule: offers sharing a non-empty stock_owner_id AND a
// non-empty unique_lot_ref describe one physical lot offered by several
// brokers. The pool quantity is the MAX across members (the same lot cannot
// be sold twice), never the sum. Offers without an owner/lot are
// "unverified": they show as a range [min..max] and are flagged, but never
// merged.

const { db } = require('../db');

function poolKey(offer) {
  const owner = String(offer.stock_owner_id || '').trim();
  const lot = String(offer.unique_lot_ref || '').trim();
  return owner && lot ? owner + '|' + lot : null;
}

function observedSupply(opts = {}) {
  const rows = db.prepare(
    `SELECT o.id, o.supplier_code, o.description, o.available_quantity, o.quantity_unit,
            o.stock_owner_id, o.unique_lot_ref, o.stock_country, o.stock_warehouse,
            o.last_confirmed_at, o.stock_confidence, o.valid_until, o.status,
            o.product_id, p.display_name, p.brand
       FROM offers o LEFT JOIN products p ON p.id = o.product_id
      WHERE o.available_quantity IS NOT NULL AND o.available_quantity > 0
        AND o.status != 'ignored'`
  ).all();

  const pools = new Map();
  const unverified = [];
  for (const o of rows) {
    const key = poolKey(o);
    if (key) {
      if (!pools.has(key)) {
        pools.set(key, {
          owner: o.stock_owner_id, lot: o.unique_lot_ref,
          productId: o.product_id, product: o.display_name, brand: o.brand,
          members: [], qtyMax: 0, qtyMin: Infinity, brokers: [],
          confirmedAt: null,
        });
      }
      const pool = pools.get(key);
      pool.members.push({ offerId: o.id, supplierCode: o.supplier_code, qty: Number(o.available_quantity) });
      pool.qtyMax = Math.max(pool.qtyMax, Number(o.available_quantity));
      pool.qtyMin = Math.min(pool.qtyMin, Number(o.available_quantity));
      if (!pool.brokers.includes(o.supplier_code)) pool.brokers.push(o.supplier_code);
      if (o.last_confirmed_at && (!pool.confirmedAt || o.last_confirmed_at > pool.confirmedAt)) {
        pool.confirmedAt = o.last_confirmed_at;
      }
    } else {
      unverified.push(o);
    }
  }
  for (const pool of pools.values()) {
    pool.infiniteQty = !Number.isFinite(pool.qtyMin);
    if (pool.infiniteQty) pool.qtyMin = pool.qtyMax;
    pool.deduplicated = pool.members.length > 1 && pool.brokers.length > 1;
    pool.range = pool.qtyMin === pool.qtyMax ? String(pool.qtyMax) : `${pool.qtyMin}–${pool.qtyMax}`;
  }

  const poolList = [...pools.values()].sort((a, b) => b.qtyMax - a.qtyMax);
  const dedupedTotal = poolList.reduce((s, p) => s + p.qtyMax, 0);
  const naiveSum = rows.reduce((s, o) => s + (Number(o.available_quantity) || 0), 0);
  const unverifiedQty = unverified.reduce((s, o) => s + (Number(o.available_quantity) || 0), 0);

  return {
    pools: poolList.slice(0, opts.limit || 100),
    poolCount: poolList.length,
    dedupedPools: poolList.filter((p) => p.deduplicated).length,
    dedupedQuantity: dedupedTotal,
    naiveSum,
    doubleCountAvoided: naiveSum - dedupedTotal - unverifiedQty,
    unverifiedCount: unverified.length,
    unverifiedQuantity: unverifiedQty,
    note: 'Pool quantity = MAX across brokers (same lot cannot be sold twice). Unverified offers have no owner/lot — never merged, quantity shown separately.',
  };
}

module.exports = { observedSupply, poolKey };
