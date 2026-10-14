'use strict';

// Vendor profiles. Each declares how to recognise its list and which source
// column headers map to which standard template fields.
//
// IMPORTANT (brief section 5/6): never equate a case barcode to a bottle.
// Case barcodes / units-per-case are captured into their own fields.

const PROFILES = [
  {
    id: 'ALCODIS',
    name: 'Alcodis',
    currency: 'EUR',
    // recognition: an EAN column together with a DUN (box) column
    match: (headers) =>
      headers.some((h) => /^ean/i.test(h)) && headers.some((h) => /dun/i.test(h)),
    fields: {
      gtinSource: [/^ean/i],
      caseGtinSource: [/dun/i],
      internalSku: [/^n[ºo°]?\b/i, /^n$/i],
      category: [/categor/i],
      description: [/descrip/i],
      sizeLiters: [/volumen/i],
      abv: [/%\s*alc/i],
      capType: [/rosca|irrellenable/i],
      refillable: [/irrellenable/i],
      price: [/^precio/i],
      orderMultiple: [/pedido/i],
      image: [/foto/i],
    },
  },
  {
    id: 'IGAN',
    name: 'Igan',
    currency: 'EUR',
    incoterm: 'EXW',
    incotermPlace: 'Lleida',
    // recognition: a CodigoEAN column
    match: (headers) => headers.some((h) => /codigoean/i.test(h)),
    fields: {
      gtinSource: [/codigoean/i],
      category: [/^categor/i],
      subcategory: [/subcategor/i],
      description: [/descrip/i],
      internalSku: [/^c[oó]digo$/i],
      sizeLiters: [/vol\b/i, /vol\./i],
      unitsPerCase: [/und.*caja/i],
      casesPerPallet: [/caja.*pallet/i],
      abv: [/%\s*vol/i],
      expiryDate: [/caducidad/i],
      notes: [/observ/i],
      availableQuantity: [/stock.*pallet/i],
      rrp: [/^pvp/i],
      image: [/image|link/i],
    },
  },
];

function detectProfile(headers) {
  for (const p of PROFILES) {
    try {
      if (p.match(headers)) return p;
    } catch (_) { /* ignore */ }
  }
  return null;
}

module.exports = { PROFILES, detectProfile };
