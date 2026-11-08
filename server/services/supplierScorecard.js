'use strict';

// Supplier scorecards (brief section 18).
//
// "Rank suppliers by executable landed cost, fill rate, on-time delivery,
//  claims, authenticity evidence, payment terms and confirmation accuracy;
//  cheapest quoted price alone is insufficient."
//
// Every metric is computed from records the system already holds:
//   fill rate       -> purchase orders + orders that reached received/delivered
//                      vs cancelled (supplier side only)
//   on-time         -> outbound payment date vs supplier_due on completed orders
//   claims          -> PFI variance (lines changed / variance %) per supplier
//   evidence        -> approved share of offers + exception rate per upload
//   terms           -> payment terms parsed to days (longer = better)
//   competitiveness -> cheapest-wins count (from analytics wins) + offer share
//
// Honest scoring: a metric with no underlying records returns null and its
// weight is redistributed across the metrics that do exist. Nothing is
// scored 0 for "no data" — that would punish a new supplier for being new.

const { db } = require('../db');

function clamp01(n) { return Math.max(0, Math.min(1, n)); }
function round1(n) { return Math.round(n * 10) / 10; }

// "Net 30", "30 days" -> 30; "Prepay" -> 0; unknown -> null
function termsDays(terms) {
  if (!terms) return null;
  const s = String(terms).toLowerCase();
  if (/prepay|prepayment|cod|cash on/.test(s)) return 0;
  let m = s.match(/net\s*(\d+)/);
  if (m) return Number(m[1]);
  m = s.match(/(\d+)\s*(?:days?|d\b)/);
  return m ? Number(m[1]) : null;
}

function scorecard(supplierCode) {
  const sup = db.prepare('SELECT * FROM suppliers WHERE code = ?').get(supplierCode);
  if (!sup) return { error: 'supplier not found', supplierCode };

  // ---- catalogue + quality ----
  const offers = db.prepare('SELECT COUNT(*) n FROM offers WHERE supplier_code = ?').get(supplierCode).n;
  const approved = db.prepare("SELECT COUNT(*) n FROM offers WHERE supplier_code = ? AND approval_status = 'approved'").get(supplierCode).n;
  const approvalRate = offers ? approved / offers : null;

  const exc = db.prepare(
    `SELECT COUNT(*) n FROM exceptions e JOIN offers o ON o.id = e.offer_id
      WHERE o.supplier_code = ? AND e.resolved = 0`
  ).get(supplierCode).n;
  const uploads = db.prepare('SELECT COUNT(*) n FROM uploads WHERE supplier_code = ?').get(supplierCode).n;
  const lastUpload = db.prepare('SELECT MAX(uploaded_at) d FROM uploads WHERE supplier_code = ?').get(supplierCode).d;
  const exceptionRate = offers ? exc / offers : null;

  const winsRow = db.prepare(
    `SELECT COUNT(*) n FROM (SELECT o.product_id FROM offers o WHERE o.supplier_code = ? AND o.product_id IS NOT NULL GROUP BY o.product_id)`
  ).get(supplierCode).n;
  // cheapest wins from the comparison tables (approximation via price rank per product)
  let cheapestWins = 0;
  try {
    cheapestWins = db.prepare(
      `SELECT COUNT(*) n FROM (
         SELECT o.product_id, o.price, o.supplier_code,
                RANK() OVER (PARTITION BY o.product_id ORDER BY o.price ASC) r
           FROM offers o WHERE o.price IS NOT NULL AND o.price > 0 AND o.product_id IS NOT NULL
       ) WHERE supplier_code = ? AND r = 1`
    ).get(supplierCode).n;
  } catch (_) { cheapestWins = 0; }

  // ---- fulfilment ----
  const pos = db.prepare('SELECT status, COUNT(*) n FROM purchase_orders WHERE supplier_code = ? GROUP BY status').all(supplierCode);
  const poTotal = pos.reduce((s, r) => s + r.n, 0);
  const poFilled = pos.filter((r) => ['received', 'confirmed', 'placed', 'sent'].includes(r.status)).reduce((s, r) => s + r.n, 0);
  const poCancelled = pos.filter((r) => r.status === 'cancelled').reduce((s, r) => s + r.n, 0);
  const poFill = poTotal - poCancelled > 0 ? poFilled / Math.max(1, poTotal - poCancelled) : null;

  const ords = db.prepare('SELECT status, supplier_due, created_at, id FROM orders WHERE supplier_code = ?').all(supplierCode);
  const ordFillable = ords.filter((o) => o.status !== 'cancelled' && o.status !== 'draft');
  const ordFilled = ords.filter((o) => ['received', 'shipped', 'delivered', 'closed'].includes(o.status));
  const ordFill = ordFillable.length ? ordFilled.length / ordFillable.length : null;

  // on-time: outbound payment date vs supplier_due, completed orders only
  let onTime = null;
  let onTimeN = 0;
  if (ordFilled.length) {
    let hits = 0;
    let dated = 0;
    for (const o of ordFilled) {
      if (!o.supplier_due) continue;
      const pay = db.prepare(
        "SELECT paid_date FROM payments WHERE order_id = ? AND direction = 'outbound' AND paid_date IS NOT NULL ORDER BY paid_date DESC LIMIT 1"
      ).get(o.id);
      if (!pay) continue;
      dated += 1;
      if (String(pay.paid_date) <= String(o.supplier_due)) hits += 1;
    }
    if (dated) { onTime = hits / dated; onTimeN = dated; }
  }

  // ---- claims / confirmation accuracy (PFI) ----
  const pfis = db.prepare(
    `SELECT pfi.* FROM pfi_documents pfi JOIN purchase_orders po ON po.id = pfi.po_id WHERE po.supplier_code = ?`
  ).all(supplierCode);
  const pfiChanged = pfis.reduce((s, p) => s + (Number(p.lines_changed) || 0), 0);
  const pfiMatched = pfis.reduce((s, p) => s + (Number(p.lines_matched) || 0), 0);
  const pfiDenom = pfiChanged + pfiMatched;
  const accuracy = pfiDenom > 0 ? pfiMatched / pfiDenom : null;
  const avgVariance = pfis.length ? pfis.reduce((s, p) => s + Math.abs(Number(p.variance_pct) || 0), 0) / pfis.length : null;

  const days = termsDays(sup.payment_terms);
  const termsScore = days != null ? clamp01(days / 60) : null; // 60d+ is excellent for this trade

  // ---- composite with redistribution ----
  const parts = [
    { key: 'fillRate', label: 'Fill rate (orders received, not cancelled)', value: ordFill != null ? ordFill : poFill, weight: 25 },
    { key: 'onTime', label: 'On-time (payment by supplier due date)', value: onTime, weight: 20 },
    { key: 'confirmationAccuracy', label: 'Confirmation accuracy (PFI lines matched)', value: accuracy, weight: 20 },
    { key: 'quality', label: 'Data quality (approved share, low exceptions)', value: approvalRate != null ? clamp01(approvalRate - (exceptionRate || 0)) : null, weight: 15 },
    { key: 'competitiveness', label: 'Competitiveness (cheapest-wins share of products)', value: winsRow ? clamp01(cheapestWins / winsRow) : null, weight: 10 },
    { key: 'terms', label: 'Payment terms (longer = better)', value: termsScore, weight: 10 },
  ];
  const known = parts.filter((p) => p.value != null);
  const totalWeight = known.reduce((s, p) => s + p.weight, 0) || 1;
  const score = known.length ? round1(known.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight * 100) : null;

  return {
    supplierCode: sup.code,
    supplierName: sup.name,
    currency: sup.currency,
    paymentTerms: sup.payment_terms || null,
    offers, approved, approvalRate: approvalRate != null ? round1(approvalRate * 100) : null,
    openExceptions: exc, uploads, lastUpload,
    cheapestWins, productsWithOffers: winsRow,
    purchaseOrders: poTotal, orders: ords.length,
    pfiCount: pfis.length, pfiChanged, pfiMatched,
    avgVariancePct: avgVariance != null ? round1(avgVariance) : null,
    scoredParts: known.map((p) => ({ key: p.key, label: p.label, value: round1(p.value * 100), weight: p.weight })),
    missingParts: parts.filter((p) => p.value == null).map((p) => p.label),
    score,
    grade: score == null ? 'insufficient data' : score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D',
  };
}

function scorecards() {
  return db.prepare('SELECT code FROM suppliers ORDER BY name').all().map((r) => scorecard(r.code));
}

module.exports = { scorecard, scorecards, termsDays };
