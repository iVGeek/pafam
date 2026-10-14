'use strict';

const { db } = require('../db');
const gtin = require('../../src/lib/gtin');

function findProductByCanonical(canonical) {
  if (!canonical) return null;
  return db.prepare('SELECT * FROM products WHERE canonical_gtin = ?').get(canonical) || null;
}

function findProductByAlias(aliasType, value) {
  if (!value) return null;
  const row = db.prepare(
    'SELECT p.* FROM product_aliases a JOIN products p ON p.id = a.product_id WHERE a.alias_type = ? AND a.alias_value = ? LIMIT 1'
  ).get(aliasType, value);
  return row || null;
}

function createProduct(fields) {
  const info = db.prepare(
    'INSERT INTO products(canonical_gtin, internal_sku, brand, fragrance, concentration, size_ml, category, display_name) VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    fields.canonical_gtin || null,
    fields.internal_sku || null,
    fields.brand || null,
    fields.fragrance || null,
    fields.concentration || null,
    fields.size_ml != null ? fields.size_ml : null,
    fields.category || null,
    fields.display_name || null
  );
  return Number(info.lastInsertRowid);
}

function addAlias(productId, aliasType, aliasValue, opts = {}) {
  if (!aliasValue) return;
  const exists = db.prepare(
    'SELECT id FROM product_aliases WHERE product_id = ? AND alias_type = ? AND alias_value = ?'
  ).get(productId, aliasType, aliasValue);
  if (exists) return exists.id;
  const info = db.prepare(
    'INSERT INTO product_aliases(product_id, alias_type, alias_value, packaging_level, units_per_case, source, verified) VALUES (?,?,?,?,?,?,?)'
  ).run(
    productId, aliasType, aliasValue,
    opts.packagingLevel || null,
    opts.unitsPerCase != null ? opts.unitsPerCase : null,
    opts.source || null,
    opts.verified ? 1 : 0
  );
  return Number(info.lastInsertRowid);
}

// Resolve (or create) the product for an offer. Returns { productId, created, reason }.
function resolveForOffer(offer) {
  const canonical = offer.gtin_canonical;
  if (!canonical || !offer.gtin_valid) {
    // try case barcode / alias fallback
    if (offer.case_gtin_canonical) {
      const byCase = findProductByAlias('case_gtin', offer.case_gtin_canonical) || findProductByCanonical(offer.case_gtin_canonical);
      if (byCase) return { productId: byCase.id, created: false, reason: 'case-alias' };
    }
    return { productId: null, created: false, reason: 'unmatched-barcode' };
  }

  let product = findProductByCanonical(canonical);
  if (product) {
    return { productId: product.id, created: false, reason: 'canonical' };
  }

  product = findProductByAlias('gtin', canonical);
  if (product) {
    return { productId: product.id, created: false, reason: 'gtin-alias' };
  }

  const productId = createProduct({
    canonical_gtin: canonical,
    internal_sku: offer.internal_sku,
    size_ml: offer.size_ml,
    category: offer.category,
    display_name: offer.description,
  });
  addAlias(productId, 'gtin', canonical, { source: 'auto', verified: 1 });

  if (offer.case_gtin_source) {
    const caseG = gtin.analyse(offer.case_gtin_source);
    if (caseG.valid) {
      addAlias(productId, 'case_gtin', caseG.canonical14, {
        packagingLevel: 'case',
        unitsPerCase: offer.units_per_case,
        source: 'auto',
        verified: 1,
      });
    }
  }
  return { productId, created: true, reason: 'new-product' };
}

module.exports = { findProductByCanonical, findProductByAlias, createProduct, addAlias, resolveForOffer };
