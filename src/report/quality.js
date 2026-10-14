'use strict';

// Data-quality analysis over a set of normalized offers. Produces the metrics
// that tell us how hard real-world ingestion will be (brief sections 6, 20).

function summarizeOffers(offers, label) {
  const stats = {
    label,
    rows: offers.length,
    withBarcode: 0,
    blankBarcode: 0,
    validBarcode: 0,
    invalidBarcode: 0,
    distinctCanonical: 0,
    duplicateRows: 0,
    lengthDistribution: {},
    typeDistribution: {},
    withCaseBarcode: 0,
    rowsWithUnitsPerCase: 0,
    currencies: {},
    missingPrice: 0,
    missingDescription: 0,
  };

  const seen = new Set();
  for (const o of offers) {
    const g = o._gtin || { length: 0, valid: false, type: 'UNKNOWN', canonical14: null, digits: '' };
    if (!g.digits) {
      stats.blankBarcode++;
    } else {
      stats.withBarcode++;
      const len = String(g.length);
      stats.lengthDistribution[len] = (stats.lengthDistribution[len] || 0) + 1;
      stats.typeDistribution[g.type] = (stats.typeDistribution[g.type] || 0) + 1;
      if (g.valid) {
        stats.validBarcode++;
        if (seen.has(g.canonical14)) stats.duplicateRows++;
        else seen.add(g.canonical14);
      } else {
        stats.invalidBarcode++;
      }
    }
    if (o.caseGtinSource && String(o.caseGtinSource).trim() !== '') stats.withCaseBarcode++;
    if (o.unitsPerCase) stats.rowsWithUnitsPerCase++;
    const cur = o.currency || 'UNKNOWN';
    stats.currencies[cur] = (stats.currencies[cur] || 0) + 1;
    if (o.price === null || o.price === undefined) stats.missingPrice++;
    if (!o.description) stats.missingDescription++;
  }
  stats.distinctCanonical = seen.size;
  return stats;
}

function crossOverlap(offersA, offersB) {
  const key = (o) => (o._gtin && o._gtin.matchKey) || '';
  const mapB = new Map();
  for (const o of offersB) {
    const k = key(o);
    if (!k) continue;
    if (!mapB.has(k)) mapB.set(k, []);
    mapB.get(k).push(o);
  }
  const matches = [];
  const seenA = new Set();
  let overlapSkus = 0;
  for (const o of offersA) {
    const k = key(o);
    if (!k) continue;
    if (mapB.has(k)) {
      if (!seenA.has(k)) { overlapSkus++; seenA.add(k); }
      matches.push({ key: k, a: o, b: mapB.get(k)[0] });
    }
  }
  return { overlapSkus, matches };
}

module.exports = { summarizeOffers, crossOverlap };
