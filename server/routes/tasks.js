'use strict';

const express = require('express');
const router = express.Router();
const tasks = require('../services/tasks');
const auth = require('../services/auth');

const actor = (req) => (req.user ? req.user.username : 'user');

// GET /api/tasks  — open/done follow-ups with an overdue flag
router.get('/tasks', (req, res) => {
  res.json({
    rows: tasks.list({
      status: req.query.status,
      openOnly: req.query.openOnly === '1' || req.query.openOnly === 'true',
      overdue: req.query.overdue === '1' || req.query.overdue === 'true',
      owner: req.query.owner,
      captureId: req.query.captureId,
      limit: req.query.limit,
    }),
    summary: tasks.summary(),
  });
});

router.get('/tasks/summary', (req, res) => {
  res.json(tasks.summary());
});

// POST /api/tasks  — create a follow-up by hand (analyst+)
router.post('/tasks', auth.requireRole('analyst'), (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'title required' });
  const id = tasks.create({ ...b, createdBy: actor(req) });
  res.json({ ok: true, id, summary: tasks.summary() });
});

// POST /api/tasks/:id/done  — the follow-up happened
router.post('/tasks/:id/done', auth.requireRole('analyst'), (req, res) => {
  const r = tasks.complete(req.params.id, actor(req), (req.body || {}).notes);
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

router.post('/tasks/:id/cancel', auth.requireRole('analyst'), (req, res) => {
  const r = tasks.cancel(req.params.id, actor(req));
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

module.exports = router;