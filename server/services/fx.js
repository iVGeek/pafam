'use strict';

const { db } = require('../db');

// Latest available rate to convert `from` -> `to`.
// Rate is stored as quote units per 1 base unit when base_currency=from, quote_currency=to.
function getRate(from, to, onDate) {
  if (!from || !to || from === to) return 1;
  const row = db.prepare(
    `SELECT rate FROM fx_rates
     WHERE base_currency = ? AND quote_currency = ? AND (? IS NULL OR rate_date <= ?)
     ORDER BY rate_date DESC LIMIT 1`
  ).get(from, to, onDate || null, onDate || null);
  if (row) return row.rate;
  // try inverse
  const inv = db.prepare(
    `SELECT rate FROM fx_rates
     WHERE base_currency = ? AND quote_currency = ? AND (? IS NULL OR rate_date <= ?)
     ORDER BY rate_date DESC LIMIT 1`
  ).get(to, from, onDate || null, onDate || null);
  if (inv && inv.rate) return 1 / inv.rate;
  return null;
}

function setRate(base, quote, rate, opts = {}) {
  const date = opts.rateDate || new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO fx_rates(base_currency, quote_currency, rate, rate_date, source, booked)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(base_currency, quote_currency, rate_date, source)
     DO UPDATE SET rate = excluded.rate, booked = excluded.booked`
  ).run(base, quote, rate, date, opts.source || 'manual', opts.booked ? 1 : 0);
}

function listRates() {
  return db.prepare('SELECT * FROM fx_rates ORDER BY rate_date DESC, base_currency, quote_currency').all();
}

module.exports = { getRate, setRate, listRates };
