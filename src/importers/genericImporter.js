'use strict';

const XLSX = require('xlsx');
const path = require('path');
const { detectProfile } = require('./profiles');
const { emptyOffer, CASE_GTIN_FIELD } = require('../lib/template');
const gtin = require('../lib/gtin');

function toText(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

// Parse a price/quantity cell that may contain currency symbols or EU decimals.
function parseNumber(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (s === '') return null;
  s = s.replace(/[^\d.,\-]/g, '');
  if (s === '' || s === '-') return null;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && !hasDot) {
    // EU decimal comma
    s = s.replace(',', '.');
  } else if (hasComma && hasDot) {
    // assume '.' thousands, ',' decimal
    s = s.replace(/\./g, '').replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseSizeMl(v) {
  const s = toText(v);
  if (!s) return null;
  const m = s.match(/(\d+(?:[.,]\d+)?)\s*ml\b/i);
  if (m) {
    const n = Number(String(m[1]).replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  return null;
}

function loadSheetRows(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: false, cellNF: false });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  return { sheetName, sheetNames: wb.SheetNames, aoa };
}

function findHeader(aoa) {
  const limit = Math.min(aoa.length, 80);
  for (let r = 0; r < limit; r++) {
    const headers = (aoa[r] || []).map(toText);
    const profile = detectProfile(headers);
    if (profile) return { rowIndex: r, headers, profile };
  }
  return null;
}

function resolveColumns(profile, headers) {
  const map = {};
  for (const [field, patterns] of Object.entries(profile.fields)) {
    if (patterns == null) continue; // skip fields with no column mapping
    // Pattern order is priority order: prefer the first pattern that matches
    // any column over a later pattern that happens to sit in an earlier column.
    for (const re of patterns) {
      let found = false;
      for (let c = 0; c < headers.length; c++) {
        const h = headers[c];
        if (!h) continue;
        if (re.test(h)) { map[field] = c; found = true; break; }
      }
      if (found) break;
    }
  }
  // Some vendor sheets have data in unheadered columns (e.g. VR's product name
  // in column C). A profile can bind those by zero-based column index.
  for (const [field, idx] of Object.entries(profile.indexFields || {})) {
    if (map[field] === undefined && Number.isInteger(idx)) map[field] = idx;
  }
  return map;
}

function extract(filePath, supplier) {
  const { sheetName, aoa } = loadSheetRows(filePath);
  const found = findHeader(aoa);
  if (!found) throw new Error('No known header row / vendor profile matched in ' + filePath);
  const { rowIndex, headers, profile } = found;
  const colMap = resolveColumns(profile, headers);

  const offers = [];
  for (let r = rowIndex + 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const nonEmpty = row.some((c) => toText(c) !== '');
    if (!nonEmpty) continue;

    const get = (field) => (colMap[field] !== undefined ? toText(row[colMap[field]]) : '');
    const offer = emptyOffer();

    offer.supplierId = supplier.supplierId;
    offer.supplierName = supplier.supplierName;
    offer.sourceFileId = path.basename(filePath);
    offer.sourceRow = r + 1; // 1-based sheet row
    offer.category = get('category') || get('subcategory') || null;
    const descParts = [get('description'), get('descriptionSuffix')].map((s) => s.trim()).filter(Boolean);
    offer.description = descParts.length ? descParts.join(' ') : null;
    offer.internalSku = get('internalSku') || null;
    offer.gtinSource = get('gtinSource') || null;
    offer[CASE_GTIN_FIELD] = get('caseGtinSource') || null;
    offer.currency = profile.currency || null;
    offer.incoterm = profile.incoterm || null;
    offer.incotermPlace = profile.incotermPlace || null;
    offer.expiryDate = get('expiryDate') || null;
    offer.notes = get('notes') || null;
    offer.priceBasis = 'unit';
    offer.price = parseNumber(get('price') || get('rrp'));
    offer.rrp = parseNumber(get('rrp'));
    offer.abv = parseNumber(get('abv'));
    const sizeFromText = parseSizeMl(get('sizeText'));
    const sizeL = parseNumber(get('sizeLiters'));
    offer.sizeMl = sizeFromText !== null ? sizeFromText : (sizeL !== null ? Math.round(sizeL * 1000) : null);
    // Many lists put the bottle size only in the description ("Amor Amor EDP
    // 30ml"); capture it when no dedicated size column exists.
    if (offer.sizeMl == null && offer.description) offer.sizeMl = parseSizeMl(offer.description);
    offer.unitsPerCase = parseNumber(get('unitsPerCase'));
    const stockPal = parseNumber(get('availableQuantity'));
    offer.availableQuantity = stockPal;
    offer.quantityUnit = get('availableQuantity') ? 'pallet' : null;
    offer.capType = get('capType') || null;
    const refill = get('refillable');
    offer.refillable = refill ? /irrellenable/i.test(refill) : null;

    // Price/quantity tiers, MOQ and order multiples (brief section 5/7).
    offer.moq = parseNumber(get('moq'));
    offer.orderMultiple = parseNumber(get('orderMultiple'));
    offer.tierMin = parseNumber(get('tierMin'));
    offer.tierMax = parseNumber(get('tierMax'));

    // Dates / logistics / eligibility (captured when the column exists, else blank).
    offer.validUntil = get('validUntil') || null;
    offer.readyDate = get('readyDate') || null;
    offer.leadTimeDays = parseNumber(get('leadTimeDays'));
    offer.countryOfOrigin = get('countryOfOrigin') || null;
    offer.stockCountry = get('stockCountry') || profile.stockCountry || null;
    offer.stockWarehouse = get('stockWarehouse') || null;
    offer.lastStockConfirmation = get('lastStockConfirmation') || null;
    offer.stockConfidence = get('stockConfidence') || null;
    offer.permittedDestination = get('permittedDestination') || null;
    offer.usSuitabilityStatus = get('usSuitability') || null;
    offer.freightInclusions = get('freightInclusions') || null;
    offer.stockOwnerId = get('stockOwnerId') || null;
    offer.uniqueLotRef = get('uniqueLotRef') || null;

    // barcode analysis
    const g = gtin.analyse(offer.gtinSource);
    offer._gtin = g;
    const caseG = gtin.analyse(offer[CASE_GTIN_FIELD]);
    offer._caseGtin = caseG;

    offer._header = headers;
    offers.push(offer);
  }

  return { profile, sheetName, rowIndex: rowIndex + 1, headers, colMap, offers };
}

module.exports = { extract, parseNumber, toText };
