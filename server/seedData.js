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

  // Demo landed-cost build-up inputs per supplier (editable under Suppliers).
  // Values are illustrative assumptions so the "lowest landed cost" view has
  // complete costs out of the box.
  const supUpdate = db.prepare(
    `UPDATE suppliers SET origin_country = ?, duty_pct = ?, freight_per_unit = ?, insurance_pct = ?,
       brokerage_per_unit = ?, handling_per_unit = ?, other_tax_pct = ?, payment_terms = ? WHERE code = ?`
  );
  supUpdate.run('ES', 5.4, 0.65, 0.4, 0.12, 0.08, 0, 'Net 30', 'ALCODIS');
  supUpdate.run('ES', 5.4, 0.72, 0.4, 0.1, 0.06, 0, 'Prepay', 'IGAN');

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

  // Demo MOQ / order multiple / quantity tiers / eligibility on the
  // multi-supplier products, so the "lowest executable landed cost" page has
  // real quantity-break examples.
  const todayStr = new Date().toISOString().slice(0, 10);
  const updAlcodis = db.prepare(
    `UPDATE offers SET moq = 12, order_multiple = 6, last_confirmed_at = ?, stock_confidence = 'confirmed',
       permitted_destination = 'US,CA,MX', us_suitability = 'ok', tiers_json = ?
     WHERE product_id = ? AND supplier_code = 'ALCODIS'`
  );
  const updIgan = db.prepare(
    `UPDATE offers SET moq = 24, order_multiple = 12, last_confirmed_at = ?,
       permitted_destination = 'US,CA,MX', us_suitability = 'ok'
     WHERE product_id = ? AND supplier_code = 'IGAN'`
  );
  const rt = (n) => Math.round(n * 100) / 100;
  for (const pid of pids) {
    const alc = db.prepare(`SELECT price FROM offers WHERE product_id = ? AND supplier_code = 'ALCODIS' LIMIT 1`).get(pid);
    const tiers = alc && alc.price
      ? JSON.stringify([{ min: 1, max: 11, price: alc.price }, { min: 12, max: 59, price: rt(alc.price * 0.95) }, { min: 60, price: rt(alc.price * 0.9) }])
      : null;
    updAlcodis.run(todayStr, tiers, pid);
    updIgan.run(todayStr, pid);
  }

  const addDemand = db.prepare(
    `INSERT INTO demands(customer_id, product_id, status, quantity, target_price, currency, needed_by, source, approved, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  pids.slice(0, 5).forEach((pid, i) => {
    addDemand.run(custIds[i % custIds.length], pid, 'open', 120 + i * 60, i < 2 ? 12.0 : null, 'USD',
      new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), 'manual', i < 2 ? 1 : 0, 'Demo demand');
  });

const addInv = db.prepare(
    `INSERT INTO inventory_lots(product_id, supplier_code, warehouse, lot_reference, on_hand, reserved, in_transit, quarantined, unit_cost, currency)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  );
  const lotIds = [];
  pids.slice(0, 4).forEach((pid, i) => {
    const info = addInv.run(pid, i % 2 ? 'IGAN' : 'ALCODIS', 'Madrid WH', 'LOT-' + (1000 + i), 60 + i * 20, 0, 40, 0, 8 + i, 'USD');
    lotIds.push(Number(info.lastInsertRowid));
  });

  // Demo reservations so the available-to-sell view is meaningful. Held via
  // real reservation rows (not a hand-set column) so the oversell guard has
  // something to reason about.
  const reservationsSvc = require('./services/reservations');
  lotIds.slice(0, 2).forEach((lotId, i) => {
    reservationsSvc.reserve({ lotId, quantity: 10, customerId: custIds[i], notes: 'Demo hold', actor: 'seed' });
  });

  // Demo orders with payments so the realised-margin view has data: one fully
  // settled, one where the supplier is paid but the customer still owes, and
  // one still a draft with no payments.
  const ordersSvc = require('./services/orders');
  const demoOrders = [
    { pid: pids[0], cust: custIds[0], qty: 200, cost: 8.5, price: 12.5, status: 'closed',
      out: 1700, in: 2500, ordDate: new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10),
      // Supplier paid on the order date, customer pays 45 days later: a real
      // capital cycle, so the XIRR on the dated payments is meaningful.
      outDate: new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10),
      inDate: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10) },
    { pid: pids[1], cust: custIds[1], qty: 100, cost: 10, price: 15, status: 'delivered',
      out: 1000, in: 600, ordDate: new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10),
      outDate: new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10),
      inDate: new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10) },
    { pid: pids[2], cust: custIds[2], qty: 50, cost: 6, price: 9, status: 'draft',
      out: 0, in: 0, ordDate: new Date().toISOString().slice(0, 10) },
  ];
  let ordersCreated = 0;
  for (const d of demoOrders) {
    if (d.pid == null) continue;
    const r = ordersSvc.createOrder({
      customerId: d.cust, productId: d.pid, supplierCode: 'ALCODIS',
      quantity: d.qty, unitCost: d.cost, unitPrice: d.price, status: d.status,
      orderDate: d.ordDate,
      supplierDue: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
      customerDue: new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10),
    });
    if (r.error) continue;
    ordersCreated++;
    if (d.out) ordersSvc.recordPayment(r.id, { direction: 'outbound', amount: d.out, paidDate: d.outDate || d.ordDate, method: 'Transfer', reference: 'PO-' + r.id });
    if (d.in) ordersSvc.recordPayment(r.id, { direction: 'inbound', amount: d.in, paidDate: d.inDate || d.ordDate, method: 'Transfer', reference: 'INV-' + r.id });
  }

  // Several months of delivered history for one product/customer so the demand
  // forecast has enough observations to be meaningful (never extrapolate noise).
  const histPid = pids[0];
  const histCust = custIds[0];
  if (histPid != null) {
    const histQtys = [80, 95, 110, 90, 120, 105];
    histQtys.forEach((qty, i) => {
      const monthsAgo = histQtys.length - i;
      const r = ordersSvc.createOrder({
        customerId: histCust, productId: histPid, supplierCode: 'ALCODIS',
        quantity: qty, unitCost: 8.5, unitPrice: 12.5, status: 'delivered',
        orderDate: new Date(Date.now() - monthsAgo * 30 * 864e5).toISOString().slice(0, 10),
        supplierDue: new Date(Date.now() - (monthsAgo - 1) * 30 * 864e5).toISOString().slice(0, 10),
        customerDue: new Date(Date.now() - (monthsAgo - 0.5) * 30 * 864e5).toISOString().slice(0, 10),
        notes: 'Historical delivery (forecast baseline)',
      });
      if (!r.error) ordersCreated++;
    });
  }

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

  // Seed a small price-history trail so the trend/alert engine has at least
  // two observations per (supplier x product) where we have overlap. This
  // produces plausible price movements (±10%) to exercise the UI.
  try {
    const fxr = (c) => (c === 'USD' ? 1 : (c === 'GBP' ? 1.27 : 1.08));
    const pricing = require('./services/pricing');
    const alertsMod = require('./services/alerts');
    const ph = db.prepare(
      `INSERT INTO price_history(supplier_code, gtin_canonical, product_id, upload_id, offer_id,
         observed_at, list_date, currency, price, price_basis, price_type, units_per_case, unit_cost_base)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const delta = [0.9, 0.94, 0.97, 0.99, 1.0, 1.02, 1.05, 1.1];
    const pidsAll = db.prepare(
      `SELECT DISTINCT product_id FROM offers WHERE product_id IS NOT NULL
       GROUP BY product_id HAVING COUNT(DISTINCT supplier_code) > 0 LIMIT 12`
    ).all().map((r) => r.product_id);
    for (const pid of pidsAll) {
      // Replace any import-time history for the demo products with a clean
      // two-observation trail so the movements are meaningful to look at.
      db.prepare('DELETE FROM price_history WHERE product_id = ?').run(pid);
      for (const sup of ['ALCODIS', 'IGAN']) {
        const o = db.prepare(
          `SELECT o.*, MIN(o.id) AS min_id FROM offers o WHERE o.product_id = ? AND o.supplier_code = ? GROUP BY o.product_id, o.supplier_code`
        ).get(pid, sup);
        if (!o || o.price == null) continue;
        const supRow = db.prepare('SELECT default_discount_pct FROM suppliers WHERE code = ?').get(sup);
        const acq = pricing.unitAcquisitionPrice({
          price: o.price,
          price_type: o.price_type,
          price_basis: o.price_basis,
          units_per_case: o.units_per_case || 1,
          default_discount_pct: (supRow && supRow.default_discount_pct) || 0,
        });
        const f = fxr(o.currency || 'EUR');
        const baseUnit = acq.perBottle != null ? Math.round(acq.perBottle * f * 1e6) / 1e6 : null;
        if (baseUnit == null) continue;
        const listA = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
        const listB = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
        const d1 = delta[Math.floor(Math.random() * delta.length)];
        const d2 = delta[Math.floor(Math.random() * delta.length)];
        ph.run(o.supplier_code, o.gtin_canonical, o.product_id, null, o.min_id,
          new Date(Date.now() - 61 * 864e5).toISOString(), listA, o.currency, o.price * d1, o.price_basis, o.price_type, o.units_per_case, Math.round(baseUnit * d1 * 1e4) / 1e4);
        ph.run(o.supplier_code, o.gtin_canonical, o.product_id, null, o.min_id,
          new Date(Date.now() - 29 * 864e5).toISOString(), listB, o.currency, o.price * d2, o.price_basis, o.price_type, o.units_per_case, Math.round(baseUnit * d2 * 1e4) / 1e4);
      }
    }
    try { alertsMod.generateAlerts({ actor: 'seed' }); } catch (e) { console.warn('alert gen after seed failed:', e.message); }
  } catch (e) { console.warn('price history seed skipped:', e.message); }

  return {
    products: db.prepare('SELECT COUNT(*) n FROM products').get().n,
    offers: db.prepare('SELECT COUNT(*) n FROM offers').get().n,
    exceptions: db.prepare('SELECT COUNT(*) n FROM exceptions').get().n,
    users: usersCreated,
    captures: demoCaptures.length,
    alerts: db.prepare('SELECT COUNT(*) n FROM alerts').get().n,
    priceHistory: db.prepare('SELECT COUNT(*) n FROM price_history').get().n,
    orders: db.prepare('SELECT COUNT(*) n FROM orders').get().n,
  };
}

module.exports = { seedData, SAMPLES };
