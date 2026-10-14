'use strict';
const path = require('path');
const { importFile } = require('../server/services/importer');
const { db } = require('../server/db');

const SAMPLES = path.join(__dirname, '..', 'samples');
const files = [
  { file: path.join(SAMPLES, 'alcodis-supplier-1.xls'), supplierCode: 'ALCODIS' },
  { file: path.join(SAMPLES, 'igan-supplier-2.xlsx'), supplierCode: 'IGAN' },
];

for (const f of files) {
  const r = importFile(f.file, { supplierCode: f.supplierCode, actor: 'smoke' });
  console.log(f.supplierCode, '=>', JSON.stringify(r));
}

console.log('\n-- DB counts --');
for (const t of ['suppliers', 'uploads', 'offers', 'products', 'product_aliases', 'exceptions']) {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  console.log(t.padEnd(18), n);
}
console.log('\noffers by status:', JSON.stringify(db.prepare('SELECT status, COUNT(*) n FROM offers GROUP BY status').all()));
console.log('exceptions by type:', JSON.stringify(db.prepare('SELECT type, COUNT(*) n FROM exceptions GROUP BY type').all()));
