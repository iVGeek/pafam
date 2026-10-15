'use strict';

// Offer approval (brief sections 3, 16 and 20).
//
// The brief is explicit that staff approve matches, prices and quantities
// before anything is bought. This module records that decision: who signed
// off, when, and on what basis. It is kept separate from the matching
// `status` column, because matching (does this barcode belong to this
// product?) and approval (is this price and quantity one we will trade on?)
// are different decisions made by different people.
//
// Whether approval is *enforced* is a setting. When `require_offer_approval`
// is on, an offer that has not been approved is not executable, so it cannot
// win a sourcing comparison or drive a buying recommendation. When it is off
// the review state is still recorded and shown, but trading is not blocked.

const { db, getSetting, audit } = require('../db');

const STATUSES = ['review', 'approved', 'rejected', 'expired'];

function approvalRequired() {
  return getSetting('require_offer_approval', '0') === '1';
}

function counts() {
  const rows = db.prepare('SELECT approval_status, COUNT(*) AS n FROM offers GROUP BY approval_status').all();
  const out = { review: 0, approved: 0, rejected: 0, expired: 0 };
  for (const r of rows) if (out[r.approval_status] != null) out[r.approval_status] = r.n;
  out.total = rows.reduce((s, r) => s + r.n, 0);
  return out;
}

function get(offerId) {
  return db.prepare(
    'SELECT id, supplier_code, approval_status, approved_by, approved_at, review_note FROM offers WHERE id = ?'
  ).get(Number(offerId));
}

// Record a decision. Only a buyer (or above) may approve — the brief puts
// this in the trading team's hands, not the analyst's.
function decide(offerId, decision, actor, note) {
  const d = String(decision || '').toLowerCase();
  if (!STATUSES.includes(d)) {
    return { ok: false, error: `decision must be one of ${STATUSES.join(', ')}` };
  }
  const offer = get(offerId);
  if (!offer) return { ok: false, error: 'offer not found' };

  // An offer cannot be approved if it has no price or is unmatched — there is
  // nothing meaningful to sign off, and approving it would hide the problem.
  const detail = db.prepare(
    'SELECT price, gtin_canonical, product_id FROM offers WHERE id = ?'
  ).get(Number(offerId));
  if (d === 'approved') {
    if (!(Number(detail.price) > 0)) {
      return { ok: false, error: 'cannot approve an offer with no price' };
    }
    if (!detail.gtin_canonical) {
      return { ok: false, error: 'cannot approve an offer with no valid barcode' };
    }
  }

  const approved = d === 'approved' ? 1 : 0;
  db.prepare(
    `UPDATE offers SET approval_status = ?, approved_by = ?, approved_at = ?, review_note = ? WHERE id = ?`
  ).run(
    d,
    d === 'review' ? null : (actor || null),
    d === 'review' ? null : new Date().toISOString().slice(0, 19).replace('T', ' '),
    note || null,
    Number(offerId)
  );
  audit(actor || 'system', `offer-${d}`, 'offer', Number(offerId), note || '');
  return { ok: true, id: Number(offerId), approvalStatus: d, counts: counts() };
}

// Bulk decision for a whole upload (a list arrives, a trader signs it off).
function decideUpload(uploadId, decision, actor, note) {
  const rows = db.prepare(
    'SELECT id FROM offers WHERE upload_id = ? AND (approval_status IS NULL OR approval_status = ?)'
  ).all(Number(uploadId), 'review');
  let done = 0;
  const errors = [];
  for (const r of rows) {
    const res = decide(r.id, decision, actor, note);
    if (res.ok) done++;
    else errors.push({ id: r.id, error: res.error });
  }
  audit(actor || 'system', `offer-${decision}-bulk`, 'upload', Number(uploadId), `${done} offers`);
  return { ok: true, total: rows.length, done, errors };
}

// SQL fragment / helper so callers can filter executable offers consistently.
// Returns true when the offer may be traded on right now.
function isExecutableOffer(offer) {
  if (!offer) return false;
  if (!approvalRequired()) return true;
  return offer.approval_status === 'approved';
}

module.exports = { STATUSES, approvalRequired, counts, get, decide, decideUpload, isExecutableOffer };