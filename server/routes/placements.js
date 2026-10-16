'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const auth = require('../services/auth');
const placements = require('../services/placements');
const pfiSvc = require('../services/pfi');

const mem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const actor = (req) => (req.user ? req.user.username : 'user');

// Supplier order placements: cost price + full-box quantities, ready to send
// to a supplier. Read (viewer+), write (buyer+).
router.get('/placements', (req, res) => {
  res.json({ rows: placements.listPlacements(req.query.limit) });
});

// Auto-fill candidates from the purchase plan for one supplier (or all).
// Declared before /placements/:id so "plan" is not read as an id.
router.get('/placements/plan', (req, res) => {
  res.json(placements.planForSupplier(req.query.supplier ? String(req.query.supplier) : null));
});

router.get('/placements/:id', (req, res) => {
  const id = String(req.params.id || '').replace(/\.xlsx$/i, '');
  const p = placements.getPlacement(id);
  if (!p) return res.status(404).json({ error: 'placement not found' });
  res.json(p);
});

router.post('/placements', auth.requireRole('buyer'), (req, res) => {
  const out = placements.createPlacement(Object.assign({}, req.body || {}, { createdBy: actor(req) }));
  if (out.error) return res.status(400).json({ error: out.error });
  res.json(placements.getPlacement(out.id));
});

/* ---------- PFI reconciliation (order placement vs supplier proforma) ---------- */

// List the PFI comparisons recorded against a placement.
router.get('/placements/:id/pfi', (req, res) => {
  const p = placements.getPlacement(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'placement not found' });
  res.json({ rows: pfiSvc.listPfi(p.id) });
});

// Upload a supplier PFI (Excel) and compare it to the placement. Analyst+.
router.post('/placements/:id/pfi', auth.requireRole('analyst'), mem.single('file'), (req, res, next) => {
  try {
    const p = placements.getPlacement(Number(req.params.id));
    if (!p) return res.status(404).json({ error: 'placement not found' });
    if (!req.file) return res.status(400).json({ error: 'Upload a PFI file (field "file").' });
    const pfi = pfiSvc.parsePfi(req.file.buffer);
    if (!pfi.rows.length) return res.status(400).json({ error: 'No barcode/price/quantity header found in the PFI file.' });
    const cmp = pfiSvc.compareToPlacement(p, pfi);
    const cap = 500;
    const detail = { matched: cmp.matched.slice(0, cap), extra: cmp.extra.slice(0, cap), missing: cmp.missing.slice(0, cap) };
    const id = pfiSvc.savePfi(p.id, {
      reference: req.body && req.body.reference, filename: req.file.originalname,
      currency: p.currency, orderTotal: cmp.orderTotal, pfiTotal: cmp.pfiTotal,
      varianceTotal: cmp.varianceTotal, variancePct: cmp.orderTotal ? pfiSvc.round4((cmp.varianceTotal / cmp.orderTotal) * 100) : null,
      linesMatched: cmp.matched.length, linesChanged: cmp.summary.priceChanges + cmp.summary.quantityChanges,
      detail, createdBy: actor(req),
    });
    res.json({
      id,
      placement: { id: p.id, ref: p.ref, supplier_code: p.supplier_code, currency: p.currency },
      pfi: { name: req.file.originalname, sheet: pfi.sheet, headerRow: pfi.headerRow, columns: pfi.columns, rowCount: pfi.rows.length },
      orderTotal: cmp.orderTotal, pfiTotal: cmp.pfiTotal, varianceTotal: cmp.varianceTotal,
      summary: cmp.summary, matched: detail.matched, extra: detail.extra, missing: detail.missing,
    });
  } catch (e) { next(e); }
});

// Fetch one recorded comparison (with its stored detail).
router.get('/pfi/:id', (req, res) => {
  const rec = pfiSvc.getPfi(Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'PFI not found' });
  let detail = rec.detail;
  if (typeof detail === 'string') { try { detail = JSON.parse(detail); } catch (_) { detail = {}; } }
  res.json({ record: rec, detail: detail || {} });
});

// Attach the reference PDF to a recorded comparison (buyer+).
router.post('/pfi/:id/attach', auth.requireRole('buyer'), mem.single('file'), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Upload a PDF (field "file").' });
    const out = pfiSvc.attachPdf(Number(req.params.id), req.file);
    if (!out) return res.status(404).json({ error: 'PFI not found' });
    res.json({ ok: true, name: out.name });
  } catch (e) { next(e); }
});

// Download the attached PDF.
router.get('/pfi/:id/attachment', (req, res) => {
  const out = pfiSvc.attachment(Number(req.params.id));
  if (!out) return res.status(404).json({ error: 'no attachment' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.send(out.buffer);
});

// Delete a recorded comparison (buyer+).
router.delete('/pfi/:id', auth.requireRole('buyer'), (req, res) => {
  if (!pfiSvc.removePfi(Number(req.params.id))) return res.status(404).json({ error: 'PFI not found' });
  res.json({ ok: true });
});

module.exports = router;
