'use strict';

const { db, getSetting, audit } = require('../db');
const trends = require('./trends');

function toInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// Insert an alert unless an identical one (same dedupe key) was raised within
// the dedupe window. Keeps a recurring condition from spamming the inbox.
function insertAlert(a, dedupeDays) {
  if (a.dedupeKey) {
    const recent = db.prepare(
      `SELECT id FROM alerts WHERE dedupe_key = ? AND created_at >= datetime('now', ?)`
    ).get(a.dedupeKey, `-${dedupeDays} days`);
    if (recent) return false;
  }
  db.prepare(
    `INSERT INTO alerts(type, severity, title, detail, product_id, supplier_code, dedupe_key)
     VALUES (?,?,?,?,?,?,?)`
  ).run(a.type, a.severity || 'info', a.title, a.detail || null,
    a.productId != null ? Number(a.productId) : null, a.supplierCode || null, a.dedupeKey || null);
  return true;
}

// Price movements beyond the configured threshold.
function priceChangeAlerts(threshold, dedupeDays) {
  let created = 0;
  for (const m of trends.allTrends({ onlyChanged: true })) {
    if (m.changePct == null || Math.abs(m.changePct) < threshold) continue;
    const dir = m.changePct > 0 ? 'up' : 'down';
    const name = m.displayName || m.gtin;
    const ok = insertAlert({
      type: 'price_change',
      severity: trends.severityForChange(m.changePct, threshold),
      title: `${m.supplierCode} price ${dir} ${Math.abs(m.changePct).toFixed(1)}% — ${name}`,
      detail: `Per-bottle cost moved from ${m.previous.unitCostBase} to ${m.latest.unitCostBase} (base ccy). List date ${m.latest.listDate || 'n/a'}.`,
      productId: m.productId,
      supplierCode: m.supplierCode,
      dedupeKey: `price_change:${m.supplierCode}:${m.gtin}`,
    }, dedupeDays);
    if (ok) created++;
  }
  return created;
}

// Offers whose validity has lapsed.
function expiredOfferAlerts(dedupeDays) {
  const rows = db.prepare(
    `SELECT o.id, o.supplier_code, o.gtin_canonical, o.valid_until, o.product_id, p.display_name
     FROM offers o LEFT JOIN products p ON p.id = o.product_id
     WHERE o.valid_until IS NOT NULL AND o.valid_until != '' AND o.valid_until < date('now')
       AND o.status != 'ignored'`
  ).all();
  let created = 0;
  for (const o of rows) {
    const ok = insertAlert({
      type: 'offer_expired',
      severity: 'warning',
      title: `Offer expired ${o.valid_until} — ${o.supplier_code}`,
      detail: `${o.display_name || o.gtin_canonical || 'offer #' + o.id} was valid until ${o.valid_until}.`,
      productId: o.product_id,
      supplierCode: o.supplier_code,
      dedupeKey: `offer_expired:${o.id}`,
    }, dedupeDays);
    if (ok) created++;
  }
  return created;
}

// Matched offers with available stock at or below the low-stock threshold.
function lowStockAlerts(threshold, dedupeDays, cap = 100) {
  const rows = db.prepare(
    `SELECT o.id, o.supplier_code, o.gtin_canonical, o.available_quantity, o.product_id, p.display_name
     FROM offers o JOIN products p ON p.id = o.product_id
     WHERE o.available_quantity IS NOT NULL AND o.available_quantity <= ?
       AND o.status != 'ignored'
     ORDER BY o.available_quantity ASC LIMIT ?`
  ).all(threshold, cap);
  let created = 0;
  for (const o of rows) {
    const ok = insertAlert({
      type: 'low_stock',
      severity: Number(o.available_quantity) <= 0 ? 'warning' : 'info',
      title: `Low stock (${o.available_quantity}) — ${o.supplier_code}`,
      detail: `${o.display_name || o.gtin_canonical || 'offer #' + o.id} has ${o.available_quantity} units available.`,
      productId: o.product_id,
      supplierCode: o.supplier_code,
      dedupeKey: `low_stock:${o.id}`,
    }, dedupeDays);
    if (ok) created++;
  }
  return created;
}

// The cheapest supplier for a product when the winner has changed between the
// previous and latest observations.
function newBestSupplierAlerts(dedupeDays) {
  const productIds = db.prepare(
    `SELECT DISTINCT product_id FROM price_history WHERE product_id IS NOT NULL`
  ).all().map((r) => r.product_id);
  let created = 0;
  for (const pid of productIds) {
    const perSupplier = trends.productTrends(pid).filter((t) => t.latest && t.previous);
    if (perSupplier.length < 2) continue;
    const bestOf = (key) => perSupplier
      .filter((t) => t[key])
      .sort((a, b) => a[key].unitCostBase - b[key].unitCostBase)[0];
    const nowBest = bestOf('latest');
    const wasBest = bestOf('previous');
    if (!nowBest || !wasBest || nowBest.supplierCode === wasBest.supplierCode) continue;
    const name = db.prepare('SELECT display_name FROM products WHERE id = ?').get(pid);
    const ok = insertAlert({
      type: 'new_best_supplier',
      severity: 'info',
      title: `New best supplier for ${name ? name.display_name : 'product #' + pid}`,
      detail: `Cheapest per-bottle cost moved from ${wasBest.supplierCode} to ${nowBest.supplierCode}.`,
      productId: pid,
      supplierCode: nowBest.supplierCode,
      dedupeKey: `new_best:${pid}:${nowBest.supplierCode}`,
    }, dedupeDays);
    if (ok) created++;
  }
  return created;
}

// Scan the catalogue and raise fresh alerts. Returns per-type counts.
function generateAlerts(opts = {}) {
  const threshold = toInt(getSetting('price_change_alert_pct', '10'), 10);
  const lowStockThreshold = toInt(getSetting('low_stock_threshold', '10'), 10);
  const dedupeDays = toInt(getSetting('alert_dedupe_days', '7'), 7);

  const result = {
    priceChange: priceChangeAlerts(threshold, dedupeDays),
    expired: expiredOfferAlerts(dedupeDays),
    lowStock: lowStockAlerts(lowStockThreshold, dedupeDays),
    newBest: newBestSupplierAlerts(dedupeDays),
  };
  result.created = result.priceChange + result.expired + result.lowStock + result.newBest;
  audit(opts.actor || 'system', 'alerts-refresh', 'alerts', null,
    `${result.created} raised (price ${result.priceChange}, expired ${result.expired}, low-stock ${result.lowStock}, new-best ${result.newBest})`);
  return result;
}

function listAlerts(opts = {}) {
  const limit = Math.min(toInt(opts.limit, 200), 1000);
  const where = opts.unreadOnly ? 'WHERE a.read = 0' : '';
  return db.prepare(
    `SELECT a.*, p.display_name
     FROM alerts a LEFT JOIN products p ON p.id = a.product_id
     ${where} ORDER BY a.read ASC, a.created_at DESC, a.id DESC LIMIT ?`
  ).all(limit);
}

function counts() {
  const total = db.prepare('SELECT COUNT(*) n FROM alerts').get().n;
  const unread = db.prepare('SELECT COUNT(*) n FROM alerts WHERE read = 0').get().n;
  const bySeverity = db.prepare("SELECT severity, COUNT(*) n FROM alerts WHERE read = 0 GROUP BY severity").all();
  const byType = db.prepare('SELECT type, COUNT(*) n FROM alerts GROUP BY type ORDER BY n DESC').all();
  return { total, unread, bySeverity, byType };
}

function markRead(id) {
  db.prepare('UPDATE alerts SET read = 1 WHERE id = ?').run(Number(id));
  return { ok: true };
}

function markAllRead() {
  const info = db.prepare('UPDATE alerts SET read = 1 WHERE read = 0').run();
  return { ok: true, updated: Number(info.changes) };
}

module.exports = { generateAlerts, listAlerts, counts, markRead, markAllRead };
