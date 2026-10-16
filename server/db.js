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
  recoverable_tax_pct REAL,
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
CREATE INDEX IF NOT EXISTS idx_inventory_lots_product ON inventory_lots(product_id);

-- Stock reservations (brief section 11 / 20): stock held for a specific
-- demand or order. Sum of active reservations per lot can never exceed
-- usable stock (on_hand - quarantined); in-transit stock is excluded
-- because it is not yet sellable.
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lot_id INTEGER NOT NULL REFERENCES inventory_lots(id) ON DELETE CASCADE,
  demand_id INTEGER REFERENCES demands(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id),
  quantity REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',   -- active | released | fulfilled
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reservations_lot ON reservations(lot_id, status);
CREATE INDEX IF NOT EXISTS idx_reservations_demand ON reservations(demand_id);

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
  supplier_code TEXT,
  dedupe_key TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per observed (supplier list x barcode x import). Captures the price
-- we saw at a point in time so the trend/alert engine can detect movements
-- across successive supplier price lists rather than only the latest snapshot.
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_code TEXT NOT NULL,
  gtin_canonical TEXT,
  product_id INTEGER,
  upload_id INTEGER REFERENCES uploads(id) ON DELETE CASCADE,
  offer_id INTEGER,
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  list_date TEXT,
  currency TEXT,
  price REAL,
  price_basis TEXT,                 -- unit | case | multipack
  price_type TEXT,                  -- cost | rrp
  units_per_case REAL,
  unit_cost_base REAL,              -- normalised acquisition cost per bottle, base currency
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_price_history_key ON price_history(supplier_code, gtin_canonical);
CREATE INDEX IF NOT EXISTS idx_price_history_product ON price_history(product_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Purchase / sales orders created from a deal (or manually) and the payments
-- booked against them. Realised margin is derived from the actual payments,
-- so forecast vs actual can be compared.
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE,
  quote_id INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
  demand_id INTEGER REFERENCES demands(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES customers(id),
  supplier_code TEXT,
  product_id INTEGER REFERENCES products(id),
  offer_id INTEGER,
  quantity REAL NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  unit_cost REAL,                    -- forecast landed cost per unit
  unit_price REAL,                   -- forecast selling price per unit
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | placed | received | shipped | delivered | closed | cancelled
  order_date TEXT,
  supplier_due TEXT,
  customer_due TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_product ON orders(product_id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,           -- inbound (customer) | outbound (supplier)
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  paid_date TEXT,
  method TEXT,
  reference TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

-- Supplier order placements: the "order placement" tab — cost price and
-- full-box quantities, ready to send to a supplier. One header per supplier
-- order, many lines. Kept separate from the orders table (which is one row per
-- deal and drives payments / realised margin).
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE,
  supplier_code TEXT,
  currency TEXT NOT NULL DEFAULT 'EUR',
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | placed | sent | confirmed | received | cancelled
  incoterm TEXT,
  order_date TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_code);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  offer_id INTEGER,
  barcode TEXT,
  description TEXT,
  units_per_case REAL,
  boxes REAL NOT NULL DEFAULT 0,
  units REAL NOT NULL DEFAULT 0,
  unit_cost REAL,
  line_total REAL,
  moq REAL,
  order_multiple REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_po ON purchase_order_lines(po_id);

-- PFI (proforma invoice) reconciliation against a placement. The supplier's
-- PFI is uploaded as Excel (primary record); a PDF can be attached for the
-- file. The parsed comparison is snapshotted in the detail column so history
-- survives deletion of the source file.
CREATE TABLE IF NOT EXISTS pfi_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  reference TEXT,
  filename TEXT,
  currency TEXT,
  order_total REAL,
  pfi_total REAL,
  variance_total REAL,
  variance_pct REAL,
  lines_matched INTEGER,
  lines_changed INTEGER,
  attachment_path TEXT,
  attachment_name TEXT,
  detail TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pfi_documents_po ON pfi_documents(po_id);

-- Shipment cost allocation (brief section 8 control 2): a shipment's cost is
-- allocated across the offers/orders it carries using one documented driver
-- (chargeable weight, volume or value). The allocated amounts MUST reconcile
-- to the shipment total — enforced in services/shipments.js.
CREATE TABLE IF NOT EXISTS shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE,
  direction TEXT NOT NULL DEFAULT 'inbound',   -- inbound (from supplier) | outbound (to customer)
  supplier_code TEXT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  incoterm TEXT,
  cost_type TEXT NOT NULL DEFAULT 'freight',  -- freight | duty | insurance | brokerage | handling | other
  total_cost REAL NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  driver TEXT NOT NULL DEFAULT 'value',       -- weight | volume | value  (documented allocation basis)
  total_weight_kg REAL,
  total_volume_m3 REAL,
  declared_value REAL,
  shipped_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft',        -- draft | allocated | reconciled
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);

CREATE TABLE IF NOT EXISTS shipment_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  offer_id INTEGER,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  quantity REAL NOT NULL DEFAULT 0,
  basis_value REAL NOT NULL DEFAULT 0,        -- the driver's amount for this line
  allocated_cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alloc_shipment ON shipment_allocations(shipment_id);

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

-- Follow-up tasks (brief section 15): a captured note is not a deal until a
-- human has done something about it. Every capture that looks like a lead
-- gets an open task so it cannot silently rot in the inbox.
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capture_id INTEGER REFERENCES captures(id) ON DELETE CASCADE,
  demand_id INTEGER REFERENCES demands(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  detail TEXT,
  due_date TEXT,
  owner TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',   -- low | normal | high
  status TEXT NOT NULL DEFAULT 'open',       -- open | done | cancelled
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  completed_by TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_capture ON tasks(capture_id);
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
    ['recoverable_tax_pct', 'REAL'],
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

  // alerts: supplier + dedupe key for the trend/alert engine. Indexes are
  // created here (not in SCHEMA) so they land after the additive columns on
  // databases created by an earlier version.
  for (const [c, ddl] of [['supplier_code', 'TEXT'], ['dedupe_key', 'TEXT']]) ensureColumn('alerts', c, ddl);
  db.exec('CREATE INDEX IF NOT EXISTS idx_alerts_dedupe ON alerts(dedupe_key)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_alerts_read ON alerts(read)');

  // offers: staff approval (brief sections 3, 16, 20). This is deliberately
  // separate from `status`, which records the *matching* outcome (new /
  // matched / exception / ignored). Approval records who signed off on the
  // price and quantity, which is a different decision made by a different role.
  const offerApprovalCols = [
    ['approval_status', "TEXT NOT NULL DEFAULT 'review'"],  // review | approved | rejected | expired
    ['approved_by', 'TEXT'],
    ['approved_at', 'TEXT'],
    ['review_note', 'TEXT'],
  ];
  for (const [c, ddl] of offerApprovalCols) ensureColumn('offers', c, ddl);
  db.exec('CREATE INDEX IF NOT EXISTS idx_offers_approval ON offers(approval_status)');

  // offers: where units-per-case came from (brief section 6). A pack size read
  // off the supplier's own file is stronger evidence than one parsed out of the
  // description text, and "unknown" must stay unknown rather than becoming 1.
  ensureColumn('offers', 'units_per_case_source', "TEXT NOT NULL DEFAULT 'unknown'");

  // demands: version history (brief section 15). A revised demand is never
  // edited in place — a new row supersedes the old one and links back to it, so
  // "what we believed, and when" is always recoverable.
  ensureColumn('demands', 'supersedes_demand_id', 'INTEGER');
  ensureColumn('demands', 'superseded_by_demand_id', 'INTEGER');

  // uploads: the auto-cleaned snapshot of every import (the system standard
  // template). Kept beside the audit row so the UI can offer the cleaned file
  // without re-cleaning, and so we know whether cleaning ran and for how many
  // rows.
  ensureColumn('uploads', 'cleaned_path', 'TEXT');
  ensureColumn('uploads', 'cleaned_rows', 'INTEGER');
  ensureColumn('uploads', 'cleaned_at', 'TEXT');
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
    default_recoverable_tax_pct: '0',
    default_supplier_advance_pct: '0',
    default_customer_deposit_pct: '0',
    default_supplier_payment_days: '0',
    default_customer_payment_days: '30',
    default_transit_days: '0',
    price_change_alert_pct: '10',
    low_stock_threshold: '10',
    alert_dedupe_days: '7',
    capital_limit: '250000',
    require_offer_approval: '0',
    auto_clean_imports: '1',
    followup_days: '2',
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
