'use strict';

const XLSX = require('xlsx');
const { db, audit } = require('../db');
const pricing = require('./pricing');
const { roundUpTo } = require('./recommend');
const { consolidateDemands } = require('./purchasePlan');

function round4(n) { return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000; }

// Full-box rounding: a target unit count rounds up to whole boxes of a pack
// size. This is the "full box quantities" rule the client asked for — you
// cannot order a part box from a supplier.
function toFullBoxes(units, unitsPerCase) {
  const upc = Number(unitsPerCase) > 0 ? Number(unitsPerCase) : 1;
  const target = Math.max(0, Number(units) || 0);
  const rounded = roundUpTo(target > 0 ? target : upc, upc);
  return { unitsPerCase: upc, units: rounded, boxes: Math.round(rounded / upc), roundedUpFrom: target };
}

function getOffer(offerId) {
  return db.prepare(
    `SELECT o.*, s.default_discount_pct FROM offers o JOIN suppliers s ON s.code = o.supplier_code WHERE o.id = ?`
  ).get(Number(offerId));
}

// Normalise one raw line into a stored shape: cost from the offer (or typed),
// pack size from the offer, boxes <-> units, and MOQ / order-multiple warnings.
function normalizeLine(input = {}) {
  const offer = input.offerId ? getOffer(input.offerId) : null;
  const productId = input.productId != null ? Number(input.productId)
    : (offer && offer.product_id != null ? Number(offer.product_id) : null);
  const product = productId ? db.prepare('SELECT * FROM products WHERE id = ?').get(productId) : null;

  let unitCost = input.unitCost != null && input.unitCost !== '' ? Number(input.unitCost) : null;
  let currency = input.currency || null;
  let upc = input.unitsPerCase != null && input.unitsPerCase !== '' ? Number(input.unitsPerCase) : null;
  let barcode = input.barcode != null && input.barcode !== '' ? String(input.barcode) : null;
  let description = input.description || null;

  if (offer) {
    if (unitCost == null) {
      const acq = pricing.unitAcquisitionPrice(offer);
      if (Number.isFinite(acq.perBottle)) unitCost = acq.perBottle;
    }
    if (upc == null) upc = Number(offer.units_per_case) || null;
    if (!currency) currency = offer.currency;
    if (!barcode) barcode = offer.gtin_source || offer.gtin_canonical || null;
    if (!description) description = offer.description || null;
  }
  upc = Number(upc) > 0 ? Number(upc) : 1;

  let boxes = input.boxes != null && input.boxes !== '' ? Math.max(0, Math.floor(Number(input.boxes))) : null;
  let units = input.units != null && input.units !== '' ? Math.max(0, Number(input.units)) : null;
  if (boxes != null) {
    units = boxes * upc;
  } else if (units != null) {
    const fb = toFullBoxes(units, upc);
    boxes = fb.boxes;
    units = fb.units;
  } else {
    boxes = 0;
    units = 0;
  }

  const moq = offer ? (Number(offer.moq) || null) : null;
  const orderMultiple = offer ? (Number(offer.order_multiple) || null) : null;
  const warnings = [];
  if (moq && units < moq) warnings.push(`below MOQ (${moq})`);
  if (orderMultiple && units % orderMultiple !== 0) warnings.push(`not a multiple of ${orderMultiple}`);
  if (!productId) warnings.push('no product linked');

  return {
    product_id: productId,
    offer_id: offer ? offer.id : null,
    barcode,
    description: description || (product && product.display_name) || '',
    units_per_case: upc,
    boxes,
    units,
    unit_cost: unitCost,
    line_total: round4((Number(unitCost) || 0) * units),
    moq,
    order_multiple: orderMultiple,
    currency,
    warnings,
  };
}

function nextRef() {
  const n = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM purchase_orders').get().n;
  return 'PO-' + String(n).padStart(4, '0');
}

function createPlacement(body = {}) {
  const supplierCode = body.supplierCode || null;
  if (!supplierCode) return { error: 'supplierCode required' };
  const lines = (Array.isArray(body.lines) ? body.lines : [])
    .map(normalizeLine)
    .filter((l) => l.units > 0 || l.unit_cost != null);
  if (!lines.length) return { error: 'at least one line required' };

  const currency = body.currency || (lines.find((l) => l.currency) || {}).currency || 'EUR';
  const info = db.prepare(
    `INSERT INTO purchase_orders(ref, supplier_code, currency, status, incoterm, order_date, notes, created_by)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    nextRef(), supplierCode, currency, body.status || 'draft', body.incoterm || null,
    body.orderDate || new Date().toISOString().slice(0, 10), body.notes || null, body.createdBy || null
  );
  const poId = Number(info.lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO purchase_order_lines(po_id, product_id, offer_id, barcode, description, units_per_case, boxes, units, unit_cost, line_total, moq, order_multiple)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const l of lines) {
    ins.run(poId, l.product_id, l.offer_id, l.barcode, l.description, l.units_per_case, l.boxes, l.units, l.unit_cost, l.line_total, l.moq, l.order_multiple);
  }
  audit(body.createdBy || 'user', 'placement-create', 'purchase_order', poId, `${lines.length} lines, ${currency}`);
  return { ok: true, id: poId, ref: db.prepare('SELECT ref FROM purchase_orders WHERE id = ?').get(poId).ref };
}

function computeTotals(lines) {
  let total = 0;
  let units = 0;
  let boxes = 0;
  for (const l of lines) {
    total += Number(l.line_total) || 0;
    units += Number(l.units) || 0;
    boxes += Number(l.boxes) || 0;
  }
  return { total: round4(total), units, boxes, lineCount: lines.length };
}

function getPlacement(id) {
  const header = db.prepare(
    `SELECT po.*, s.name AS supplier_name FROM purchase_orders po LEFT JOIN suppliers s ON s.code = po.supplier_code WHERE po.id = ?`
  ).get(Number(id));
  if (!header) return null;
  const lines = db.prepare('SELECT * FROM purchase_order_lines WHERE po_id = ? ORDER BY id').all(header.id);
  return { ...header, lines, totals: computeTotals(lines) };
}

function listPlacements(limit = 200) {
  const headers = db.prepare(
    `SELECT po.*, s.name AS supplier_name,
       (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.po_id = po.id) AS line_count,
       (SELECT COALESCE(SUM(line_total),0) FROM purchase_order_lines l WHERE l.po_id = po.id) AS total
     FROM purchase_orders po LEFT JOIN suppliers s ON s.code = po.supplier_code
     ORDER BY po.id DESC LIMIT ?`
  ).all(Math.min(Number(limit) || 200, 500));
  return headers;
}

// Candidate lines for a supplier drawn from the live purchase plan (demand
// matched to that supplier), so a placement can start from the plan.
function planForSupplier(supplierCode) {
  const { items } = consolidateDemands();
  const lines = [];
  for (const it of items) {
    if (!it.supplier || !it.supplier.code) continue;
    if (supplierCode && it.supplier.code !== supplierCode) continue;
    if (!it.supplier.offerId) continue;
    const offer = getOffer(it.supplier.offerId);
    if (!offer) continue;
    const acq = pricing.unitAcquisitionPrice(offer);
    const upc = Number(offer.units_per_case) > 0 ? Number(offer.units_per_case) : null;
    const suggested = it.orderQuantity;
    const fb = upc ? toFullBoxes(suggested, upc) : { boxes: null, units: suggested };
    lines.push({
      productId: it.productId,
      offerId: offer.id,
      description: (it.product && it.product.displayName) || offer.description,
      barcode: offer.gtin_source || offer.gtin_canonical || (it.product && it.product.canonicalGtin) || null,
      unitsPerCase: upc,
      suggestedUnits: suggested,
      suggestedBoxes: fb.boxes,
      unitCost: Number.isFinite(acq.perBottle) ? round4(acq.perBottle) : null,
      currency: offer.currency,
      moq: Number(offer.moq) || null,
      orderMultiple: Number(offer.order_multiple) || null,
      demandQuantity: it.demandQuantity,
      contribution: it.contribution,
      executable: it.executable,
    });
  }
  const suppliers = [...new Set(items.map((i) => i.supplier && i.supplier.code).filter(Boolean))];
  return { supplierCode: supplierCode || null, suppliers, lines };
}

// The data behind a placement export. One source of truth: the .xlsx and the
// PDF are both built from this, so they cannot disagree.
function placementData(id) {
  const p = getPlacement(id);
  if (!p) return null;
  return {
    placement: p,
    ref: p.ref,
    title: 'Supplier order placement',
    meta: [
      ['Supplier', p.supplier_name || p.supplier_code || ''],
      ['Order date', p.order_date || ''],
      ['Currency', p.currency || ''],
      ['Incoterm', p.incoterm || ''],
      ['Status', p.status || ''],
      ['Notes', p.notes || ''],
    ],
    columns: [
      { title: '#', key: 'idx', wch: 5 },
      { title: 'Barcode', key: 'barcode', wch: 16 },
      { title: 'Description', key: 'description', wch: 46 },
      { title: 'Units / case', key: 'units_per_case', wch: 11 },
      { title: 'Boxes', key: 'boxes', wch: 8 },
      { title: 'Units', key: 'units', wch: 9 },
      { title: 'Unit cost', key: 'unit_cost', wch: 12 },
      { title: 'Line total', key: 'line_total', wch: 13 },
    ],
    rows: p.lines.map((l, i) => ({
      idx: i + 1,
      barcode: l.barcode || '',
      description: l.description || '',
      units_per_case: l.units_per_case || '',
      boxes: l.boxes || 0,
      units: l.units || 0,
      unit_cost: l.unit_cost != null ? round4(l.unit_cost) : '',
      line_total: l.line_total != null ? round4(l.line_total) : '',
    })),
    totals: [
      ['Total units', p.totals.units],
      ['Total', p.totals.total],
    ],
  };
}

// Supplier-facing workbook: cost prices and full-box quantities, ready to send.
function placementWorkbook(id) {
  const d = placementData(id);
  if (!d) return null;
  const header = [
    ['Supplier order placement', d.ref],
    ...d.meta,
    [],
    d.columns.map((c) => c.title),
  ];
  const body = d.rows.map((r) => d.columns.map((c) => r[c.key]));
  const tail = [
    [],
    ['', '', '', '', 'Total units', '', '', d.totals[0][1]],
    ['', '', '', '', 'Total', '', '', d.totals[1][1]],
  ];
  const ws = XLSX.utils.aoa_to_sheet([...header, ...body, ...tail]);
  ws['!cols'] = [{ wch: 5 }, { wch: 16 }, { wch: 46 }, { wch: 11 }, { wch: 8 }, { wch: 9 }, { wch: 12 }, { wch: 13 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Placement');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), filename: `placement-${d.ref || id}.xlsx` };
}

// Supplier-facing PDF: same data, print-ready.
function placementPdf(id) {
  const d = placementData(id);
  if (!d) return null;
  const pdf = require('./pdf');
  return pdf.sheetPdf(
    { title: `${d.title} ${d.ref || ''}`.trim(), meta: d.meta, columns: d.columns, rows: d.rows },
    { orientation: 'landscape', notes: d.totals.map((t) => `${t[0]}: ${t[1]}`) }
  ).then((buffer) => ({ buffer, filename: `placement-${d.ref || id}.pdf` }));
}

module.exports = { toFullBoxes, normalizeLine, createPlacement, getPlacement, listPlacements, planForSupplier, placementData, placementWorkbook, placementPdf, computeTotals };
