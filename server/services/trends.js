'use strict';

const { db, getSetting } = require('../db');

// Round helper kept local so this module stays dependency-light.
function round4(n) {
  return Math.round((Number(n) + Number.EPSILON) * 1e4) / 1e4;
}

// Collapse observations to the latest row per upload (price list). Duplicate
// barcodes within a single file then count once, and a "movement" is always
// measured between successive supplier lists rather than within one.
function collapseByUpload(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = r.upload_id != null
      ? 'u' + r.upload_id
      : 'o' + (r.observed_at || '') + ':' + (r.id != null ? r.id : Math.random());
    byKey.set(key, r);
  }
  return [...byKey.values()];
}

// Compare the two most recent observations for one (supplier x barcode) series.
// Pure function over already-fetched rows so it can be unit-tested without a DB.
// `rows` must be ordered oldest -> newest; each row should carry unit_cost_base.
function computeTrend(rows) {
  const points = collapseByUpload(rows || [])
    .filter((r) => r && r.unit_cost_base != null && Number.isFinite(Number(r.unit_cost_base)));
  if (!points.length) {
    return { latest: null, previous: null, change: null, changePct: null, direction: 'none', observations: 0 };
  }
  const latest = points[points.length - 1];
  const previous = points.length > 1 ? points[points.length - 2] : null;
  const lc = Number(latest.unit_cost_base);
  const pc = previous != null ? Number(previous.unit_cost_base) : null;
  const change = pc != null ? round4(lc - pc) : null;
  const changePct = pc != null && pc > 0 ? round4(((lc - pc) / pc) * 100) : null;
  let direction = 'none';
  if (changePct != null) direction = changePct > 0.01 ? 'up' : (changePct < -0.01 ? 'down' : 'flat');
  return {
    latest: {
      observedAt: latest.observed_at,
      listDate: latest.list_date,
      price: latest.price,
      currency: latest.currency,
      unitCostBase: lc,
      priceBasis: latest.price_basis,
      priceType: latest.price_type,
    },
    previous: previous
      ? { observedAt: previous.observed_at, listDate: previous.list_date, price: previous.price, currency: previous.currency, unitCostBase: pc }
      : null,
    change,
    changePct,
    direction,
    observations: points.length,
  };
}

// Severity banding for a price move, given the configured alert threshold.
function severityForChange(changePct, threshold = 10) {
  const a = Math.abs(Number(changePct) || 0);
  if (a >= threshold * 2.5) return 'critical';
  if (a >= threshold) return 'warning';
  return 'info';
}

const HISTORY_SELECT = 'SELECT * FROM price_history WHERE supplier_code = ? AND gtin_canonical = ? ORDER BY observed_at ASC, id ASC';

function trendFor(supplierCode, gtin) {
  const rows = db.prepare(HISTORY_SELECT).all(supplierCode, gtin);
  return computeTrend(rows);
}

function distinctKeys() {
  return db.prepare(
    `SELECT supplier_code, gtin_canonical, MAX(product_id) AS product_id
     FROM price_history WHERE gtin_canonical IS NOT NULL
     GROUP BY supplier_code, gtin_canonical`
  ).all();
}

function productNames() {
  const out = {};
  for (const p of db.prepare('SELECT id, display_name, canonical_gtin FROM products').all()) {
    out[p.id] = p;
  }
  return out;
}

// Latest-vs-previous movement for every (supplier x barcode) series.
function allTrends(opts = {}) {
  const onlyChanged = !!opts.onlyChanged;
  const names = productNames();
  const rows = distinctKeys().map((k) => {
    const t = trendFor(k.supplier_code, k.gtin_canonical);
    const p = k.product_id != null ? names[k.product_id] : null;
    return {
      supplierCode: k.supplier_code,
      gtin: k.gtin_canonical,
      productId: k.product_id,
      displayName: p ? p.display_name : null,
      ...t,
    };
  });
  const filtered = onlyChanged ? rows.filter((r) => r.changePct != null && r.direction !== 'flat') : rows;
  return filtered.sort((a, b) => Math.abs(b.changePct || 0) - Math.abs(a.changePct || 0));
}

// Biggest movers (requires at least two observations).
function priceMovers(limit = 25) {
  return allTrends({ onlyChanged: true }).slice(0, limit);
}

// Per-supplier trend for every series touching a product.
function productTrends(productId) {
  const rows = db.prepare(
    `SELECT DISTINCT supplier_code, gtin_canonical FROM price_history WHERE product_id = ?`
  ).all(Number(productId));
  return rows.map((r) => ({ supplierCode: r.supplier_code, gtin: r.gtin_canonical, ...trendFor(r.supplier_code, r.gtin_canonical) }));
}

// Full observation list for one (supplier x barcode) series, oldest first.
function seriesFor(supplierCode, gtin) {
  return db.prepare(HISTORY_SELECT).all(supplierCode, gtin)
    .filter((r) => r.unit_cost_base != null && Number.isFinite(Number(r.unit_cost_base)))
    .map((r) => ({
      observedAt: r.observed_at,
      listDate: r.list_date,
      currency: r.currency,
      price: r.price,
      unitCostBase: r.unit_cost_base,
      fromImport: r.upload_id != null,
    }));
}

// Change over a rolling window (days). Uses the most recent observation at
// least `days` older than the latest one. Returns null when history does not go
// back that far — a gap is shown as "no data", never invented (§12).
function windowChange(points, days) {
  if (!points || points.length < 2) return null;
  const last = points[points.length - 1];
  const lastT = Date.parse(last.observedAt);
  const target = lastT - days * 86400000;
  let prior = null;
  for (const p of points) {
    if (Date.parse(p.observedAt) <= target) prior = p;
  }
  if (!prior) return null;
  const a = Number(prior.unitCostBase);
  const b = Number(last.unitCostBase);
  return { fromObservedAt: prior.observedAt, fromValue: a, toValue: b, change: round4(b - a), changePct: a > 0 ? round4(((b - a) / a) * 100) : null };
}

// Per-supplier series with the standard 7/30/90/180-day windows (§12/§13).
function productSeries(productId) {
  const keys = db.prepare(
    `SELECT DISTINCT supplier_code, gtin_canonical FROM price_history WHERE product_id = ?`
  ).all(Number(productId));
  return keys.map((k) => {
    const points = seriesFor(k.supplier_code, k.gtin_canonical);
    return {
      supplierCode: k.supplier_code,
      gtin: k.gtin_canonical,
      points,
      observations: points.length,
      windows: {
        d7: windowChange(points, 7),
        d30: windowChange(points, 30),
        d90: windowChange(points, 90),
        d180: windowChange(points, 180),
      },
    };
  });
}

module.exports = { computeTrend, severityForChange, trendFor, allTrends, priceMovers, productTrends, productSeries, windowChange, round4 };
