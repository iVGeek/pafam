'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
for (const f of ['ptp.db', 'ptp.db-wal', 'ptp.db-shm']) {
  const p = path.join(DATA_DIR, f);
  if (fs.existsSync(p)) fs.rmSync(p, { force: true });
}

const { db } = require('./db');
const { importFile } = require('./services/importer');
const fx = require('./services/fx');
const auth = require('./services/auth');
const { parseNote } = require('../src/lib/notes');

const SAMPLES = path.join(__dirname, '..', 'samples');
console.log('Seeding database...');

for (const s of [
  { f: 'alcodis-supplier-1.xls', code: 'ALCODIS' },
  { f: 'igan-supplier-2.xlsx', code: 'IGAN' },
]) {
  const r = importFile(path.join(SAMPLES, s.f), { supplierCode: s.code, actor: 'seed' });
  console.log(`  imported ${s.code}:`, JSON.stringify(r));
}

// Demo FX rate
fx.setRate('EUR', 'USD', 1.08, { source: 'demo', rateDate: new Date().toISOString().slice(0, 10) });
fx.setRate('GBP', 'USD', 1.27, { source: 'demo', rateDate: new Date().toISOString().slice(0, 10) });

// Demo customers
const addCustomer = db.prepare(
  'INSERT INTO customers(code, name, region, currency, payment_terms, credit_limit) VALUES (?,?,?,?,?,?)'
);
const customers = [
  ['CUST-001', 'Atlantic Spirits LLC', 'US', 'USD', 'Net 30', 250000],
  ['CUST-002', 'Nordic Distribution AB', 'EU', 'EUR', 'Net 45', 120000],
  ['CUST-003', 'Gulf Trading FZE', 'ME', 'USD', 'Net 15', 300000],
];
const custIds = customers.map((c) => Number(addCustomer.run(...c).lastInsertRowid));

// Pick a few multi-supplier products for demo demand/inventory
const pidRows = db.prepare(
  `SELECT product_id FROM offers WHERE product_id IS NOT NULL
   GROUP BY product_id HAVING COUNT(DISTINCT supplier_code) > 1 LIMIT 8`
).all();
const pids = pidRows.map((r) => r.product_id);

const addDemand = db.prepare(
  `INSERT INTO demands(customer_id, product_id, status, quantity, target_price, currency, needed_by, source, approved, notes)
   VALUES (?,?,?,?,?,?,?,?,?,?)`
);
pids.slice(0, 5).forEach((pid, i) => {
  addDemand.run(custIds[i % custIds.length], pid, 'open', 100 + i * 50, null, 'USD',
    new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), 'manual', i < 2 ? 1 : 0, 'Demo demand');
});

const addInv = db.prepare(
  `INSERT INTO inventory_lots(product_id, supplier_code, warehouse, lot_reference, on_hand, reserved, in_transit, quarantined, unit_cost, currency)
   VALUES (?,?,?,?,?,?,?,?,?,?)`
);
pids.slice(0, 4).forEach((pid, i) => {
  addInv.run(pid, i % 2 ? 'IGAN' : 'ALCODIS', 'Madrid WH', 'LOT-' + (1000 + i), 60 + i * 20, 10, 40, 0, 8 + i, 'USD');
});

// ---- Users (roles) ----
auth.createUser({ username: 'admin', password: 'admin123', role: 'admin', displayName: 'Administrator', email: 'admin@ptp.local' });
auth.createUser({ username: 'buyer', password: 'buyer123', role: 'buyer', displayName: 'Sam Buyer', email: 'buyer@ptp.local' });
auth.createUser({ username: 'analyst', password: 'analyst123', role: 'analyst', displayName: 'Ada Analyst', email: 'analyst@ptp.local' });
auth.createUser({ username: 'viewer', password: 'viewer123', role: 'viewer', displayName: 'Vic Viewer', email: 'viewer@ptp.local' });

// ---- Captures (Plaud / reMarkable style notes) ----
const captureStmt = db.prepare('INSERT INTO captures(source, title, raw_text, parsed_json, created_by) VALUES (?,?,?,?,?)');
const demoCaptures = [
  {
    source: 'plaud', title: 'Call with Atlantic Spirits',
    text: 'Customer: Atlantic Spirits. They are interested in 500 bottles of Jack Daniels Old No.7 1L. Target price around 18.50 EUR. Need a quote by Friday, ship to New York. Barcode 5099873088333.',
    by: 'admin',
  },
  {
    source: 'remarkable', title: 'Trade fair notes',
    text: 'Nordic Distribution asked about Bacardi Carta Blanca. Quote 24 units at 7.20 USD per bottle, availability first.',
    by: 'buyer',
  },
  {
    source: 'plaud', title: 'Gulf Trading enquiry',
    text: 'Cliente Gulf Trading FZE, presupuesto para 1000 unidades de Vodka Absolut 1L, precio 9.90 USD, entrega Dubai.',
    by: 'analyst',
  },
];
for (const c of demoCaptures) {
  captureStmt.run(c.source, c.title, c.text, JSON.stringify(parseNote(c.text)), c.by);
}

console.log('Users:', db.prepare('SELECT COUNT(*) n FROM users').get().n, '| captures:', demoCaptures.length);
console.log('Demo customers:', custIds.length, '| demands:', pids.slice(0, 5).length, '| inventory lots:', pids.slice(0, 4).length);
console.log('Seed complete.');
console.log('  login: admin/admin123  buyer/buyer123  analyst/analyst123  viewer/viewer123');
console.log('  products:', db.prepare('SELECT COUNT(*) n FROM products').get().n);
console.log('  offers:  ', db.prepare('SELECT COUNT(*) n FROM offers').get().n);
console.log('  exceptions:', db.prepare('SELECT COUNT(*) n FROM exceptions').get().n);
