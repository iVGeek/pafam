'use strict';

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// Configurable so a hosted deploy can point at a persistent disk
// (e.g. Render's mounted disk at /var/data).
const DATA_DIR = process.env.PTP_DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.PTP_DB || path.join(DATA_DIR, 'ptp.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS suppliers (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  incoterm TEXT,
  incoterm_place TEXT,
  price_type TEXT NOT NULL DEFAULT 'cost',      -- cost | rrp
  default_discount_pct REAL DEFAULT 0,           -- when price_type = rrp
  stock_country TEXT,
  origin_country TEXT,
  payment_terms TEXT,
  -- landed-cost build-up inputs (brief section 7/8)
  duty_pct REAL,
  freight_per_unit REAL,
  insurance_pct REAL,
  brokerage_per_unit REAL,
  handling_per_unit REAL,
  other_tax_pct REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_code TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  sheet TEXT,
  header_row INTEGER,
  list_date TEXT,
  rows_total INTEGER DEFAULT 0,
  rows_imported INTEGER DEFAULT 0,
  rows_blank_barcode INTEGER DEFAULT 0,
  rows_invalid_barcode INTEGER DEFAULT 0,
  is_duplicate INTEGER DEFAULT 0,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (supplier_code, file_hash)
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_gtin TEXT UNIQUE,
  internal_sku TEXT,
  brand TEXT,
  fragrance TEXT,
  concentration TEXT,
  size_ml REAL,
  category TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS product_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  alias_type TEXT NOT NULL,        -- gtin | case_gtin | sku | text
  alias_value TEXT NOT NULL,
  packaging_level TEXT,             -- unit | case | multipack
  units_per_case REAL,
  source TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alias_value ON product_aliases(alias_type, alias_value);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_id INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  supplier_code TEXT NOT NULL,
  source_row INTEGER,
  list_date TEXT,
  gtin_source TEXT,
  gtin_canonical TEXT,
  gtin_valid INTEGER DEFAULT 0,
  gtin_type TEXT,
  case_gtin_source TEXT,
  case_gtin_canonical TEXT,
  internal_sku TEXT,
  category TEXT,
  description TEXT,
  size_ml REAL,
  abv REAL,
  currency TEXT,
  price REAL,
  price_basis TEXT,                 -- unit | case | multipack
  price_type TEXT,                  -- cost | rrp
  units_per_case REAL,
  rrp REAL,
  available_quantity REAL,
  quantity_unit TEXT,
  moq REAL,                          -- minimum order quantity
  order_multiple REAL,               -- order must be a multiple of this
  tier_min REAL,
  tier_max REAL,
  tiers_json TEXT,                   -- quantity price breaks [{min,max,price,basis}]
  incoterm TEXT,
  incoterm_place TEXT,
  valid_until TEXT,
  ready_date TEXT,
  lead_time_days REAL,
  country_of_origin TEXT,
  stock_country TEXT,
  stock_warehouse TEXT,
  last_confirmed_at TEXT,
  stock_confidence TEXT,
  permitted_destination TEXT,
  us_suitability TEXT,
  freight_inclusions TEXT,
  stock_owner_id TEXT,
  unique_lot_ref TEXT,
  expiry_date TEXT,
  notes TEXT,
  cap_type TEXT,
  refillable INTEGER,
  product_id INTEGER REFERENCES products(id),
  status TEXT NOT NULL DEFAULT 'new',  -- new | matched | exception | ignored
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_offers_gtin ON offers(gtin_canonical);
CREATE INDEX IF NOT EXISTS idx_offers_supplier ON offers(supplier_code);
CREATE INDEX IF NOT EXISTS idx_offers_product ON offers(product_id);

CREATE TABLE IF NOT EXISTS exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_id INTEGER REFERENCES uploads(id) ON DELETE CASCADE,
  offer_id INTEGER REFERENCES offers(id) ON DELETE CASCADE,
  type TEXT NOT NULL,              -- blank_barcode | invalid_barcode | duplicate | mismatch | no_price
  detail TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  supplier_code TEXT,
  warehouse TEXT,
  lot_reference TEXT,
  on_hand REAL NOT NULL DEFAULT 0,
  reserved REAL NOT NULL DEFAULT 0,
  in_transit REAL NOT NULL DEFAULT 0,
  quarantined REAL NOT NULL DEFAULT 0,
  unit_cost REAL,
  currency TEXT DEFAULT 'USD',
  expiry_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inv_product ON inventory_lots(product_id);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  region TEXT,
  currency TEXT DEFAULT 'USD',
  payment_terms TEXT,
  credit_limit REAL,
  sanctioned INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS demands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open',   -- open | matched | quoted | won | lost | expired
  quantity REAL NOT NULL DEFAULT 0,
  target_price REAL,
  currency TEXT DEFAULT 'USD',
  needed_by TEXT,
  captured_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT DEFAULT 'manual',          -- manual | email | note
  approved INTEGER NOT NULL DEFAULT 0,
  expiry_date TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_demands_product ON demands(product_id);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  demand_id INTEGER REFERENCES demands(id) ON DELETE SET NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  currency TEXT DEFAULT 'USD',
  landed_unit_cost REAL,
  margin_pct REAL,
  offer_id INTEGER,
  supplier_code TEXT,
  net_unit_revenue REAL,
  contribution_total REAL,
  roi_pct REAL,
  annualised_roi_pct REAL,
  capital_required REAL,
  capital_days REAL,
  order_date TEXT,
  supplier_due_date TEXT,
  customer_due_date TEXT,
  selling_unit_price REAL,
  validity_date TEXT,
  terms TEXT,
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | sent | accepted | rejected | expired
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fx_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_currency TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  rate REAL NOT NULL,
  rate_date TEXT NOT NULL,
  source TEXT,
  booked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (base_currency, quote_currency, rate_date, source)
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',   -- info | warning | critical
  title TEXT NOT NULL,
  detail TEXT,
  product_id INTEGER,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',   -- admin | buyer | analyst | viewer
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'manual',   -- plaud | remarkable | manual | webhook
  title TEXT,
  raw_text TEXT,
  captured_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'new',      -- new | promoted | ignored
  parsed_json TEXT,
  created_by TEXT,
  demand_id INTEGER REFERENCES demands(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_captures_status ON captures(status);
`;

// Lightweight additive migrations for databases created by an earlier version.
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

function migrate() {
  // offers: quantity tiers / MOQ / validity / eligibility (brief sections 5, 7).
  const offerCols = [
    ['moq', 'REAL'],
    ['order_multiple', 'REAL'],
    ['tier_min', 'REAL'],
    ['tier_max', 'REAL'],
    ['tiers_json', 'TEXT'],
    ['valid_until', 'TEXT'],
    ['ready_date', 'TEXT'],
    ['lead_time_days', 'REAL'],
    ['country_of_origin', 'TEXT'],
    ['stock_country', 'TEXT'],
    ['stock_warehouse', 'TEXT'],
    ['last_confirmed_at', 'TEXT'],
    ['stock_confidence', 'TEXT'],
    ['permitted_destination', 'TEXT'],
    ['us_suitability', 'TEXT'],
    ['freight_inclusions', 'TEXT'],
    ['stock_owner_id', 'TEXT'],
    ['unique_lot_ref', 'TEXT'],
  ];
  for (const [c, ddl] of offerCols) ensureColumn('offers', c, ddl);

  // suppliers: landed-cost build-up inputs (brief section 7/8).
  const supplierCols = [
    ['duty_pct', 'REAL'],
    ['freight_per_unit', 'REAL'],
    ['insurance_pct', 'REAL'],
    ['brokerage_per_unit', 'REAL'],
    ['handling_per_unit', 'REAL'],
    ['other_tax_pct', 'REAL'],
    ['origin_country', 'TEXT'],
  ];
  for (const [c, ddl] of supplierCols) ensureColumn('suppliers', c, ddl);

  // quotes: promote a quote into a full saved deal (contribution + cash flow).
  const quoteCols = [
    ['offer_id', 'INTEGER'],
    ['supplier_code', 'TEXT'],
    ['net_unit_revenue', 'REAL'],
    ['contribution_total', 'REAL'],
    ['roi_pct', 'REAL'],
    ['annualised_roi_pct', 'REAL'],
    ['capital_required', 'REAL'],
    ['capital_days', 'REAL'],
    ['order_date', 'TEXT'],
    ['supplier_due_date', 'TEXT'],
    ['customer_due_date', 'TEXT'],
    ['selling_unit_price', 'REAL'],
  ];
  for (const [c, ddl] of quoteCols) ensureColumn('quotes', c, ddl);
}

function init() {
  db.exec(SCHEMA);
  migrate();
  const defaults = {
    base_currency: 'USD',
    home_currency: 'USD',
    selling_currency: 'USD',
    dest_market: 'US',
    min_margin_pct: '15',
    min_markup: '0.75',
    default_duty_pct: '0',
    default_brokerage: '0',
    default_freight_per_unit: '0',
    default_insurance_pct: '0',
    default_handling_per_unit: '0',
    default_other_tax_pct: '0',
    default_supplier_payment_days: '0',
    default_customer_payment_days: '30',
    default_transit_days: '0',
    session_hours: '168',
    capture_secret: 'change-me-capture-secret',
  };
  const stmt = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaults)) stmt.run(k, v);
}

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function audit(actor, action, entity, entityId, detail) {
  db.prepare('INSERT INTO audit_log(actor, action, entity, entity_id, detail) VALUES (?,?,?,?,?)')
    .run(actor || 'system', action, entity || null, entityId != null ? String(entityId) : null, detail || null);
}

init();

module.exports = { db, DB_PATH, init, getSetting, setSetting, audit };
