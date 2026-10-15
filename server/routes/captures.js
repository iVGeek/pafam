'use strict';

const express = require('express');
const router = express.Router();
const { db, getSetting, audit } = require('../db');
const auth = require('../services/auth');
const { parseNote } = require('../../src/lib/notes');
const tasks = require('../services/tasks');

function insertCapture({ source, title, text, createdBy }) {
  const parsed = parseNote(text);
  const info = db.prepare(
    'INSERT INTO captures(source, title, raw_text, parsed_json, created_by) VALUES(?,?,?,?,?)'
  ).run(source || 'manual', title || null, text || '', JSON.stringify(parsed), createdBy || 'system');
  const id = Number(info.lastInsertRowid);
  // A note that contains a real lead signal gets an open follow-up task so it
  // cannot sit in the inbox unworked (brief section 15).
  const taskId = tasks.taskForCapture({ id, source, title }, parsed, createdBy);
  return { id, taskId };
}

// ---- Public webhook (device -> platform). Auth via shared secret. ----
// Plaud / reMarkable / Zapier / IFTTT can POST here.
router.post('/captures/webhook', (req, res) => {
  const secret = getSetting('capture_secret', '');
  const provided = (req.headers['x-capture-secret']) || (req.body && req.body.secret);
  if (!secret || provided !== secret) return res.status(401).json({ error: 'invalid capture secret' });
  const b = req.body || {};
  const text = b.text || b.transcript || b.content || b.note || '';
  if (!text) return res.status(400).json({ error: 'no text/transcript provided' });
  const { id, taskId } = insertCapture({ source: b.source || 'webhook', title: b.title, text, createdBy: 'webhook' });
  audit('webhook', 'capture-ingest', 'capture', id, b.source || 'webhook');
  res.json({ ok: true, id, taskId });
});

// ---- Authenticated capture endpoints ----
router.get('/captures', auth.requireAuth, (req, res) => {
  const status = req.query.status || null;
  let sql = 'SELECT * FROM captures';
  const params = [];
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  sql += ' ORDER BY captured_at DESC LIMIT 500';
  const rows = db.prepare(sql).all(...params).map((r) => ({ ...r, parsed: r.parsed_json ? JSON.parse(r.parsed_json) : null }));
  res.json(rows);
});

router.post('/captures', auth.requireRole('analyst'), (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.text) return res.status(400).json({ error: 'text required' });
    const { id, taskId } = insertCapture({ source: b.source || 'manual', title: b.title, text: b.text, createdBy: req.user.username });
    audit(req.user.username, 'capture-create', 'capture', id, b.source || 'manual');
    res.json({ ok: true, id, taskId, capture: db.prepare('SELECT * FROM captures WHERE id = ?').get(id) });
  } catch (e) { next(e); }
});

router.get('/captures/:id', auth.requireAuth, (req, res) => {
  const r = db.prepare('SELECT * FROM captures WHERE id = ?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json({ ...r, parsed: r.parsed_json ? JSON.parse(r.parsed_json) : null });
});

// Promote a capture into a real demand.
router.post('/captures/:id/promote', auth.requireRole('buyer'), (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cap = db.prepare('SELECT * FROM captures WHERE id = ?').get(id);
    if (!cap) return res.status(404).json({ error: 'capture not found' });
    const b = req.body || {};
    if (!b.customerId || !b.productId) return res.status(400).json({ error: 'customerId and productId required' });
    const quantity = Number(b.quantity) || 0;
    const info = db.prepare(
      `INSERT INTO demands(customer_id, product_id, status, quantity, target_price, currency, needed_by, source, approved, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      Number(b.customerId), Number(b.productId), 'open', quantity,
      b.targetPrice != null ? Number(b.targetPrice) : null, b.currency || 'USD',
      b.neededBy || null, 'note', b.approved ? 1 : 0, `From ${cap.source} capture #${id}: ${cap.title || ''}`
    );
    const demandId = Number(info.lastInsertRowid);
    db.prepare("UPDATE captures SET status = 'promoted', demand_id = ? WHERE id = ?").run(demandId, id);
    // The note has now been actioned, so its follow-up task is done.
    tasks.closeForCapture(id, req.user.username, `Promoted to demand #${demandId}`);
    audit(req.user.username, 'capture-promote', 'capture', id, `demand ${demandId}`);
    res.json({ ok: true, demandId });
  } catch (e) { next(e); }
});

router.post('/captures/:id/ignore', auth.requireRole('analyst'), (req, res) => {
  const id = Number(req.params.id);
  db.prepare("UPDATE captures SET status = 'ignored' WHERE id = ?").run(id);
  tasks.closeForCapture(id, req.user.username, 'Capture ignored');
  audit(req.user.username, 'capture-ignore', 'capture', id);
  res.json({ ok: true });
});

router.delete('/captures/:id', auth.requireRole('buyer'), (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM captures WHERE id = ?').run(id);
  audit(req.user.username, 'capture-delete', 'capture', id);
  res.json({ ok: true });
});

module.exports = router;
