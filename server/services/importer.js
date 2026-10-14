'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { db, audit } = require('../db');
const { extract } = require('../../src/importers/genericImporter');
const gtin = require('../../src/lib/gtin');
const { parsePackSize } = require('../../src/lib/pack');
const matcher = require('./matcher');
const { supplierForProfile, ensureSupplier, getSupplier } = require('./suppliers');

function sha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Import a supplier price list into the platform.
// opts: { supplierCode?, listDate?, actor?, force? }
function importFile(filePath, opts = {}) {
  const actor = opts.actor || 'system';
  const fileHash = sha256(filePath);
  const extracted = extract(filePath, {
    supplierId: opts.supplierCode || 'AUTO',
    supplierName: opts.supplierCode || 'AUTO',
  });

  const supplier = opts.supplierCode
    ? getSupplier(opts.supplierCode)
    : supplierForProfile(extracted.profile.id);

  if (!supplier) throw new Error('Could not determine supplier for profile ' + extracted.profile.id);
  ensureSupplier(supplier.code);

  // Duplicate-file guard (brief section 6: re-importing a file must not duplicate).
  const existing = db.prepare('SELECT * FROM uploads WHERE supplier_code = ? AND file_hash = ?').get(supplier.code, fileHash);
  if (existing && !opts.force) {
    return { duplicate: true, upload: existing, supplier: supplier.code };
  }

  const listDate = opts.listDate || new Date().toISOString().slice(0, 10);

  const uploadInfo = db.prepare(
    `INSERT INTO uploads(supplier_code, filename, file_hash, sheet, header_row, list_date)
     VALUES (?,?,?,?,?,?)`
  ).run(supplier.code, filePath.split(/[\\/]/).pop(), fileHash, extracted.sheetName, extracted.rowIndex, listDate);
  const uploadId = Number(uploadInfo.lastInsertRowid);

  const insertOffer = db.prepare(
    `INSERT INTO offers(
       upload_id, supplier_code, source_row, list_date,
       gtin_source, gtin_canonical, gtin_valid, gtin_type, case_gtin_source, case_gtin_canonical,
       internal_sku, category, description, size_ml, abv, currency, price, price_basis, price_type,
       units_per_case, rrp, available_quantity, quantity_unit, incoterm, incoterm_place,
       expiry_date, notes, cap_type, refillable, product_id, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insertException = db.prepare(
    'INSERT INTO exceptions(upload_id, offer_id, type, detail) VALUES (?,?,?,?)'
  );

  const counters = { imported: 0, blankBarcode: 0, invalidBarcode: 0, matched: 0, duplicates: 0 };
  const seenCanonical = new Set();

  for (const o of extracted.offers) {
    const g = o._gtin || { digits: '', valid: false, type: 'UNKNOWN', canonical14: null };
    const caseG = o._caseGtin || { valid: false, canonical14: null };
    const canonical = g.valid ? g.canonical14 : null;

    let isBlank = !g.digits;
    let isInvalid = !isBlank && !g.valid;
    let isDuplicate = false;
    if (canonical) {
      if (seenCanonical.has(canonical)) isDuplicate = true;
      else seenCanonical.add(canonical);
    }

    let productId = null;
    let matchReason = null;
    if (canonical) {
      const res = matcher.resolveForOffer({
        gtin_canonical: canonical,
        gtin_valid: 1,
        case_gtin_source: o.caseGtinSource,
        case_gtin_canonical: caseG.valid ? caseG.canonical14 : null,
        internal_sku: o.internalSku,
        size_ml: o.sizeMl,
        category: o.category,
        description: o.description,
        units_per_case: o.unitsPerCase,
      });
      productId = res.productId;
      matchReason = res.reason;
      if (productId) counters.matched++;
    }

    const priceType = supplier.priceType;
    const price = o.price !== null && o.price !== undefined ? o.price : (o.rrp != null ? o.rrp : null);
    const rrp = priceType === 'rrp' ? (o.rrp != null ? o.rrp : o.price) : (o.rrp != null ? o.rrp : null);

    // Pack/case size: prefer an explicit column (e.g. Igan "Und. Caja"),
    // otherwise derive it from the description. If the supplier quotes per
    // case, record price_basis='case' so the engine divides before comparing.
    let unitsPerCase = o.unitsPerCase != null ? o.unitsPerCase : null;
    let packFromDescription = false;
    if (!unitsPerCase) {
      const p = parsePackSize(o.description);
      if (p) { unitsPerCase = p; packFromDescription = true; }
    }
    const priceBasis = (supplier.priceBasisFromPack && unitsPerCase && unitsPerCase > 1 && packFromDescription)
      ? 'case'
      : supplier.defaultBasis;

    const hasException = isBlank || isInvalid || isDuplicate || price === null;
    const status = hasException ? 'exception' : (productId ? 'matched' : 'new');

    const info = insertOffer.run(
      uploadId, supplier.code, o.sourceRow, listDate,
      o.gtinSource, canonical, g.valid ? 1 : 0, g.type, o.caseGtinSource || null, caseG.valid ? caseG.canonical14 : null,
      o.internalSku, o.category, o.description, o.sizeMl, o.abv, o.currency, price, priceBasis, priceType,
      unitsPerCase, rrp, o.availableQuantity, o.quantityUnit, o.incoterm, o.incotermPlace,
      o.expiryDate, o.notes, o.capType, o.refillable == null ? null : (o.refillable ? 1 : 0),
      productId, status
    );
    const offerId = Number(info.lastInsertRowid);
    counters.imported++;

    if (isBlank) {
      counters.blankBarcode++;
      insertException.run(uploadId, offerId, 'blank_barcode', `Row ${o.sourceRow}: no barcode (${o.description || ''})`);
    } else if (isInvalid) {
      counters.invalidBarcode++;
      insertException.run(uploadId, offerId, 'invalid_barcode', `Row ${o.sourceRow}: "${o.gtinSource}" failed check digit`);
    } else if (isDuplicate) {
      counters.duplicates++;
      insertException.run(uploadId, offerId, 'duplicate', `Row ${o.sourceRow}: GTIN ${canonical} appears more than once in this file`);
    }
    if (price === null) {
      insertException.run(uploadId, offerId, 'no_price', `Row ${o.sourceRow}: no price found`);
    }
  }

  db.prepare(
    `UPDATE uploads SET rows_total = ?, rows_imported = ?, rows_blank_barcode = ?, rows_invalid_barcode = ?
     WHERE id = ?`
  ).run(extracted.offers.length, counters.imported, counters.blankBarcode, counters.invalidBarcode, uploadId);

  audit(actor, 'import', 'upload', uploadId,
    `${supplier.code}: ${counters.imported} offers, ${counters.matched} matched, ${counters.blankBarcode} blank, ${counters.invalidBarcode} invalid`);

  return {
    duplicate: false,
    uploadId,
    supplier: supplier.code,
    profile: extracted.profile.id,
    sheet: extracted.sheetName,
    headerRow: extracted.rowIndex,
    rows: extracted.offers.length,
    ...counters,
  };
}

module.exports = { importFile, sha256 };
