'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const auth = require('./services/auth');

const app = express();
const PORT = process.env.PORT || 4173;

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
  const boot = auth.ensureBootstrapAdmin();
  if (boot.created) {
    console.log('============================================================');
    console.log(' Created bootstrap admin account:');
    console.log('   username: ' + boot.username);
    console.log('   password: ' + boot.password);
    console.log(' Change it after first login (Account > Change password).');
    console.log('============================================================');
  }
  app.listen(PORT, () => {
    console.log(`Perfume Trading Platform running at http://localhost:${PORT}`);
  });
}

module.exports = app;
