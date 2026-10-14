'use strict';

const { db } = require('../db');

// Per-supplier commercial defaults. price_type tells the engine whether the
// quoted figure is our acquisition cost or a retail price (RRP).
const SUPPLIERS = {
  ALCODIS: {
    code: 'ALCODIS', name: 'Alcodis',
    currency: 'EUR', priceType: 'cost', defaultDiscount: 0,
    defaultBasis: 'unit',
    // Alcodis quotes many lines per case/box; when the description reveals a
    // pack size we record the price as per-case so it is normalised per bottle.
    priceBasisFromPack: true,
    incoterm: null, incotermPlace: null, stockCountry: 'ES', paymentTerms: null,
    profiles: ['ALCODIS'],
  },
  IGAN: {
    code: 'IGAN', name: 'Igan',
    // Igan publishes PVP (retail). We buy at a trade discount off that RRP.
    // Demo default of 40% is a placeholder assumption, editable in Settings.
    currency: 'EUR', priceType: 'rrp', defaultDiscount: 40,
    defaultBasis: 'unit',
    priceBasisFromPack: false,
    incoterm: 'EXW', incotermPlace: 'Lleida', stockCountry: 'ES', paymentTerms: null,
    profiles: ['IGAN'],
  },
};

function getSupplier(code) {
  return SUPPLIERS[code] || null;
}

function supplierForProfile(profileId) {
  for (const s of Object.values(SUPPLIERS)) {
    if (s.profiles.includes(profileId)) return s;
  }
  return null;
}

function ensureSupplier(code) {
  const s = SUPPLIERS[code];
  if (!s) return null;
  const row = db.prepare('SELECT code FROM suppliers WHERE code = ?').get(code);
  if (!row) {
    db.prepare(
      `INSERT INTO suppliers(code, name, currency, incoterm, incoterm_place, price_type, default_discount_pct, stock_country, payment_terms)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(s.code, s.name, s.currency, s.incoterm, s.incotermPlace, s.priceType, s.defaultDiscount, s.stockCountry, s.paymentTerms);
  }
  return s;
}

function listSuppliers() {
  return db.prepare('SELECT * FROM suppliers ORDER BY code').all();
}

module.exports = { SUPPLIERS, getSupplier, supplierForProfile, ensureSupplier, listSuppliers };
