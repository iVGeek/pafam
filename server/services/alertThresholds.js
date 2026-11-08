'use strict';

// Per-brand / per-SKU alert thresholds (brief section 13).
//
// "Thresholds must be configurable by brand or SKU."
//
// Resolution order: product override -> brand override -> supplier override
// -> global setting. A threshold row is fully optional per metric; a null
// metric inherits from the next level down. Nothing here creates alerts —
// services/alerts.js calls thresholdFor() when it scans.

const { db, getSetting, audit } = require('../db');

const SCOPES = ['global', 'brand', 'sku', 'supplier'];

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS alert_thresholds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    price_change_pct REAL,
    low_stock REAL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(scope_type, scope_key)
  )`);
}
ensureTable();

function globalDefaults() {
  return {
    priceChangePct: Number(getSetting('price_change_alert_pct', '10')) || 10,
    lowStock: Number(getSetting('low_stock_threshold', '10')) || 10,
  };
}

function list() {
  return db.prepare('SELECT * FROM alert_thresholds ORDER BY scope_type, scope_key').all();
}

function setThreshold({ scopeType, scopeKey, priceChangePct, lowStock, enabled, actor } = {}) {
  const type = scopeType || 'brand';
  if (!SCOPES.includes(type)) return { error: 'scopeType must be one of ' + SCOPES.join(', ') };
  const key = String(scopeKey || '').trim();
  if (type !== 'global' && !key) return { error: 'scopeKey is required for ' + type };
  const existing = db.prepare('SELECT * FROM alert_thresholds WHERE scope_type = ? AND scope_key = ?').get(type, type === 'global' ? '' : key);
  db.prepare(
    `INSERT INTO alert_thresholds(scope_type, scope_key, price_change_pct, low_stock, enabled)
      VALUES (?,?,?,?,?)
      ON CONFLICT(scope_type, scope_key) DO UPDATE SET price_change_pct = excluded.price_change_pct, low_stock = excluded.low_stock, enabled = excluded.enabled`
  ).run(
    type,
    type === 'global' ? '' : key,
    priceChangePct != null && priceChangePct !== '' ? Number(priceChangePct) : (existing ? existing.price_change_pct : null),
    lowStock != null && lowStock !== '' ? Number(lowStock) : (existing ? existing.low_stock : null),
    enabled != null ? (enabled ? 1 : 0) : (existing ? existing.enabled : 1)
  );
  audit(actor || 'user', 'alert-threshold-set', 'alert_thresholds', null, type + ':' + key);
  return { ok: true };
}

function removeThreshold(id, actor) {
  db.prepare('DELETE FROM alert_thresholds WHERE id = ?').run(Number(id));
  audit(actor || 'user', 'alert-threshold-remove', 'alert_thresholds', Number(id));
  return { ok: true };
}

function pick(row, field) {
  return row && row[field] != null && Number(row[field]) === Number(row[field]) ? Number(row[field]) : null;
}

// Resolve the effective threshold for one product/supplier pair.
function thresholdFor({ brand, productId, supplierCode } = {}) {
  const g = globalDefaults();
  let price = g.priceChangePct, low = g.lowStock, source = 'global';
  // supplier override (least specific of the overrides)
  if (supplierCode) {
    const r = db.prepare('SELECT * FROM alert_thresholds WHERE scope_type = ? AND scope_key = ? AND enabled = 1').get('supplier', String(supplierCode));
    if (r) { if (pick(r, 'price_change_pct') != null) { price = pick(r, 'price_change_pct'); source = 'supplier'; } if (pick(r, 'low_stock') != null) low = pick(r, 'low_stock'); }
  }
  // brand override
  if (brand) {
    const r = db.prepare('SELECT * FROM alert_thresholds WHERE scope_type = ? AND scope_key = ? AND enabled = 1').get('brand', String(brand));
    if (r) { if (pick(r, 'price_change_pct') != null) { price = pick(r, 'price_change_pct'); source = 'brand'; } if (pick(r, 'low_stock') != null) low = pick(r, 'low_stock'); }
  }
  // SKU override (most specific)
  if (productId) {
    const r = db.prepare('SELECT * FROM alert_thresholds WHERE scope_type = ? AND scope_key = ? AND enabled = 1').get('sku', String(productId));
    if (r) { if (pick(r, 'price_change_pct') != null) { price = pick(r, 'price_change_pct'); source = 'sku'; } if (pick(r, 'low_stock') != null) low = pick(r, 'low_stock'); }
  }
  return { priceChangePct: price, lowStock: low, source };
}

module.exports = { list, setThreshold, removeThreshold, thresholdFor, SCOPES };
