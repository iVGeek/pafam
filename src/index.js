'use strict';

const fs = require('fs');
const path = require('path');
const { extract } = require('./importers/genericImporter');
const { summarizeOffers, crossOverlap } = require('./report/quality');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const OUT = path.join(ROOT, 'output');

const SUPPLIERS = [
  { supplierId: 'SUP-ALCODIS', supplierName: 'Alcodis', file: path.join(SAMPLES, 'alcodis-supplier-1.xls') },
  { supplierId: 'SUP-IGAN', supplierName: 'Igan', file: path.join(SAMPLES, 'igan-supplier-2.xlsx') },
];

function fmtPct(n, d) {
  if (!d) return '0%';
  return ((n / d) * 100).toFixed(1) + '%';
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function main() {
  ensureDir(OUT);

  const results = [];
  const summaries = [];

  for (const s of SUPPLIERS) {
    const res = extract(s.file, s);
    results.push({ supplier: s, res });
    const summary = summarizeOffers(res.offers, s.supplierName);
    summary.profile = res.profile.id;
    summary.sheet = res.sheetName;
    summary.headerRow = res.rowIndex;
    summaries.push(summary);
  }

  const [alc, ig] = summaries;
  const overlap = crossOverlap(results[0].res.offers, results[1].res.offers);

  // price comparison over matched SKUs
  const priced = overlap.matches
    .map((m) => {
      const pa = m.a.price;
      const pb = m.b.price;
      let cheaper = null;
      if (pa !== null && pb !== null) cheaper = pa < pb ? 'ALCODIS' : (pb < pa ? 'IGAN' : 'EQUAL');
      return {
        canonical14: m.a._gtin.canonical14 || '',
        description: m.a.description || m.b.description || '',
        alcodisPrice: pa,
        iganPrice: pb,
        cheaper,
      };
    })
    .filter((x) => x.alcodisPrice !== null && x.iganPrice !== null);

  // ---- console report ----
  console.log('============================================================');
  console.log(' PERFUME TRADING PLATFORM - IMPORTER SPIKE / DATA QUALITY');
  console.log('============================================================\n');

  for (const s of summaries) {
    console.log(`--- ${s.label} (profile ${s.profile}, sheet "${s.sheet}", header row ${s.headerRow}) ---`);
    console.log(`  data rows:                 ${s.rows}`);
    console.log(`  rows with barcode:         ${s.withBarcode}   (blank: ${s.blankBarcode})`);
    console.log(`  valid check digit:         ${s.validBarcode}  (${fmtPct(s.validBarcode, s.withBarcode)} of coded rows)`);
    console.log(`  invalid check digit:       ${s.invalidBarcode} (${fmtPct(s.invalidBarcode, s.withBarcode)})`);
    console.log(`  distinct canonical GTINs:  ${s.distinctCanonical}`);
    console.log(`  duplicate coded rows:      ${s.duplicateRows}`);
    console.log(`  barcode length dist:       ${JSON.stringify(s.lengthDistribution)}`);
    console.log(`  barcode type dist:         ${JSON.stringify(s.typeDistribution)}`);
    console.log(`  rows w/ case barcode:      ${s.withCaseBarcode}`);
    console.log(`  rows w/ units-per-case:    ${s.rowsWithUnitsPerCase}`);
    console.log(`  currencies:                ${JSON.stringify(s.currencies)}`);
    console.log(`  missing price:             ${s.missingPrice}`);
    console.log(`  missing description:       ${s.missingDescription}`);
    console.log('');
  }

  console.log('--- CROSS-SUPPLIER OVERLAP (same canonical GTIN in both lists) ---');
  console.log(`  overlapping SKUs:          ${overlap.overlapSkus}`);
  console.log(`  overlapping offers (rows): ${overlap.matches.length}`);
  console.log(`  priced comparisons:        ${priced.length}`);
  const cheaperAlc = priced.filter((p) => p.cheaper === 'ALCODIS').length;
  const cheaperIg = priced.filter((p) => p.cheaper === 'IGAN').length;
  console.log(`  cheaper at Alcodis:        ${cheaperAlc}`);
  console.log(`  cheaper at Igan:           ${cheaperIg}`);
  console.log('');
  console.log('  sample comparisons (canonical GTIN | description | Alcodis | Igan | cheaper):');
  for (const p of priced.slice(0, 8)) {
    console.log(`    ${p.canonical14} | ${(p.description || '').slice(0, 34).padEnd(34)} | ${String(p.alcodisPrice).padStart(7)} | ${String(p.iganPrice).padStart(7)} | ${p.cheaper}`);
  }

  // ---- write artifacts ----
  const normalized = results.flatMap((r) =>
    r.res.offers.map((o) => {
      const { _gtin, _caseGtin, _header, ...clean } = o;
      return {
        ...clean,
        gtin: _gtin,
        caseGtin: _caseGtin,
      };
    })
  );
  fs.writeFileSync(path.join(OUT, 'offers.json'), JSON.stringify(normalized, null, 2));
  fs.writeFileSync(path.join(OUT, 'quality.json'), JSON.stringify({ summaries, overlap: { overlapSkus: overlap.overlapSkus, matches: priced } }, null, 2));

  const md = [];
  md.push('# Importer Spike - Data Quality Report\n');
  md.push(`Generated: ${new Date().toISOString()}\n`);
  md.push('## Per-supplier quality\n');
  md.push('| Metric | Alcodis | Igan |');
  md.push('|---|---|---|');
  md.push(`| Data rows | ${alc.rows} | ${ig.rows} |`);
  md.push(`| Rows with barcode | ${alc.withBarcode} | ${ig.withBarcode} |`);
  md.push(`| Blank barcode | ${alc.blankBarcode} | ${ig.blankBarcode} |`);
  md.push(`| Valid check digit | ${alc.validBarcode} (${fmtPct(alc.validBarcode, alc.withBarcode)}) | ${ig.validBarcode} (${fmtPct(ig.validBarcode, ig.withBarcode)}) |`);
  md.push(`| Invalid check digit | ${alc.invalidBarcode} | ${ig.invalidBarcode} |`);
  md.push(`| Distinct canonical GTINs | ${alc.distinctCanonical} | ${ig.distinctCanonical} |`);
  md.push(`| Rows w/ case barcode | ${alc.withCaseBarcode} | ${ig.withCaseBarcode} |`);
  md.push(`| Rows w/ units-per-case | ${alc.rowsWithUnitsPerCase} | ${ig.rowsWithUnitsPerCase} |`);
  md.push('');
  md.push('## Cross-supplier overlap\n');
  md.push(`- Overlapping SKUs (same canonical GTIN): **${overlap.overlapSkus}**`);
  md.push(`- Priced head-to-head comparisons: ${priced.length}`);
  md.push(`- Cheaper at Alcodis: ${cheaperAlc} | Cheaper at Igan: ${cheaperIg}\n`);
  fs.writeFileSync(path.join(OUT, 'data-quality.md'), md.join('\n'));

  console.log('\nWrote: output/offers.json, output/quality.json, output/data-quality.md');
}

main();
