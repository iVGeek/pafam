'use strict';

// Customer KPIs (brief section 18).
//
// "Track quote conversion, lost-sale reasons, realised versus expected
// margin, supplier fill rate, customer repeat purchases, overdue debt and
// cash deployment."
//
// Quote conversion: quotes by status. Lost-sale reasons: captured on the
// quote status change (quotes.status = rejected with terms/notes — where
// the trader recorded a reason). Repeat purchases: customers with 2+
// delivered orders. Overdue debt: inbound outstanding past customer_due.

const { db } = require('../db');
const orders = require('./orders');
const pricing = require('./pricing');

function singleCurrencyTotal(byCurrency, empty = 0) {
  const keys = Object.keys(byCurrency);
  if (!keys.length) return empty;
  return keys.length === 1 ? byCurrency[keys[0]] : null;
}

function customerKpis() {
  const quoteByStatus = db.prepare('SELECT status, COUNT(*) n FROM quotes GROUP BY status').all();
  const qb = {};
  quoteByStatus.forEach((r) => { qb[r.status] = r.n; });
  const decided = (qb.accepted || 0) + (qb.rejected || 0) + (qb.expired || 0);
  const conversion = decided > 0 ? Math.round(((qb.accepted || 0) / decided) * 1000) / 10 : null;

  // Lost-sale reasons text (from rejected quotes' terms/notes trail to audit)
  const rejected = db.prepare(
    "SELECT id, terms FROM quotes WHERE status = 'rejected'"
  ).all();
  const lostReasons = rejected.filter((q) => q.terms && String(q.terms).trim());
  const lostReasonsText = lostReasons.slice(0, 10).map((q) => ({
    quoteId: q.id, reason: String(q.terms).slice(0, 160),
  }));

  // Repeat purchases: delivered orders per customer
  const repeat = db.prepare(
    "SELECT c.id, c.name, COUNT(o.id) n FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.status IN ('delivered','closed') GROUP BY c.id HAVING n > 1 ORDER BY n DESC"
  ).all();
  const repeaters = repeat.map((r) => ({ customerId: r.id, customer: r.name, orders: r.n }));

  // Overdue debt: open orders past customer_due with inbound outstanding.
  // The outstanding amount is in the ORDER currency (payments were converted
  // into it at the payment date). Adding amounts from orders in different
  // currencies and calling the sum a debt is false, so group per currency and
  // leave the scalar null when more than one is present.
  const overdueRows = db.prepare(
    `SELECT o.id, o.ref, o.customer_id, c.name customer, o.customer_due, o.quantity, o.unit_price, o.currency
       FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.status NOT IN ('closed','cancelled','delivered') AND o.customer_due IS NOT NULL AND o.customer_due < date('now')`
  ).all();
  const overdue = overdueRows.map((o) => {
    const realised = orders.getOrder(o.id);
    return {
      ...o,
      // Reuse the app's realised calculation so a mixed-currency receipt is
      // converted at its payment date instead of being summed as a raw amount.
      outstanding: realised && realised.realised ? realised.realised.revenueOutstanding : 0,
    };
  }).filter((o) => o.outstanding > 0);

  const overdueDebtByCurrency = {};
  for (const o of overdue) {
    const cur = o.currency || 'UNKNOWN';
    overdueDebtByCurrency[cur] = pricing.round2((overdueDebtByCurrency[cur] || 0) + o.outstanding);
  }
  const overdueDebt = singleCurrencyTotal(overdueDebtByCurrency);
  const mixedCurrency = Object.keys(overdueDebtByCurrency).length > 1;

  // Realised vs expected (from settled orders)
  const realised = db.prepare(
    "SELECT COUNT(*) n FROM orders WHERE status IN ('delivered','closed')"
  ).get().n;

  return {
    quotes: { byStatus: qb, decided, conversionPct: conversion },
    lostReasons: { count: rejected.length, withReason: lostReasons.length, samples: lostReasonsText },
    repeatPurchases: { customers: repeaters, count: repeaters.length },
    overdueDebt,
    overdueDebtByCurrency,
    mixedCurrency,
    currencyWarning: mixedCurrency
      ? 'Overdue orders span multiple currencies. The single debt total is null; use overdueDebtByCurrency. There is no single amount without an explicit, dated FX conversion.'
      : null,
    overdueOrders: overdue.length,
    settledOrders: realised,
  };
}

module.exports = { customerKpis };
