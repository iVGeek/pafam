'use strict';

require('./env').load();

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.PTP_DATA_DIR || path.join(__dirname, '..', 'data');
if (fs.existsSync(DATA_DIR)) {
  for (const f of ['ptp.db', 'ptp.db-wal', 'ptp.db-shm']) {
    const p = path.join(DATA_DIR, f);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
}

console.log('Seeding database at', DATA_DIR, '...');
const { seedData } = require('./seedData');
const counts = seedData({ log: (m) => console.log('  ' + m) });

console.log('Users:', counts.users, '| captures:', counts.captures);
console.log('Seed complete.');
// Never present a source-code-known password as a production login. With no
// PTP_ADMIN_PASS, a non-demo seed generates a random password (logged above by
// seedData) and forces a change; a local demo seed keeps the documented default.
const adminUser = process.env.PTP_ADMIN_USER || 'admin';
if (process.env.PTP_ADMIN_PASS) {
  console.log(`  login: ${adminUser}/${process.env.PTP_ADMIN_PASS}`);
} else if (process.env.PTP_SEED_DEMO_USERS === 'false') {
  console.log(`  login: ${adminUser}/<generated random password printed above — change at first login>`);
} else {
  console.log(`  local demo login: ${adminUser}/admin123 (demo only — never use on a public host)`);
}
console.log('  products:', counts.products);
console.log('  offers:  ', counts.offers);
console.log('  exceptions:', counts.exceptions);
if (counts.alerts != null) console.log('  alerts:', counts.alerts, '| price history:', counts.priceHistory);
if (counts.orders != null) console.log('  orders:', counts.orders);
