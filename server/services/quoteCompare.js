'use strict';

const { db } = require('../db');

function round4(n) { return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000; }

// The numeric fields of a quote we can put a percentage movement on. Prices and
// profits are money, margin/ROI are percentages, quantities and days are counts.
const NUMERIC = [
  ['quantity', 'Quantity', 'num'],
  ['unit_price', 'Unit price', 'money'],
  ['landed_unit_cost', 'Landed unit cost', 'money'],
  ['margin_pct', 'Margin', 'pct'],
  ['net_unit_revenue', 'Net unit revenue', 'money'],
  ['contribution_total', 'Contribution', 'money'],
  ['roi_pct', 'ROI', 'pct'],
  ['annualised_roi_pct', 'Annualised ROI', 'pct'],
  ['capital_required', 'Capital required', 'money'],
  ['capital_days', 'Capital days', 'days'],
];

// Descriptive fields — reported as changed / unchanged rather than as a %.
const TEXT = [
  ['customer_name', 'Customer'],
  ['display_name', 'Product'],
  ['supplier_code', 'Supplier'],
  ['currency', 'Currency'],
  ['status', 'Status'],
  ['order_date', 'Order date'],
  ['supplier_due_date', 'Supplier due'],
  ['customer_due_date', 'Customer due'],
  ['validity_date', 'Valid until'],
  ['terms', 'Terms'],
];

function loadQuote(id) {
  return db.prepare(
    `SELECT q.*, c.name AS customer_name, p.display_name
       FROM quotes q JOIN customers c ON c.id = q.customer_id JOIN products p ON p.id = q.product_id
      WHERE q.id = ?`
  ).get(Number(id));
}

function label(q) { return `#${q.id} · ${q.customer_name || ''} · ${(q.display_name || '').slice(0, 28)}`; }

// Compare two saved quotes and report the percentage movement on every numeric
// field plus which descriptive fields changed. Percentages are relative to the
// first quote (A -> B); a field with A = 0 has no defined % and returns null.
function compareQuotes(aId, bId) {
  const a = loadQuote(aId);
  const b = loadQuote(bId);
  if (!a || !b) return { error: !a ? `quote ${aId} not found` : `quote ${bId} not found`, notFound: true };

  const money = [];
  const percent = [];
  const plain = [];
  for (const [key, name, kind] of NUMERIC) {
    const av = a[key] == null ? null : Number(a[key]);
    const bv = b[key] == null ? null : Number(b[key]);
    const valid = av != null && bv != null && Number.isFinite(av) && Number.isFinite(bv);
    const diff = valid ? round4(bv - av) : null;
    const pctDiff = valid && av !== 0 ? round4(((bv - av) / av) * 100) : null;
    const row = {
      key, label: name, kind,
      a: a[key] == null ? null : av, b: b[key] == null ? null : bv,
      diff, pctDiff,
      changed: valid ? Math.abs(diff) > 1e-9 : a[key] !== b[key],
    };
    (kind === 'money' ? money : kind === 'pct' ? percent : plain).push(row);
  }

  const text = TEXT.map(([key, name]) => ({
    key, label: name,
    a: a[key] == null ? null : a[key], b: b[key] == null ? null : b[key],
    changed: (a[key] == null ? null : a[key]) !== (b[key] == null ? null : b[key]),
  }));

  const numeric = [...money, ...percent, ...plain];
  const changedNumeric = numeric.filter((r) => r.changed);
  const pcts = numeric.map((r) => r.pctDiff).filter((p) => p != null);
  const maxAbsPctDiff = pcts.length ? round4(Math.max(...pcts.map((p) => Math.abs(p)))) : null;

  return {
    a: { id: a.id, label: label(a), customer: a.customer_name, product: a.display_name, currency: a.currency, status: a.status },
    b: { id: b.id, label: label(b), customer: b.customer_name, product: b.display_name, currency: b.currency, status: b.status },
    currencyMismatch: a.currency !== b.currency,
    money, percent, plain, text,
    summary: {
      changedFields: changedNumeric.length + text.filter((t) => t.changed).length,
      changedNumeric: changedNumeric.length,
      maxAbsPctDiff,
      currencyMismatch: a.currency !== b.currency,
    },
  };
}

module.exports = { compareQuotes };
