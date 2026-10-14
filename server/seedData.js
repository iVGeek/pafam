'use strict';

const path = require('path');
const { db } = require('./db');
const { importFile } = require('./services/importer');
const fx = require('./services/fx');
const auth = require('./services/auth');
const { parseNote } = require('../src/lib/notes');

const SAMPLES = path.join(__dirname, '..', 'samples');

// Populates an already-initialised (empty) database with supplier lists plus
// demo trading data. Safe to call from a fresh boot; user creation tolerates
// pre-existing usernames.
function seedData(opts = {}) {
  const log = opts.log || (() => {});

  for (const s of [
    { f: 'alcodis-supplier-1.xls', code: 'ALCODIS' },
    { f: 'igan-supplier-2.xlsx', code: 'IGAN' },
  ]) {
    const r = importFile(path.join(SAMPLES, s.f), { supplierCode: s.code, actor: 'seed' });
    log(`imported ${s.code}: ${JSON.stringify(r)}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  fx.setRate('EUR', 'USD', 1.08, { source: 'demo', rateDate: today });
  fx.setRate('GBP', 'USD', 1.27, { source: 'demo', rateDate: today });

  const addCustomer = db.prepare(
    'INSERT INTO customers(code, name, region, currency, payment_terms, credit_limit) VALUES (?,?,?,?,?,?)'
  );
  const customers = [
    ['CUST-001', 'Atlantic Spirits LLC', 'US', 'USD', 'Net 30', 250000],
    ['CUST-002', 'Nordic Distribution AB', 'EU', 'EUR', 'Net 45', 120000],
    ['CUST-003', 'Gulf Trading FZE', 'ME', 'USD', 'Net 15', 300000],
  ];
  const custIds = customers.map((c) => Number(addCustomer.run(...c).lastInsertRowid));

  const pids = db.prepare(
    `SELECT product_id FROM offers WHERE product_id IS NOT NULL
     GROUP BY product_id HAVING COUNT(DISTINCT supplier_code) > 1 LIMIT 8`
  ).all().map((r) => r.product_id);

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

  // Users (roles). Passwords are env-overridable so a hosted instance is not
  // left on known demo credentials.
  const demoUsers = process.env.PTP_SEED_DEMO_USERS !== 'false';
  const users = [
    { username: process.env.PTP_ADMIN_USER || 'admin', password: process.env.PTP_ADMIN_PASS || 'admin123', role: 'admin', displayName: 'Administrator', email: 'admin@ptp.local' },
  ];
  if (demoUsers) {
    users.push(
      { username: 'buyer', password: process.env.PTP_BUYER_PASS || 'buyer123', role: 'buyer', displayName: 'Sam Buyer', email: 'buyer@ptp.local' },
      { username: 'analyst', password: process.env.PTP_ANALYST_PASS || 'analyst123', role: 'analyst', displayName: 'Ada Analyst', email: 'analyst@ptp.local' },
      { username: 'viewer', password: process.env.PTP_VIEWER_PASS || 'viewer123', role: 'viewer', displayName: 'Vic Viewer', email: 'viewer@ptp.local' },
    );
  }
  let usersCreated = 0;
  for (const u of users) {
    try { auth.createUser(u); usersCreated++; }
    catch (e) { if (e.status !== 409) throw e; }
  }

  const captureStmt = db.prepare('INSERT INTO captures(source, title, raw_text, parsed_json, created_by) VALUES (?,?,?,?,?)');
  const demoCaptures = [
    { source: 'plaud', title: 'Call with Atlantic Spirits', by: 'admin',
      text: 'Customer: Atlantic Spirits. They are interested in 500 bottles of Jack Daniels Old No.7 1L. Target price around 18.50 EUR. Need a quote by Friday, ship to New York. Barcode 5099873088333.' },
    { source: 'remarkable', title: 'Trade fair notes', by: 'buyer',
      text: 'Nordic Distribution asked about Bacardi Carta Blanca. Quote 24 units at 7.20 USD per bottle, availability first.' },
    { source: 'plaud', title: 'Gulf Trading enquiry', by: 'analyst',
      text: 'Cliente Gulf Trading FZE, presupuesto para 1000 unidades de Vodka Absolut 1L, precio 9.90 USD, entrega Dubai.' },
  ];
  for (const c of demoCaptures) captureStmt.run(c.source, c.title, c.text, JSON.stringify(parseNote(c.text)), c.by);

  return {
    products: db.prepare('SELECT COUNT(*) n FROM products').get().n,
    offers: db.prepare('SELECT COUNT(*) n FROM offers').get().n,
    exceptions: db.prepare('SELECT COUNT(*) n FROM exceptions').get().n,
    users: usersCreated,
    captures: demoCaptures.length,
  };
}

module.exports = { seedData, SAMPLES };
