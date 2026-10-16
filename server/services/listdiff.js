'use strict';

// Compare two uploaded price lists (spreadsheets) and report what changed.
// The brief: "comparison between 2 Excels we upload". Keys are matched by
// barcode (EAN/UPC/GTIN) where present, otherwise by a normalised description,
// so a list with no barcodes still compares sensibly. Prices may differ by
// currency and locale; parsing is defensive (1.234,56 and 1,234.56 both work).

const XLSX = require('xlsx');
const gtin = require('../../src/lib/gtin');

const BARCODE = [/ean/i, /upc/i, /gtin/i, /barcode/i, /c[oó]digo.*barr/i, /codigoean/i];
const DESC = [/descrip/i, /nombre/i, /producto/i, /art[íi]culo/i, /^name$/i, /^desc/i, /detalle/i];
const PRICE = [/^precio/i, /^price/i, /^pvp/i, /^cost/i, /precio/i, /price/i, /pvp/i, /coste/i, /importe/i, /tarifa/i];
const QTY = [/stock/i, /cantidad/i, /disponible/i, /existencias/i, /uds/i, /unidades/i, /^qty$/i, /^quantity$/i];

function round4(n) { return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000; }

function normText(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).trim().replace(/[^0-9.,-]/g, '');
  if (!cleaned) return null;
  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');
  let s = cleaned;
  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) s = cleaned.replace(/\./g, '').replace(',', '.');
    else s = cleaned.replace(/,/g, '');
  } else if (hasComma) {
    const parts = cleaned.split(',');
    if (parts.length === 2 && parts[1].length <= 2) s = cleaned.replace(',', '.');
    else s = cleaned.replace(/,/g, '');
  } else {
    s = cleaned;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function findHeader(matrix) {
  const limit = Math.min(matrix.length, 40);
  for (let i = 0; i < limit; i++) {
    const row = (matrix[i] || []).map((c) => (c == null ? '' : String(c)));
    const hasBarcode = row.some((h) => BARCODE.some((re) => re.test(h)));
    const hasPrice = row.some((h) => PRICE.some((re) => re.test(h)));
    const hasDesc = row.some((h) => DESC.some((re) => re.test(h)));
    if ((hasBarcode && hasPrice) || (hasBarcode && hasDesc)) return i;
    if (hasDesc && hasPrice) return i;
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
  const price = pick(PRICE, [barcode]);
  const quantity = pick(QTY, [barcode, price]);
  const desc = pick(DESC, [barcode, price, quantity]);
  return { barcode, desc, price, quantity };
}

// Parse a spreadsheet buffer into { sheet, headerRow, columns, rows }.
function parseList(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  for (const sheetName of wb.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, blankrows: false, defval: '' });
    const h = findHeader(matrix);
    if (h < 0) continue;
    const header = (matrix[h] || []).map((c) => (c == null ? '' : String(c)).trim());
    const cols = mapColumns(header);
    if (cols.price < 0 && cols.desc < 0) continue;
    const rows = [];
    for (let i = h + 1; i < matrix.length; i++) {
      const r = matrix[i] || [];
      const rawBarcode = cols.barcode >= 0 ? String(r[cols.barcode] == null ? '' : r[cols.barcode]).trim() : '';
      const description = cols.desc >= 0 ? String(r[cols.desc] == null ? '' : r[cols.desc]).trim() : '';
      const price = cols.price >= 0 ? toNum(r[cols.price]) : null;
      const quantity = cols.quantity >= 0 ? toNum(r[cols.quantity]) : null;
      if (!rawBarcode && !description) continue;
      const g = rawBarcode ? gtin.analyse(rawBarcode) : { valid: false };
      const key = g.valid ? 'g:' + g.canonical14 : 'd:' + normText(description);
      if (key === 'd:') continue;
      rows.push({
        key, keyType: g.valid ? 'gtin' : 'description', barcode: rawBarcode,
        description, price, quantity, row: i + 1,
      });
    }
    return { sheet: sheetName, headerRow: h + 1, columns: cols, rows };
  }
  return { sheet: null, headerRow: 0, columns: { barcode: -1, desc: -1, price: -1, quantity: -1 }, rows: [] };
}

// Diff A (baseline) against B (new). Every entry carries from/to and the delta.
function diffLists(a, b) {
  const mapA = new Map();
  const mapB = new Map();
  for (const r of a.rows) mapA.set(r.key, r);
  for (const r of b.rows) mapB.set(r.key, r);

  const added = [];
  const removed = [];
  const priceChanges = [];
  const quantityChanges = [];
  const descriptionChanges = [];

  for (const [key, rb] of mapB) {
    const ra = mapA.get(key);
    if (!ra) { added.push(rb); continue; }
    if (ra.price != null && rb.price != null && ra.price !== rb.price) {
      const diff = round4(rb.price - ra.price);
      priceChanges.push({
        key, barcode: rb.barcode || ra.barcode, description: rb.description || ra.description,
        from: ra.price, to: rb.price, diff, pct: ra.price !== 0 ? round4((diff / ra.price) * 100) : null,
      });
    }
    if (ra.quantity != null && rb.quantity != null && ra.quantity !== rb.quantity) {
      quantityChanges.push({
        key, barcode: rb.barcode || ra.barcode, description: rb.description || ra.description,
        from: ra.quantity, to: rb.quantity, diff: round4(rb.quantity - ra.quantity),
      });
    }
    if (normText(ra.description) && normText(rb.description) && normText(ra.description) !== normText(rb.description)) {
      descriptionChanges.push({ key, barcode: rb.barcode || ra.barcode, from: ra.description, to: rb.description });
    }
  }
  for (const [key, ra] of mapA) if (!mapB.has(key)) removed.push(ra);

  const priceUp = priceChanges.filter((c) => c.diff > 0).length;
  const priceDown = priceChanges.filter((c) => c.diff < 0).length;
  const matched = a.rows.length - removed.length;

  return {
    added, removed, priceChanges, quantityChanges, descriptionChanges,
    summary: {
      aRows: a.rows.length, bRows: b.rows.length, matched,
      added: added.length, removed: removed.length,
      priceChanges: priceChanges.length, priceUp, priceDown,
      quantityChanges: quantityChanges.length, descriptionChanges: descriptionChanges.length,
    },
  };
}

module.exports = { parseList, diffLists, toNum, normText };
