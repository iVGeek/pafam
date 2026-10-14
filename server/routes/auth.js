'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../services/auth');

// Public: current user (null when not logged in)
router.get('/auth/me', (req, res) => {
  res.json({ user: req.user || null });
});

router.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = auth.authenticate(username, password);
  if (!user) return res.status(401).json({ error: 'invalid username or password' });
  auth.pruneSessions();
  const { token, maxAgeMs } = auth.createSession(user.id);
  auth.setSessionCookie(res, token, maxAgeMs);
  res.json({ user });
});

router.post('/auth/logout', (req, res) => {
  auth.destroySession(req.sessionToken);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.post('/auth/password', auth.requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'new password must be at least 6 characters' });
  }
  const stored = require('../db').db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!auth.verifyPassword(currentPassword, stored.password_hash)) {
    return res.status(403).json({ error: 'current password is incorrect' });
  }
  auth.setPassword(req.user.id, newPassword);
  res.json({ ok: true });
});

// ---- Admin: user management ----
router.get('/users', auth.requireRole('admin'), (req, res) => res.json(auth.listUsers()));

router.post('/users', auth.requireRole('admin'), (req, res, next) => {
  try {
    const { username, password, role, displayName, email } = req.body || {};
    const id = auth.createUser({ username, password, role, displayName, email });
    res.json({ ok: true, id });
  } catch (e) { next(e); }
});

router.post('/users/:id', auth.requireRole('admin'), (req, res, next) => {
  try {
    const b = req.body || {};
    const updated = auth.updateUser(Number(req.params.id), {
      displayName: b.displayName, email: b.email, role: b.role,
      active: b.active != null ? !!b.active : undefined,
    });
    if (b.password) auth.setPassword(Number(req.params.id), b.password);
    res.json({ ok: true, user: updated });
  } catch (e) { next(e); }
});

module.exports = router;
