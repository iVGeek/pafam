'use strict';

// Order placement vs supplier PFI (proforma invoice). The PFI is the supplier's
// confirmation of what they will ship and charge; we compare it line by line
// against what we placed. Excel is the primary form (parseable); a PDF can be
// attached for the record. Nothing here converts currency — a PFI is assumed to
// be denominated in the placement's currency.

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const gtin = require('../../src/lib/gtin');
const { toNum } = require('./listdiff');
const { db, DB_PATH, audit } = require('../db');

const BARCODE = [/ean/i, /upc/i, /gtin/i, /barcode/i, /c[oó]digo.*barr/i, /codigoean/i];
const DESC = [/descrip/i, /nombre/i, /producto/i, /art[íi]culo/i, /^name$/i, /^desc/i, /detalle/i];
const UNIT = [/precio/i, /price/i, /coste/i, /cost/i, /pvp/i, /tarifa/i, /^unit.*(price|cost)/i, /^unit(e)?$/i, /^unit\b(?!s?\s*\/)/i];
const TOTAL = [/importe/i, /^total/i, /amount/i, /subtotal/i, /^line.*total/i];
const QTY = [/cantidad/i, /^qty$/i, /^quantity$/i, /uds/i, /unidades/i, /^units?$/i, /stock/i];

function round4(n) { return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000; }

function normDesc(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// A stable key for matching: the canonical GTIN when the barcode is valid,
// otherwise the normalised description.
function keyFor(barcode, description) {
  if (barcode) {
    const g = gtin.analyse(String(barcode));
    if (g.valid) return 'g:' + g.canonical14;
  }
  const d = normDesc(description);
  return d ? 'd:' + d : null;
}

function findHeader(matrix) {
  const limit = Math.min(matrix.length, 40);
  for (let i = 0; i < limit; i++) {
    const row = (matrix[i] || []).map((c) => (c == null ? '' : String(c)));
    const hasKey = row.some((h) => BARCODE.some((re) => re.test(h))) || row.some((h) => DESC.some((re) => re.test(h)));
    const hasMoney = row.some((h) => UNIT.some((re) => re.test(h))) || row.some((h) => TOTAL.some((re) => re.test(h)));
    const hasQty = row.some((h) => QTY.some((re) => re.test(h)));
    if (hasKey && (hasMoney || hasQty)) return i;
  }
  return -1;
}

function mapColumns(header) {
  const pick = (patterns, exclude) => {
    for (const re of patterns) {
      const idx = header.findIndex((h, i) => re.test(h) && !exclude.includes(i));
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const barcode = header.findIndex((h) => BARCODE.some((re) => re.test(h)));
  const total = pick(TOTAL, [barcode]);
  const unit = pick(UNIT, [barcode, total]);
  const quantity = pick(QTY, [barcode, total, unit]);
  const desc = pick(DESC, [barcode, total, unit, quantity]);
  return { barcode, desc, unit, total, quantity };
}

// Parse a PFI spreadsheet into rows { key, barcode, description, quantity,
// unitPrice, lineTotal } plus a document total.
function parsePfi(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  for (const sheetName of wb.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, blankrows: false, defval: '' });
    const h = findHeader(matrix);
    if (h < 0) continue;
    const header = (matrix[h] || []).map((c) => String(c == null ? '' : c).trim());
    const cols = mapColumns(header);
    const rows = [];
    for (let i = h + 1; i < matrix.length; i++) {
      const r = matrix[i] || [];
      const barcode = cols.barcode >= 0 ? String(r[cols.barcode] == null ? '' : r[cols.barcode]).trim() : '';
      const description = cols.desc >= 0 ? String(r[cols.desc] == null ? '' : r[cols.desc]).trim() : '';
      const quantity = cols.quantity >= 0 ? toNum(r[cols.quantity]) : null;
      let unitPrice = cols.unit >= 0 ? toNum(r[cols.unit]) : null;
      let lineTotal = cols.total >= 0 ? toNum(r[cols.total]) : null;
      if (unitPrice == null && lineTotal != null && quantity) unitPrice = round4(lineTotal / quantity);
      if (lineTotal == null && unitPrice != null && quantity != null) lineTotal = round4(unitPrice * quantity);
      const key = keyFor(barcode, description);
      if (!key) continue;
      rows.push({ key, keyType: key[0] === 'g' ? 'gtin' : 'description', barcode, description, quantity, unitPrice, lineTotal, row: i + 1 });
    }
    const pfiTotal = round4(rows.reduce((s, x) => s + (x.lineTotal != null ? x.lineTotal : (x.unitPrice != null && x.quantity != null ? x.unitPrice * x.quantity : 0)), 0));
    return { sheet: sheetName, headerRow: h + 1, columns: cols, rows, pfiTotal };
  }
  return { sheet: null, headerRow: 0, columns: { barcode: -1, desc: -1, unit: -1, total: -1, quantity: -1 }, rows: [], pfiTotal: 0 };
}

// Compare a PFI against a placement. Matched lines carry ordered vs PFI
// quantity / unit price / line total and their deltas.
function compareToPlacement(placement, pfi) {
  const ordered = new Map();
  for (const l of placement.lines) {
    const k = keyFor(l.barcode, l.description);
    if (k && !ordered.has(k)) ordered.set(k, l);
  }
  const seen = new Set();
  const matched = [];
  const extra = [];
  for (const r of pfi.rows) {
    const ol = ordered.get(r.key);
    if (!ol) { extra.push(r); continue; }
    seen.add(r.key);
    const orderedUnits = Number(ol.units) || 0;
    const orderedUnitCost = ol.unit_cost != null ? Number(ol.unit_cost) : null;
    const orderedTotal = ol.line_total != null ? Number(ol.line_total) : null;
    const qtyDiff = r.quantity != null ? round4(orderedUnits - r.quantity) : null;
    const priceDiff = (orderedUnitCost != null && r.unitPrice != null) ? round4(r.unitPrice - orderedUnitCost) : null;
    const pricePct = (priceDiff != null && orderedUnitCost) ? round4((priceDiff / orderedUnitCost) * 100) : null;
    const totalDiff = (orderedTotal != null && r.lineTotal != null) ? round4(r.lineTotal - orderedTotal) : null;
    matched.push({
      key: r.key, barcode: r.barcode || ol.barcode, description: r.description || ol.description,
      orderedUnits, pfiQuantity: r.quantity, qtyDiff,
      orderedUnitCost, pfiUnitPrice: r.unitPrice, priceDiff, pricePct,
      orderedTotal, pfiTotal: r.lineTotal, totalDiff,
    });
  }
  const missing = [];
  for (const [k, ol] of ordered) if (!seen.has(k)) missing.push(ol);

  const orderTotal = round4(placement.lines.reduce((s, l) => s + (Number(l.line_total) || 0), 0));
  const priceChanges = matched.filter((m) => m.priceDiff != null && Math.abs(m.priceDiff) > 0.00005);
  const quantityChanges = matched.filter((m) => m.qtyDiff != null && m.qtyDiff !== 0);
  const clean = matched.filter((m) => priceChanges.indexOf(m) < 0 && quantityChanges.indexOf(m) < 0);
  const varianceTotal = round4(pfi.pfiTotal - orderTotal);

  return {
    matched, extra, missing,
    orderTotal, pfiTotal: pfi.pfiTotal, varianceTotal,
    summary: {
      orderLines: placement.lines.length, pfiRows: pfi.rows.length,
      matched: matched.length, clean: clean.length,
      priceChanges: priceChanges.length, quantityChanges: quantityChanges.length,
      extra: extra.length, missing: missing.length,
    },
  };
}

function pfiDir() {
  const dir = path.join(path.dirname(DB_PATH), 'pfi');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Persist a comparison. `detail` holds the (capped) matched/extra/missing so the
// history can be re-opened without the original file.
function savePfi(poId, opts) {
  const info = db.prepare(
    `INSERT INTO pfi_documents(po_id, reference, filename, currency, order_total, pfi_total, variance_total, variance_pct, lines_matched, lines_changed, detail, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    Number(poId), opts.reference || null, opts.filename || null, opts.currency || null,
    opts.orderTotal != null ? opts.orderTotal : null, opts.pfiTotal || null,
    opts.varianceTotal != null ? opts.varianceTotal : null, opts.variancePct != null ? opts.variancePct : null,
    opts.linesMatched || 0, opts.linesChanged || 0, JSON.stringify(opts.detail || {}), opts.createdBy || null
  );
  audit(opts.createdBy || 'user', 'pfi-reconcile', 'purchase_order', Number(poId), `${opts.filename || ''} variance ${opts.varianceTotal}`);
  return Number(info.lastInsertRowid);
}

function listPfi(poId) {
  return db.prepare('SELECT * FROM pfi_documents WHERE po_id = ? ORDER BY id DESC').all(Number(poId));
}

function getPfi(id) {
  const row = db.prepare('SELECT * FROM pfi_documents WHERE id = ?').get(Number(id));
  if (row && typeof row.detail === 'string') { try { row.detail = JSON.parse(row.detail); } catch (e) { /* keep raw */ } }
  return row || null;
}

function attachPdf(pfiId, file) {
  const rec = db.prepare('SELECT id FROM pfi_documents WHERE id = ?').get(Number(pfiId));
  if (!rec) return null;
  const dir = pfiDir();
  const safe = String(file.originalname || 'pfi.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
  const stored = path.join(dir, `pfi-${pfiId}-${Date.now()}-${safe}`);
  fs.writeFileSync(stored, file.buffer);
  db.prepare('UPDATE pfi_documents SET attachment_path = ?, attachment_name = ? WHERE id = ?')
    .run(stored, file.originalname || safe, Number(pfiId));
  return { path: stored, name: file.originalname || safe };
}

function attachment(pfiId) {
  const rec = getPfi(pfiId);
  if (!rec || !rec.attachment_path || !fs.existsSync(rec.attachment_path)) return null;
  return { buffer: fs.readFileSync(rec.attachment_path), filename: rec.attachment_name || path.basename(rec.attachment_path) };
}

function removePfi(pfiId) {
  const rec = getPfi(pfiId);
  if (!rec) return false;
  if (rec.attachment_path) { try { fs.unlinkSync(rec.attachment_path); } catch (_) { /* ignore */ } }
  db.prepare('DELETE FROM pfi_documents WHERE id = ?').run(Number(pfiId));
  return true;
}

module.exports = { parsePfi, compareToPlacement, savePfi, listPfi, getPfi, attachPdf, attachment, removePfi, keyFor, round4 };
