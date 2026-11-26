'use strict';

// Authoritative source for pilot-acceptance claims.
//
// The assistant must never infer that a criterion passed from record counts or
// from demo data. A criterion is only "met" when an administrator has recorded
// the evidence reference AND the data mode is real AND the PO has signed off.
// Every other state is reported as unproven.

const { getSetting } = require('../db');

const DATA_MODE_KEY = 'acceptance_data_mode';
const SIGNOFF_KEY = 'acceptance_signoff';
const EVIDENCE_PREFIX = 'acceptance_criterion_';

const CRITERIA = [
  { id: 1, title: 'UPC/EAN aliases match; leading zeros survive Excel import' },
  { id: 2, title: 'Case barcodes, testers, gift sets and conflicting sizes do not merge' },
  { id: 3, title: 'Duplicate upload creates no extra offers; a new list preserves old prices' },
  { id: 4, title: 'One stock pool offered by two brokers is counted once' },
  { id: 5, title: 'Unknown and stale stock are excluded from confirmed totals' },
  { id: 6, title: 'The worked profitability example reconciles exactly' },
  { id: 7, title: 'Case conversion, MOQ, tiers, FX, freight, taxes, partial receipts and returns are reviewed' },
  { id: 8, title: 'Stock reservations cannot oversell the same lot' },
  { id: 9, title: 'Actual purchases, sales and payments reconcile with the supplied accounts sample' },
  { id: 10, title: 'Supplier costs do not appear on customer exports' },
];

function dataMode() {
  const mode = String(getSetting(DATA_MODE_KEY, 'demo') || 'demo').toLowerCase();
  return mode === 'real' ? 'real' : 'demo';
}

function signoff() {
  const raw = String(getSetting(SIGNOFF_KEY, '') || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) { /* a plain name is also acceptable */ }
  return { name: raw };
}

function evidence() {
  const mode = dataMode();
  const signed = signoff();
  const signedOff = Boolean(signed && (signed.name || signed.email));
  const criteria = CRITERIA.map((c) => {
    const proof = String(getSetting(EVIDENCE_PREFIX + c.id, '') || '').trim();
    // Counts, product totals and other system statistics are not evidence.
    const status = mode === 'real' && signedOff && proof && proof !== 'demo' ? 'met' : 'unproven';
    return {
      id: c.id,
      title: c.title,
      status,
      evidence: status === 'met' ? proof : null,
    };
  });
  const met = criteria.filter((c) => c.status === 'met').length;
  return {
    dataMode: mode,
    poSignoff: signedOff ? signed : null,
    criteria,
    met,
    total: criteria.length,
    verdict: mode === 'real' && signedOff && met === criteria.length ? 'all_met' : 'not_confirmed',
    note: mode !== 'real'
      ? 'This database is marked demo/synthetic. No acceptance criterion can be met on it, whatever the record counts show.'
      : !signedOff
        ? 'The PO sign-off is not recorded. No acceptance criterion can be confirmed.'
        : 'Only criteria with a recorded evidence reference are met; all others remain unproven.',
  };
}

module.exports = { CRITERIA, evidence, dataMode, DATA_MODE_KEY, SIGNOFF_KEY, EVIDENCE_PREFIX };
