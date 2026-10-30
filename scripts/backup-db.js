'use strict';
// Consistent SQLite snapshot without stopping the app.
//
//   node scripts/backup-db.js /var/data/backups/ptp-20260101T031500Z.db
//
// VACUUM INTO writes a single fully-checkpointed database file, so the snapshot
// is safe to upload or restore even while the server is writing to the WAL.
// The source is opened read-only; nothing in the live database is touched.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.PTP_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.PTP_DB || path.join(DATA_DIR, 'ptp.db');

function main() {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node scripts/backup-db.js <output.db>');
    process.exit(2);
  }
  if (!fs.existsSync(DB_PATH)) {
    console.error(`database not found: ${DB_PATH}`);
    process.exit(1);
  }

  const target = path.resolve(out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // VACUUM INTO refuses to overwrite, and a stale partial file is worse than none.
  fs.rmSync(target, { force: true });

  const literal = target.replace(/\\/g, '/').replace(/'/g, "''");
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${literal}'`);
  } finally {
    db.close();
  }

  const bytes = fs.statSync(target).size;
  console.log(`${target} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
}

main();
