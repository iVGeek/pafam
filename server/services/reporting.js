'use strict';

const XLSX = require('xlsx');
const { db } = require('../db');
const pricing = require('./pricing');
const analytics = require('./analytics');
const orders = require('./orders');
const alerts = require('./alerts');
const sourcing = require('./sourcing');

function sheetFrom(rows, columns) {
  const header = columns.map((c) => c.title);
  const body = rows.map((r) => columns.map((c) => {
    const v = typeof c.value === 'function' ? c.value(r) : r[c.key];
    return v == null ? '' : v;
  }));
  const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
  ws['!cols'] = columns.map((c) => ({ wch: c.wch || 16 }));
  return ws;
}

function workbook(sheets) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    XLSX.utils.book_append_sheet(wb, sheetFrom(s.rows, s.columns), String(s.name).slice(0, 31));
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function opportunitiesSheet() {
  const { plausible } = analytics.opportunities(500);
  return {
    name: 'Opportunities',
    rows: plausible,
    columns: [
      { title: 'Product', key: 'displayName', wch: 46 },
      { title: 'Category', key: 'category', wch: 18 },
      { title: 'Size (ml)', key: 'sizeMl', wch: 10 },
      { title: 'Best supplier', key: 'bestSupplier', wch: 14 },
      { title: 'Best price', key: 'bestPrice', wch: 12 },
      { title: 'Dearest supplier', key: 'worstSupplier', wch: 16 },
      { title: 'Dearest price', key: 'worstPrice', wch: 14 },
      { title: 'Saving/bottle', key: 'savingPerBottle', wch: 14 },
      { title: 'Saving %', key: 'savingPct', wch: 10 },
    ],
  };
}

function dealsSheet() {
  const rows = db.prepare(
    `SELECT q.*, c.name AS customer_name, p.display_name
     FROM quotes q LEFT JOIN customers c ON c.id = q.customer_id
     LEFT JOIN products p ON p.id = q.product_id ORDER BY q.id DESC`
  ).all();
  return {
    name: 'Deals',
    rows,
    columns: [
      { title: 'Ref', key: 'id', wch: 8 },
      { title: 'Customer', key: 'customer_name', wch: 24 },
      { title: 'Product', key: 'display_name', wch: 40 },
      { title: 'Supplier', key: 'supplier_code', wch: 12 },
      { title: 'Qty', key: 'quantity', wch: 8 },
      { title: 'Unit cost', key: 'landed_unit_cost', wch: 12 },
      { title: 'Unit price', key: 'unit_price', wch: 12 },
      { title: 'Margin %', key: 'margin_pct', wch: 10 },
      { title: 'Contribution', key: 'contribution_total', wch: 14 },
      { title: 'ROI %', key: 'roi_pct', wch: 10 },
      { title: 'Capital', key: 'capital_required', wch: 12 },
      { title: 'Status', key: 'status', wch: 12 },
    ],
  };
}

function lowestSheet(limit = 200) {
  const destination = require('../db').getSetting('dest_market', 'US');
  const pids = db.prepare(
    `SELECT product_id FROM offers WHERE product_id IS NOT NULL
     GROUP BY product_id HAVING COUNT(DISTINCT supplier_code) > 1 LIMIT ?`
  ).all(limit).map((r) => r.product_id);
  const rows = [];
  for (const pid of pids) {
    let r;
    try { r = sourcing.sourceLowest({ productId: pid, quantity: 12, destination }); } catch (e) { continue; }
    if (!r || !r.winner) continue;
    rows.push({
      productId: pid,
      product: r.product.display_name,
      quantity: 12,
      destination,
      winner: r.winner.supplier,
      landedUnitCost: r.winner.landedUnitCost,
      currency: r.baseCurrency,
      complete: r.winner.complete,
      runnerUp: r.runnerUp ? r.runnerUp.supplier : '',
      savingsVsNext: r.savingsVsNext,
      offers: r.counts.offers,
      executable: r.counts.executable,
    });
  }
  return {
    name: 'Lowest Landed Cost',
    rows,
    columns: [
      { title: 'Product', key: 'product', wch: 46 },
      { title: 'Qty', key: 'quantity', wch: 8 },
      { title: 'Destination', key: 'destination', wch: 12 },
      { title: 'Winner', key: 'winner', wch: 14 },
      { title: 'Landed/unit', key: 'landedUnitCost', wch: 12 },
      { title: 'Currency', key: 'currency', wch: 10 },
      { title: 'Complete', key: 'complete', wch: 10 },
      { title: 'Runner-up', key: 'runnerUp', wch: 14 },
      { title: 'Saving vs next', key: 'savingsVsNext', wch: 14 },
      { title: 'Offers', key: 'offers', wch: 8 },
    ],
  };
}

function ordersSheet() {
  const rows = orders.listOrders(1000);
  return {
    name: 'Orders',
    rows,
    columns: [
      { title: 'Ref', key: 'ref', wch: 10 },
      { title: 'Customer', key: 'customer_name', wch: 24 },
      { title: 'Product', key: 'display_name', wch: 40 },
      { title: 'Supplier', key: 'supplier_code', wch: 12 },
      { title: 'Status', key: 'status', wch: 12 },
      { title: 'Qty', key: 'quantity', wch: 8 },
      { title: 'Unit cost', key: 'unit_cost', wch: 12 },
      { title: 'Unit price', key: 'unit_price', wch: 12 },
      { title: 'Forecast margin', value: (r) => r.realised.forecastMargin, wch: 16 },
      { title: 'Paid out', value: (r) => r.realised.paidOut, wch: 12 },
      { title: 'Paid in', value: (r) => r.realised.paidIn, wch: 12 },
      { title: 'Realised margin', value: (r) => r.realised.realisedMargin, wch: 16 },
      { title: 'Settled', value: (r) => (r.realised.settled ? 'yes' : 'no'), wch: 10 },
      { title: 'XIRR %', value: (r) => (r.realised.xirrPct != null ? r.realised.xirrPct : ''), wch: 10 },
      { title: 'Days funded', value: (r) => (r.realised.daysFunded != null ? r.realised.daysFunded : ''), wch: 12 },
    ],
  };
}

function alertsSheet() {
  const rows = alerts.listAlerts({ limit: 1000 });
  return {
    name: 'Alerts',
    rows,
    columns: [
      { title: 'Severity', key: 'severity', wch: 12 },
      { title: 'Type', key: 'type', wch: 16 },
      { title: 'Title', key: 'title', wch: 60 },
      { title: 'Supplier', key: 'supplier_code', wch: 12 },
      { title: 'Product', key: 'display_name', wch: 40 },
      { title: 'Created', key: 'created_at', wch: 20 },
      { title: 'Read', value: (r) => (r.read ? 'yes' : 'no'), wch: 8 },
    ],
  };
}

// Cash-basis general-ledger journal derived from recorded payments. Double
// entry: paying a supplier debits Purchases and credits Bank; receiving from a
// customer debits Bank and credits Sales. Intended to be imported into an
// accounting package (Xero / QuickBooks / Sage) or reconciled by hand.
function glSheet() {
  const rows = db.prepare(
    `SELECT p.*, o.ref AS order_ref, o.supplier_code
       FROM payments p JOIN orders o ON o.id = p.order_id
      ORDER BY p.paid_date, p.id`
  ).all();
  const lines = [];
  for (const p of rows) {
    const amount = Number(p.amount) || 0;
    const date = p.paid_date || p.created_at || '';
    const ref = p.order_ref + (p.reference ? ' / ' + p.reference : '');
    const memo = (p.direction === 'outbound' ? 'Supplier payment' : 'Customer receipt') + ' — ' + ref;
    if (p.direction === 'outbound') {
      lines.push({ date, account: 'Purchases', memo, debit: pricing.round2(amount), credit: 0, currency: p.currency, ref: p.order_ref });
      lines.push({ date, account: 'Bank', memo, debit: 0, credit: pricing.round2(amount), currency: p.currency, ref: p.order_ref });
    } else {
      lines.push({ date, account: 'Bank', memo, debit: pricing.round2(amount), credit: 0, currency: p.currency, ref: p.order_ref });
      lines.push({ date, account: 'Sales', memo, debit: 0, credit: pricing.round2(amount), currency: p.currency, ref: p.order_ref });
    }
  }
  const totalDebit = pricing.round2(lines.reduce((s, l) => s + l.debit, 0));
  const totalCredit = pricing.round2(lines.reduce((s, l) => s + l.credit, 0));
  lines.push({ date: '', account: '', memo: 'TOTAL', debit: totalDebit, credit: totalCredit, currency: '', ref: '' });
  return {
    name: 'GL Journal',
    rows: lines,
    columns: [
      { title: 'Date', key: 'date', wch: 14 },
      { title: 'Account', key: 'account', wch: 16 },
      { title: 'Memo', key: 'memo', wch: 52 },
      { title: 'Debit', key: 'debit', wch: 12 },
      { title: 'Credit', key: 'credit', wch: 12 },
      { title: 'Currency', key: 'currency', wch: 10 },
      { title: 'Reference', key: 'ref', wch: 14 },
    ],
  };
}

// Warehouse stock snapshot for import into a WMS or for physical stocktakes.
function stockSheet() {
  const reservations = require('./reservations');
  const rows = db.prepare(
    `SELECT i.*, p.display_name, p.canonical_gtin, p.category
       FROM inventory_lots i LEFT JOIN products p ON p.id = i.product_id
      ORDER BY i.id DESC`
  ).all();
  const enriched = rows.map((r) => {
    const avail = reservations.availableToSell(r.id);
    return {
      ...r,
      reserved_held: reservations.reservedFor(r.id),
      available_to_sell: avail == null ? '' : avail,
    };
  });
  return {
    name: 'Stock',
    rows: enriched,
    columns: [
      { title: 'SKU (barcode)', key: 'canonical_gtin', wch: 18 },
      { title: 'Product', key: 'display_name', wch: 46 },
      { title: 'Warehouse', key: 'warehouse', wch: 18 },
      { title: 'Lot', key: 'lot_reference', wch: 16 },
      { title: 'Supplier', key: 'supplier_code', wch: 12 },
      { title: 'On hand', key: 'on_hand', wch: 10 },
      { title: 'Quarantined', key: 'quarantined', wch: 12 },
      { title: 'Reserved (held)', key: 'reserved_held', wch: 14 },
      { title: 'Available to sell', key: 'available_to_sell', wch: 16 },
      { title: 'In transit', key: 'in_transit', wch: 10 },
      { title: 'Unit cost', key: 'unit_cost', wch: 12 },
      { title: 'Currency', key: 'currency', wch: 10 },
      { title: 'Expiry', key: 'expiry_date', wch: 14 },
      { title: 'Value', value: (r) => pricing.round2((Number(r.on_hand) || 0) * (Number(r.unit_cost) || 0)), wch: 14 },
    ],
  };
}

const BUILDERS = {
  opportunities: opportunitiesSheet,
  deals: dealsSheet,
  lowest: lowestSheet,
  orders: ordersSheet,
  alerts: alertsSheet,
  gl: glSheet,
  stock: stockSheet,
};

function build(kind) {
  const builder = BUILDERS[kind];
  if (!builder) return null;
  const sheet = builder();
  return workbook([sheet]);
}

// Customer-facing quotation: sell-side only. Deliberately omits supplier
// names, buying costs, margins and any internal reference (§4.7 / §16).
function quoteWorkbook(quoteId) {
  const q = db.prepare(
    `SELECT q.*, c.name AS customer_name, c.region, c.payment_terms AS customer_payment_terms,
            p.display_name, p.canonical_gtin, p.brand, p.fragrance, p.size_ml
       FROM quotes q
       LEFT JOIN customers c ON c.id = q.customer_id
       LEFT JOIN products p ON p.id = q.product_id
      WHERE q.id = ?`
  ).get(Number(quoteId));
  if (!q) return null;
  const unitPrice = q.selling_unit_price != null ? q.selling_unit_price : q.unit_price;
  const total = pricing.round2((Number(unitPrice) || 0) * (Number(q.quantity) || 0));
  const rows = [
    ['Customer quotation', ''],
    ['Quote reference', 'Q-' + String(q.id).padStart(4, '0')],
    ['Date', new Date().toISOString().slice(0, 10)],
    ['Customer', q.customer_name || ''],
    ['Region', q.region || ''],
    ['', ''],
    ['Product', q.display_name || ''],
    ['Barcode', q.canonical_gtin || ''],
    ['Brand', q.brand || ''],
    ['Size (ml)', q.size_ml || ''],
    ['', ''],
    ['Quantity', q.quantity],
    ['Unit price', pricing.round4(unitPrice)],
    ['Currency', q.currency || 'USD'],
    ['Total', total],
    ['Validity', q.validity_date || ''],
    ['Payment terms', q.terms || q.customer_payment_terms || ''],
    ['Delivery', q.customer_due_date ? 'By ' + q.customer_due_date : ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 22 }, { wch: 34 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Quote');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { build, quoteWorkbook, BUILDERS };
