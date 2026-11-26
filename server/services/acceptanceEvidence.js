'use strict';

// Authoritative source for pilot-acceptance claims.
//
// The assistant must never infer that a criterion passed from record counts or
// from demo data. A criterion is only "met" when an administrator has recorded
// a real evidence reference AND the data mode is real AND the PO has signed off
// with a reference to their signature in the evidence pack. Every other state
// is reported as unproven.

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

// Placeholder text is not evidence, even if an administrator writes it
// straight into the settings table. Also used by the recorder to validate
// input before it is stored.
const PLACEHOLDER = /\b(?:demo|sample|synthetic|test|testing|n\/a|na|none|tbd|todo|placeholder|xxx+)\b/i;

function isProof(value) {
  const v = String(value == null ? '' : value).trim();
  return v.length >= 4 && v.length <= 500 && !PLACEHOLDER.test(v);
}

function dataMode() {
  const mode = String(getSetting(DATA_MODE_KEY, 'demo') || 'demo').toLowerCase();
  return mode === 'real' ? 'real' : 'demo';
}

function rawSignoff() {
  const raw = String(getSetting(SIGNOFF_KEY, '') || '').trim();
  if (!raw) return null;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return {
    name: String(parsed.name || '').trim(),
    email: String(parsed.email || '').trim(),
    evidenceRef: String(parsed.evidenceRef || '').trim(),
    recordedBy: String(parsed.recordedBy || '').trim() || null,
    recordedAt: String(parsed.recordedAt || '').trim() || null,
  };
}

function signoff() {
  const s = rawSignoff();
  if (!s || !s.name || !s.email || !isProof(s.evidenceRef)) return null;
  return s;
}

function criterionEvidence(id) {
  return String(getSetting(EVIDENCE_PREFIX + id, '') || '').trim();
}

function evidence() {
  const mode = dataMode();
  const signed = signoff();
  const criteria = CRITERIA.map((c) => {
    // Counts, product totals and other system statistics are not evidence.
    const proof = criterionEvidence(c.id);
    const status = mode === 'real' && signed && isProof(proof) ? 'met' : 'unproven';
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
    poSignoff: signed,
    criteria,
    met,
    total: criteria.length,
    verdict: mode === 'real' && signed && met === criteria.length ? 'all_met' : 'not_confirmed',
    note: mode !== 'real'
      ? 'This database is marked demo/synthetic. No acceptance criterion can be met on it, whatever the record counts show.'
      : !signed
        ? 'The PO sign-off (name, email and signature reference) is not recorded. No acceptance criterion can be confirmed.'
        : 'Only criteria with a recorded evidence reference are met; all others remain unproven.',
  };
}

// Raw recorder state for the admin UI: shows incomplete entries and who saved
// them, which the authoritative evidence() deliberately hides as unproven.
function recorderState() {
  return {
    dataMode: dataMode(),
    signoff: rawSignoff(),
    criteria: CRITERIA.map((c) => ({ id: c.id, title: c.title, evidence: criterionEvidence(c.id) })),
  };
}

module.exports = {
  CRITERIA, evidence, recorderState, dataMode, signoff, rawSignoff, isProof,
  criterionEvidence, DATA_MODE_KEY, SIGNOFF_KEY, EVIDENCE_PREFIX,
};
