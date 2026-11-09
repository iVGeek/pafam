'use strict';
// §22 pilot targets: measure, don't guess.
// Reports DB size, row counts, and parse performance on the largest
// supplier file. Run: node scripts/measure-scale.js
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { parseList } = require('../server/services/listdiff');

const root = path.join(__dirname, '..');
const dbPath = process.env.PTP_DB || path.join(root, 'data', 'ptp.db');
const db = new DatabaseSync(dbPath, { readOnly: true });

const tables = ['offers', 'products', 'price_history', 'alerts', 'orders', 'audit_log'];
console.log('DB:', dbPath, '(' + (fs.statSync(dbPath).size / 1024 / 1024).toFixed(2) + ' MB)');
for (const t of tables) {
  try {
    console.log('  ' + t.padEnd(16) + db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
  } catch (_) { console.log('  ' + t.padEnd(16) + 'n/a'); }
}

const uploadsDir = path.join(root, 'data', 'uploads');
if (fs.existsSync(uploadsDir)) {
  const files = fs.readdirSync(uploadsDir)
    .map((f) => ({ f, s: fs.statSync(path.join(uploadsDir, f)).size }))
    .sort((a, b) => b.s - a.s).slice(0, 3);
  for (const { f, s } of files) {
    const buf = fs.readFileSync(path.join(uploadsDir, f));
    const t0 = Date.now();
    const parsed = parseList(buf);
    console.log(`largest file: ${f} (${(s / 1024).toFixed(0)} KB) -> ${parsed.rows.length} rows parsed in ${Date.now() - t0}ms`);
  }
}
console.log('\nTargets to agree (brief §22): expected file sizes, user count, refresh frequency, import time.');
console.log('Record them here once agreed, e.g.: file <= 5MB, users <= 20, import <= 60s, dashboard <= 2s.');
