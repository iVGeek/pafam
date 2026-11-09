'use strict';

// Inventory aging (brief section 18).
//
// "Track inventory aging buckets of 0-30, 31-90, 91-180, 181-365 and over
// 365 days; show days of cover, stock turn, markdown exposure and profit
// by lot."
//
// Lot age = days since the lot first appeared (created_at). Days of cover
// = available units / average daily sold units for that product (from
// settled orders); where no sales history exists cover is null, never a
// fake number. Markdown exposure = stock value sitting in the old buckets.

const { db } = require('../db');

const BUCKETS = [
  { key: '0-30', label: '0–30 days', max: 30 },
  { key: '31-90', label: '31–90 days', max: 90 },
  { key: '91-180', label: '91–180 days', max: 180 },
  { key: '181-365', label: '181–365 days', max: 365 },
  { key: '365+', label: 'over 365 days', max: Infinity },
];

function bucketFor(days) {
  for (const b of BUCKETS) if (days <= b.max) return b.key;
  return '365+';
}

function agingReport(opts = {}) {
  const now = opts.asOf || new Date().toISOString();
  const lots = db.prepare(
    `SELECT i.id, i.product_id, p.display_name, p.brand, i.supplier_code,
            i.warehouse, i.lot_reference, i.on_hand, i.reserved, i.in_transit,
            i.quarantined, i.unit_cost, i.expiry_date, i.created_at
       FROM inventory_lots i LEFT JOIN products p ON p.id = i.product_id
      WHERE i.on_hand > 0`
  ).all();

  // Average daily sold units per product over the last 90 days (settled orders)
  const sold = db.prepare(
    `SELECT product_id, COALESCE(SUM(quantity),0) q FROM orders
      WHERE status IN ('delivered','closed') AND order_date >= date('now','-90 days')
      GROUP BY product_id`
  ).all();
  const soldByProduct = new Map(sold.map((r) => [r.product_id, Number(r.q) || 0]));

  const rows = lots.map((l) => {
    const ageDays = Math.max(0, Math.floor((new Date(now) - new Date(l.created_at + 'Z')) / 86400000));
    const usable = Math.max(0, (Number(l.on_hand) || 0) - (Number(l.quarantined) || 0));
    const available = Math.max(0, usable - (Number(l.reserved) || 0));
    const value = Math.round(available * (Number(l.unit_cost) || 0) * 100) / 100;
    const dailySold = (soldByProduct.get(l.product_id) || 0) / 90;
    const cover = dailySold > 0 ? Math.round((available / dailySold) * 10) / 10 : null;
    const expiring = l.expiry_date ? String(l.expiry_date) < new Date(now).toISOString().slice(0, 10) : false;
    return {
      lotId: l.id, productId: l.product_id, product: l.display_name, brand: l.brand,
      supplierCode: l.supplier_code, warehouse: l.warehouse, lotRef: l.lot_reference,
      onHand: Number(l.on_hand) || 0, reserved: Number(l.reserved) || 0,
      available, inTransit: Number(l.in_transit) || 0,
      unitCost: l.unit_cost != null ? Number(l.unit_cost) : null,
      value, ageDays, bucket: bucketFor(ageDays),
      daysOfCover: cover, expiring,
    };
  });

  const byBucket = BUCKETS.map((b) => {
    const inBucket = rows.filter((r) => r.bucket === b.key);
    return {
      bucket: b.key, label: b.label,
      lots: inBucket.length,
      units: inBucket.reduce((s, r) => s + r.available, 0),
      value: Math.round(inBucket.reduce((s, r) => s + r.value, 0) * 100) / 100,
    };
  });
  const markdownExposure = Math.round(
    rows.filter((r) => ['181-365', '365+'].includes(r.bucket)).reduce((s, r) => s + r.value, 0) * 100
  ) / 100;
  const totalValue = Math.round(rows.reduce((s, r) => s + r.value, 0) * 100) / 100;
  const expiringValue = Math.round(rows.filter((r) => r.expiring).reduce((s, r) => s + r.value, 0) * 100) / 100;

  // Stock turn (annualised): cost of goods sold (settled outbound) / avg value
  const cogs = db.prepare(
    "SELECT COALESCE(SUM(p.amount),0) n FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.direction = 'outbound' AND o.status IN ('delivered','closed')"
  ).get().n;
  const stockTurn = totalValue > 0 ? Math.round((Number(cogs) / totalValue) * 100) / 100 : null;

  const lotsSorted = rows.sort((a, b) => b.ageDays - a.ageDays).slice(0, opts.limit || 100);
  return {
    asOf: now, lots: lots.length,
    totalValue, markdownExposure, expiringValue,
    markdownPct: totalValue > 0 ? Math.round((markdownExposure / totalValue) * 1000) / 10 : null,
    stockTurn, byBucket, oldest: lotsSorted,
  };
}

module.exports = { agingReport, BUCKETS, bucketFor };
