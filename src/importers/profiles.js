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
      moq: [/minimo|m[íi]nimo|min\.?\s*(pedido|compra)/i],
      validUntil: [/validez|v[áa]lido|hasta/i],
      readyDate: [/disponible|entrega|ready/i],
      leadTimeDays: [/plazo|lead\s*time/i],
      countryOfOrigin: [/origen|origin/i],
      stockWarehouse: [/almac[eé]n|warehouse|bodega/i],
      lastStockConfirmation: [/confirmaci[óo]n|confirmad/i],
      stockConfidence: [/confianza|confidence/i],
      permittedDestination: [/destino|destination/i],
      usSuitability: [/ee\.?\s*uu|usa|apto/i],
      stockOwnerId: [/propietario|owner/i],
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
      moq: [/minimo|m[íi]nimo|min\.?\s*(pedido|compra|unidades)/i],
      orderMultiple: [/multiplo|m[úu]ltiplo|incremento/i],
      validUntil: [/validez|v[áa]lido|hasta/i],
      countryOfOrigin: [/origen|origin/i],
      permittedDestination: [/destino|destination/i],
      usSuitability: [/ee\.?\s*uu|usa|apto/i],
      image: [/image|link/i],
    },
  },
  // ---- Cacharel (France) ----
  {
    id: 'CACHarel',
    name: 'Cacharel',
    currency: 'EUR',
    // recognition: a "Cod." column + an "Ean Code" column + French price column
    match: (headers) =>
      headers.some((h) => /^cod\./i.test(h)) &&
      headers.some((h) => /^ean\s*code/i.test(h)) &&
      headers.some((h) => /^price$/i.test(h)),
    fields: {
      gtinSource: [/^ean\s*code/i],
      internalSku: [/^cod\./i],
      // The Description column is the real product name; "Line up" is just the
      // family ("Amor Amor"), so prefer the former when both exist.
      description: [/^description$/i, /^line up$/i],
      sizeLiters: null, // not used for perfumes typically
      abv: null,
      capType: null,
      refillable: null,
      price: [/^price$/i],
      orderMultiple: null,
      moq: null,
      validUntil: null,
      readyDate: null,
      leadTimeDays: null,
      countryOfOrigin: null,
      stockWarehouse: null,
      lastStockConfirmation: null,
      stockConfidence: null,
      permittedDestination: null,
      usSuitability: null,
      stockOwnerId: null,
      image: null,
    },
  },
  // ---- Sanya International ----
  {
    id: 'SANYA',
    name: 'Sanya International',
    currency: 'USD',
    // recognition: headers include "Description", "MPN", "Price", "QTY"
    match: (headers) =>
      headers.some((h) => /^description/i.test(h)) &&
      headers.some((h) => /^mpn/i.test(h)) &&
      headers.some((h) => /^price/i.test(h)) &&
      headers.some((h) => /^qty/i.test(h)),
    fields: {
      // The MPN column carries EAN/UPC barcodes for the vast majority of rows
      // (13- or 12-digit numeric); the GTIN analyser validates them, so real
      // barcodes match products while alphanumeric MPNs fall to exceptions.
      gtinSource: [/^mpn$/i],
      internalSku: [/^mpn$/i],
      description: [/^description$/i],
      sizeLiters: null,
      abv: null,
      capType: null,
      refillable: null,
      price: [/^price$/i],
      orderMultiple: null,
      moq: null,
      validUntil: null,
      readyDate: null,
      leadTimeDays: null,
      countryOfOrigin: null,
      stockWarehouse: null,
      lastStockConfirmation: null,
      stockConfidence: null,
      permittedDestination: null,
      usSuitability: null,
      stockOwnerId: null,
      image: null,
    },
  },
  // ---- Viktor&Rolf (VR) ----
  {
    id: 'VR',
    name: 'Viktor&Rolf',
    currency: 'EUR',
    // recognition: a "REF" column + "CODICE EAN" column + "FORMATO" + "QTY" + price columns
    match: (headers) =>
      headers.some((h) => /^ref/i.test(h)) &&
      headers.some((h) => /^codice\s*ean/i.test(h)) &&
      headers.some((h) => /^formato/i.test(h)) &&
      headers.some((h) => /^qty/i.test(h)) &&
      headers.some((h) => /^price$/i.test(h)),
    // product name lives in unheadered column C (zero-based index 2)
    indexFields: { description: 2 },
    fields: {
      gtinSource: [/^codice\s*ean/i],
      internalSku: [/^ref$/i],
      // Column C (index 2) holds the product name but has no header; the
      // FORMATO column holds the size ("50ml"). Combine them for a usable name.
      description: null,
      descriptionSuffix: [/^formato/i],
      sizeText: [/^formato/i],
      sizeLiters: null,
      abv: null,
      capType: null,
      refillable: null,
      price: [/^price$/i],
      orderMultiple: null,
      moq: null,
      validUntil: null,
      readyDate: null,
      leadTimeDays: null,
      countryOfOrigin: null,
      stockWarehouse: null,
      lastStockConfirmation: null,
      stockConfidence: null,
      permittedDestination: null,
      usSuitability: null,
      stockOwnerId: null,
      image: null,
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