'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const auth = require('./services/auth');
const { db } = require('./db');

const app = express();
const PORT = process.env.PORT || 4173;
const HOST = process.env.HOST || '0.0.0.0';

// Behind a hosting proxy (Render) so req.secure / client IPs are correct.
app.set('trust proxy', 1);

app.use(express.json({ limit: '5mb' }));
app.use(auth.parseCookies);
app.use(auth.attachUser);

// static UI
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

// Public auth endpoints (login/logout/me) + device webhook.
app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/captures'));

// Everything else requires an authenticated user.
app.use('/api', auth.requireAuth);

app.use('/api', require('./routes/meta'));
app.use('/api', require('./routes/imports'));
app.use('/api', require('./routes/offers'));
app.use('/api', require('./routes/products'));
app.use('/api', require('./routes/sourcing'));
app.use('/api', require('./routes/trading'));

// SPA fallback
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'internal error' });
});

if (require.main === module) {
  // On a fresh (empty) database — e.g. first deploy to a new host — load the
  // supplier lists and demo data automatically. Disable with PTP_AUTO_SEED=false.
  const products = db.prepare('SELECT COUNT(*) n FROM products').get().n;
  if (products === 0 && process.env.PTP_AUTO_SEED !== 'false') {
    console.log('Empty database detected — seeding sample data...');
    try {
      const { seedData } = require('./seedData');
      const counts = seedData({ log: (m) => console.log('  ' + m) });
      console.log(`Seeded: ${counts.products} products, ${counts.offers} offers, ${counts.users} users.`);
    } catch (e) {
      console.error('Auto-seed failed:', e.message);
    }
  }

  const boot = auth.ensureBootstrapAdmin();
  if (boot.created) {
    console.log('============================================================');
    console.log(' Created bootstrap admin account:');
    console.log('   username: ' + boot.username);
    console.log('   password: ' + boot.password);
    console.log(' Change it after first login (Account > Change password).');
    console.log('============================================================');
  }

  app.listen(PORT, HOST, () => {
    console.log(`Perfume Trading Platform running at http://${HOST}:${PORT}`);
  });
}

module.exports = app;
