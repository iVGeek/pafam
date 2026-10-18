'use strict';

// Automatic "clean to the standard supplier template" step.
//
// Every import produces messy vendor rows. After the importer has stored them,
// this module rewrites them onto the system's standard template (exactly the
// columns and enums in supplier-template.xlsx) and drops the result next to the
// database, so a clean, conformant snapshot of every import exists without
// anyone asking for it.
//
// It never invents a value: anything it cannot derive is left blank, because
// the template's own rule is "blank = unknown, never 0".

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { db, DB_PATH } = require('../db');

// ---------------------------------------------------------------------------
// The standard template. Column order and titles mirror supplier-template.xlsx
// (Offers sheet). Keep in sync; a test asserts the two agree.
// ---------------------------------------------------------------------------
const TEMPLATE_COLUMNS = [
  'Supplier ID', 'Supplier name', 'Offer ID', 'List date', 'Valid until',
  'Last stock confirmation', 'Source file', 'Source row', 'Original EAN / UPC',
  'Internal SKU', 'Brand', 'Fragrance name', 'Concentration', 'Size (ml)',
  'Gender / category', 'Set contents', 'Retail pack or tester', 'With / without cap',
  'With / without box', 'Sealed or unboxed', 'Damage status', 'Batch / lot reference',
  'Manufacture date', 'Currency', 'Price', 'Price basis', 'Units per case',
  'Available quantity', 'Quantity unit', 'MOQ', 'Order multiple',
  'Price tier minimum', 'Price tier maximum', 'Stock country', 'Stock warehouse',
  'Country of origin', 'Incoterm', 'Incoterm named place', 'Ready date', 'Lead time',
  'Payment terms', 'Freight inclusions', 'Permitted destination', 'Permitted channels',
  'US suitability status', 'Authenticity documents', 'Stock owner ID',
  'Unique lot reference', 'Stock confidence',
];

const ENUMS = {
  Concentration: ['EDP', 'EDT', 'EDC', 'Parfum', 'Other'],
  'Gender / category': ['Men', 'Women', 'Unisex', 'Other'],
  'Retail pack or tester': ['Retail', 'Tester', 'Gift set', 'Refill'],
  'Sealed or unboxed': ['Sealed', 'Unboxed'],
  'Damage status': ['None', 'Minor', 'Major', 'Unknown'],
  'With / without cap': ['Yes', 'No', 'Unknown'],
  'With / without box': ['Yes', 'No', 'Unknown'],
  'Price basis': ['Unit', 'Case'],
  Incoterm: ['EXW', 'FOB', 'CIF', 'DAP', 'DDP', 'FCA', 'CPT'],
  'US suitability status': ['Eligible', 'Review', 'Not eligible'],
  'Stock confidence': ['Firm', 'Indicative', 'On request'],
};

const INCOTERMS = new Set(ENUMS.Incoterm);

// ---------------------------------------------------------------------------
// Derivation helpers
// ---------------------------------------------------------------------------
function stripDiacritics(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function norm(s) {
  return stripDiacritics(s).toLowerCase().replace(/[^a-z0-9&\-\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Best-effort fragrance-house recognition. Longest match wins, so "Yves Saint
// Laurent" beats "Yves" and "Tom Ford" beats a stray "Ford".
const BRANDS = [
  'Yves Saint Laurent', 'Giorgio Armani', 'Jean Paul Gaultier', 'Maison Francis Kurkdjian',
  'Parfums de Marly', 'Salvatore Ferragamo', 'Narciso Rodriguez', 'Elizabeth Arden',
  'Carolina Herrera', 'Dolce & Gabbana', 'Jo Malone London', 'Ralph Lauren',
  'Issey Miyake', 'Louis Vuitton', 'Calvin Klein', 'Viktor&Rolf', 'Hugo Boss',
  'Paco Rabanne', 'Marc Jacobs', 'Montblanc', 'Mercedes-Benz', 'Tom Ford', 'Bvlgari',
  'Versace', 'Valentino', 'Givenchy', 'Burberry', 'Guerlain', 'Lancôme', 'Chanel',
  'Dior', 'Creed', 'Mugler', 'Prada', 'Gucci', 'Azzaro', 'Bentley', 'Hermès',
  'Byredo', 'Xerjoff', 'Amouage', 'Nishane', 'Initio', 'Kenzo', 'Chloé',
  'Le Labo', 'Davidoff', 'Clinique', 'Estée Lauder',
];
const BRANDS_BY_LEN = BRANDS.slice().sort((a, b) => b.length - a.length);

function parseConcentration(...texts) {
  const t = norm(texts.filter(Boolean).join(' '));
  if (!t) return '';
  if (/\beau de parfum\b/.test(t) || /\bedp\b/.test(t)) return 'EDP';
  if (/\beau de toilette\b/.test(t) || /\bedt\b/.test(t)) return 'EDT';
  if (/\beau de cologne\b/.test(t) || /\bedc\b/.test(t)) return 'EDC';
  if (/\bextrait\b/.test(t)) return 'Parfum';
  if (/\bparfum\b/.test(t) || /\bperfume\b/.test(t)) return 'Parfum';
  return '';
}

function parseGender(...texts) {
  const t = norm(texts.filter(Boolean).join(' '));
  if (!t) return '';
  if (/\bunisex\b/.test(t)) return 'Unisex';
  if (/\b(mujer|women|woman|female|femme|dama|pour femme|her)\b/.test(t)) return 'Women';
  if (/\b(hombre|men|male|homme|pour homme|caballero|him)\b/.test(t)) return 'Men';
  return '';
}

function parseBrand(description) {
  const raw = String(description || '').trim();
  if (!raw) return { brand: '', rest: '' };
  const n = norm(raw);
  for (const b of BRANDS_BY_LEN) {
    const nb = norm(b);
    if (n === nb || n.startsWith(nb + ' ')) {
      // Brand name may carry different punctuation in the source; return the
      // canonical spelling and the remainder of the description.
      return { brand: b, rest: raw.slice(nb.length).trim() };
    }
  }
  // Unknown house: take the leading word as the brand.
  const m = raw.match(/^([^\s]+)\s*(.*)$/);
  return { brand: m ? m[1] : raw, rest: m ? m[2].trim() : '' };
}

function titleIfShouty(s) {
  if (!s) return '';
  if (s === s.toUpperCase() && /[A-Z]/.test(s)) {
    return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return s;
}

function parseFragrance(rest, sizeMl) {
  let s = String(rest || '');
  // Remove packaging / marketing words and concentration phrases.
  s = s.replace(/\b(eau de parfum|eau de toilette|eau de cologne|extrait de parfum|extrait|parfum|perfume|edp|edt|edc|vaporizador|vaporiser|vap\.?|spray|refill|recarga)\b/gi, ' ');
  // Sizes that carry a unit ("30 ml", "1.7 oz"-style handled by the parser).
  s = s.replace(/\b0?\d[\d.,]*\s*(ml|mililitros?|l|litros?|litres?)\b\.?/gi, ' ');
  // Pack phrases ("6 UDS").
  s = s.replace(/\b\d{1,3}\s*(uds?|unid(?:ades)?|pcs|pack|packs|bot(?:ellas?)?)\b/gi, ' ');
  // A lone trailing size number ("Bleu de Chanel 100") — only when it matches
  // the size we already know, so a name like "N°5" or "No 5" is left intact.
  if (sizeMl != null && Number(sizeMl) > 0) {
    const target = Number(sizeMl);
    s = s.replace(/(^|\s)(\d[\d.,]*)(?=\s|$)/g, (m, pre, n) =>
      Number(String(n).replace(',', '.')) === target ? pre : m);
  }
  s = s.replace(/\([^)]*\)/g, ' ');
  s = s.replace(/[·|]+/g, ' ');
  s = s.replace(/\s{2,}/g, ' ').replace(/^[\s,.\-–]+|[\s,.\-–]+$/g, '');
  return titleIfShouty(s.trim());
}

function parseRetailPack(...texts) {
  const t = norm(texts.filter(Boolean).join(' '));
  if (/tester|probador|testeur/.test(t)) return 'Tester';
  if (/gift set|estuche|coffret|set de regalo|cofanetto|cofre/.test(t)) return 'Gift set';
  if (/refill|recarga|recharge/.test(t)) return 'Refill';
  return 'Retail';
}

function parseSize(description, sizeMl) {
  if (sizeMl != null && Number(sizeMl) > 0) return Number(sizeMl);
  const m = String(description || '').match(/(\d[\d.,]*)\s*(?:ml|mililitros)\b/i);
  if (m) { const n = Number(String(m[1]).replace(',', '.')); if (Number.isFinite(n)) return Math.round(n); }
  const l = String(description || '').match(/(\d[\d.,]*)\s*(?:l|litros?|litre?s?)\b/i);
  if (l) { const n = Number(String(l[1]).replace(',', '.')); if (Number.isFinite(n)) return Math.round(n * 1000); }
  return '';
}

function normUs(v) {
  const t = norm(v);
  if (!t) return '';
  if (/not\s*eligible|no\b|n\/?a/.test(t)) return 'Not eligible';
  if (/review|revisar/.test(t)) return 'Review';
  if (/eligible|apto|ok\b|yes|si\b|usa|us\b|ee ?uu/.test(t)) return 'Eligible';
  return '';
}

function normConfidence(v) {
  const t = norm(v);
  if (!t) return '';
  if (/firm|confirmed|confirmad|firme/.test(t)) return 'Firm';
  if (/indicative|indicativ/.test(t)) return 'Indicative';
  if (/on request|request|consultar|a peticion|unknown/.test(t)) return 'On request';
  return '';
}

function num(v) { return v == null || v === '' ? '' : v; }

// Map one joined offer row (offers + supplier name + upload filename) onto the
// template's column order.
function mapOffer(r) {
  const { brand, rest } = parseBrand(r.description);
  const concentration = parseConcentration(r.description, r.category);
  const gender = parseGender(r.category, r.description);
  const fragrance = parseFragrance(rest, r.size_ml);
  const priceBasis = r.price_basis === 'case' ? 'Case' : (r.price_basis ? 'Unit' : '');
  const incoterm = r.incoterm ? String(r.incoterm).toUpperCase() : '';
  const cap = r.cap_type ? (r.refillable === 1 ? 'Unknown' : 'Yes') : '';

  return [
    r.supplier_code || '',
    r.supplier_name || '',
    `${r.supplier_code}-${String(r.id).padStart(6, '0')}`,
    r.list_date || '',
    r.valid_until || '',
    r.last_confirmed_at || '',
    r.source_filename || '',
    num(r.source_row),
    r.gtin_source || '',
    r.internal_sku || '',
    brand,
    fragrance,
    concentration,
    parseSize(r.description, r.size_ml),
    gender,
    '',
    parseRetailPack(r.description, r.category),
    cap,
    '',
    '',
    '',
    r.unique_lot_ref || '',
    '',
    r.currency || '',
    num(r.price),
    priceBasis,
    num(r.units_per_case),
    num(r.available_quantity),
    r.quantity_unit || '',
    num(r.moq),
    num(r.order_multiple),
    num(r.tier_min),
    num(r.tier_max),
    r.stock_country || '',
    r.stock_warehouse || '',
    r.country_of_origin || '',
    incoterm && INCOTERMS.has(incoterm) ? incoterm : incoterm,
    r.incoterm_place || '',
    r.ready_date || '',
    num(r.lead_time_days),
    r.payment_terms || '',
    r.freight_inclusions || '',
    r.permitted_destination || '',
    '',
    normUs(r.us_suitability),
    '',
    r.stock_owner_id || '',
    r.unique_lot_ref || '',
    normConfidence(r.stock_confidence),
  ];
}

// ---------------------------------------------------------------------------
// Workbook construction
// ---------------------------------------------------------------------------
function enumSheet() {
  const rows = [['Enum field', 'Allowed values']];
  for (const [k, v] of Object.entries(ENUMS)) rows.push([k, v.join(' | ')]);
  return rows;
}

function fieldGuideSheet() {
  return [
    ['Field group', 'Column', 'Required', 'Type', 'Notes'],
    ['Source and dates', 'Supplier ID', 'Y', 'TEXT', 'Must exist in supplier master'],
    ['Source and dates', 'Supplier name', 'Y', 'TEXT', 'Snapshot of name at list date'],
    ['Source and dates', 'Offer ID', 'Y', 'TEXT', 'Unique per supplier + list date'],
    ['Source and dates', 'List date', 'Y', 'DATE', 'Snapshot anchor; immutable'],
    ['Source and dates', 'Valid until', 'N', 'DATE', '>= list date if present'],
    ['Source and dates', 'Last stock confirmation', 'N', 'DATE', 'Freshness source'],
    ['Source and dates', 'Source file', 'Y', 'TEXT', 'System-set (upload audit)'],
    ['Source and dates', 'Source row', 'Y', 'INT', 'System-set (upload audit)'],
    ['Product identity', 'Original EAN / UPC', 'N', 'TEXT', 'Stored as text; preserve leading zeros'],
    ['Product identity', 'Internal SKU', 'N', 'TEXT', 'Must resolve via alias table'],
    ['Product identity', 'Brand', 'N', 'TEXT', ''],
    ['Product identity', 'Fragrance name', 'N', 'TEXT', ''],
    ['Product identity', 'Concentration', 'N', 'ENUM', 'See Enum sheet'],
    ['Product identity', 'Size (ml)', 'N', 'INT', '> 0'],
    ['Product identity', 'Gender / category', 'N', 'ENUM', 'See Enum sheet'],
    ['Product identity', 'Set contents', 'N', 'TEXT', ''],
    ['Packaging and condition', 'Retail pack or tester', 'N', 'ENUM', 'Retail | Tester | Gift set | Refill'],
    ['Packaging and condition', 'With / without cap', 'N', 'BOOL', 'Yes | No | Unknown'],
    ['Packaging and condition', 'With / without box', 'N', 'BOOL', 'Yes | No | Unknown'],
    ['Packaging and condition', 'Sealed or unboxed', 'N', 'ENUM', 'Sealed | Unboxed'],
    ['Packaging and condition', 'Damage status', 'N', 'ENUM', 'None | Minor | Major | Unknown'],
    ['Packaging and condition', 'Batch / lot reference', 'N', 'TEXT', ''],
    ['Packaging and condition', 'Manufacture date', 'N', 'DATE', 'Only if verified'],
    ['Price and quantity', 'Currency', 'Y', 'TEXT', 'ISO-4217'],
    ['Price and quantity', 'Price', 'Y', 'DEC', '> 0'],
    ['Price and quantity', 'Price basis', 'Y', 'ENUM', 'Unit | Case'],
    ['Price and quantity', 'Units per case', 'Cond', 'INT', 'Required if Price basis = Case'],
    ['Price and quantity', 'Available quantity', 'N', 'INT', 'Blank = unknown (never 0)'],
    ['Price and quantity', 'Quantity unit', 'N', 'TEXT', ''],
    ['Price and quantity', 'MOQ', 'N', 'INT', ''],
    ['Price and quantity', 'Order multiple', 'N', 'INT', ''],
    ['Price and quantity', 'Price tier minimum', 'N', 'INT', ''],
    ['Price and quantity', 'Price tier maximum', 'N', 'INT', '>= tier minimum'],
    ['Logistics and terms', 'Stock country', 'N', 'TEXT', ''],
    ['Logistics and terms', 'Stock warehouse', 'N', 'TEXT', ''],
    ['Logistics and terms', 'Country of origin', 'N', 'TEXT', ''],
    ['Logistics and terms', 'Incoterm', 'N', 'ENUM', 'EXW | FOB | CIF | DAP | DDP | FCA | CPT'],
    ['Logistics and terms', 'Incoterm named place', 'N', 'TEXT', 'Required if Incoterm present'],
    ['Logistics and terms', 'Ready date', 'N', 'DATE', ''],
    ['Logistics and terms', 'Lead time', 'N', 'INT', 'Days'],
    ['Logistics and terms', 'Payment terms', 'N', 'TEXT', ''],
    ['Logistics and terms', 'Freight inclusions', 'N', 'TEXT', 'Drives double-count control'],
    ['Eligibility and evidence', 'Permitted destination', 'N', 'TEXT', ''],
    ['Eligibility and evidence', 'Permitted channels', 'N', 'TEXT', ''],
    ['Eligibility and evidence', 'US suitability status', 'N', 'ENUM', 'Eligible | Review | Not eligible'],
    ['Eligibility and evidence', 'Authenticity documents', 'N', 'TEXT', ''],
    ['Eligibility and evidence', 'Stock owner ID', 'N', 'TEXT', 'Dedup key'],
    ['Eligibility and evidence', 'Unique lot reference', 'N', 'TEXT', 'Dedup key'],
    ['Eligibility and evidence', 'Stock confidence', 'N', 'ENUM', 'Firm | Indicative | On request'],
  ];
}

const INSTRUCTIONS = [
  ['Perfume Wholesale Trading Software - Standard Supplier Template'],
  [''],
  ['One row per supplier offer for a specific SKU, packaging condition, stock lot, location and quantity price tier.'],
  ['Blank = unknown. NEVER use 0 for an unknown value.'],
  ["Keep the supplier's ORIGINAL EAN / UPC and description."],
  ['Barcodes are stored as text to retain leading zeros. Validate length and check digit; canonical GTIN padded to 14 digits.'],
  ['Never equate a case barcode to a bottle without a verified units-per-case conversion.'],
  ['Each list is a dated snapshot: it must not overwrite history or be added to earlier stock snapshots.'],
  ['Re-importing the same file must not duplicate offers (unique on supplier + offer + list date).'],
  ['Source file and Source row are maintained by the system for the upload audit log.'],
];

function aoaSheet(rows, widths) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  if (widths) ws['!cols'] = widths.map((wch) => ({ wch }));
  return ws;
}

function workbookBuffer(offerRows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, aoaSheet([TEMPLATE_COLUMNS, ...offerRows], TEMPLATE_COLUMNS.map((c) => Math.max(12, Math.min(28, c.length + 4)))), 'Offers');
  XLSX.utils.book_append_sheet(wb, aoaSheet(fieldGuideSheet(), [26, 26, 10, 8, 46]), 'FieldGuide');
  XLSX.utils.book_append_sheet(wb, aoaSheet(enumSheet(), [30, 60]), 'Enum');
  XLSX.utils.book_append_sheet(wb, aoaSheet(INSTRUCTIONS, [110]), 'Instructions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ---------------------------------------------------------------------------
// DB glue
// ---------------------------------------------------------------------------
function cleanedDir() {
  const dir = path.join(path.dirname(DB_PATH), 'cleaned');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function offersForUpload(uploadId) {
  return db.prepare(
    `SELECT o.*, s.name AS supplier_name, u.filename AS source_filename
       FROM offers o
       LEFT JOIN suppliers s ON s.code = o.supplier_code
       LEFT JOIN uploads u ON u.id = o.upload_id
      WHERE o.upload_id = ?
      ORDER BY o.source_row, o.id`
  ).all(uploadId);
}

// Build the cleaned workbook for an upload and store it beside the database.
// Records the result on the uploads row so the UI can offer a download.
function cleanUpload(uploadId, opts = {}) {
  const upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(uploadId);
  if (!upload) return null;
  const offers = offersForUpload(uploadId);
  const rows = offers.map(mapOffer);
  const buffer = workbookBuffer(rows);

  const dir = opts.dir || cleanedDir();
  const filename = `${upload.supplier_code}-upload-${upload.id}.xlsx`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, buffer);

  db.prepare('UPDATE uploads SET cleaned_path = ?, cleaned_rows = ?, cleaned_at = datetime(\'now\') WHERE id = ?')
    .run(filePath, rows.length, uploadId);

  return { uploadId, path: filePath, filename, rows: rows.length };
}

// The stored snapshot if it exists, otherwise build one now. Returns
// { buffer, filename } or null when the upload is unknown.
function cleanedBuffer(uploadId) {
  const upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(uploadId);
  if (!upload) return null;
  if (upload.cleaned_path && fs.existsSync(upload.cleaned_path)) {
    return { buffer: fs.readFileSync(upload.cleaned_path), filename: path.basename(upload.cleaned_path) };
  }
  const rows = offersForUpload(uploadId).map(mapOffer);
  return { buffer: workbookBuffer(rows), filename: `${upload.supplier_code}-upload-${upload.id}.xlsx` };
}

// The same rows the .xlsx is built from, returned as a grid so the PDF export
// can render them from one source of truth.
function cleanedGrid(uploadId) {
  const upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(uploadId);
  if (!upload) return null;
  const rows = offersForUpload(uploadId).map(mapOffer);
  return {
    header: TEMPLATE_COLUMNS,
    rows,
    supplier: upload.supplier_code,
    filename: `${upload.supplier_code}-upload-${upload.id}`,
  };
}

module.exports = {
  TEMPLATE_COLUMNS, ENUMS, cleanUpload, cleanedBuffer, cleanedGrid, offersForUpload, mapOffer,
  parseConcentration, parseGender, parseBrand, parseFragrance, parseRetailPack, parseSize,
  normUs, normConfidence, workbookBuffer,
};
