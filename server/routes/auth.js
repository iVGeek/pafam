'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../services/auth');

// Public: current user (null when not logged in)
router.get('/auth/me', (req, res) => {
  res.json({ user: req.user || null });
});

// Login brute-force guard: 10 failed attempts per username+IP per 5 minutes.
const FAILS = new Map();
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX = 10;
function loginKey(req, username) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  return ip + '|' + String(username || '').toLowerCase();
}
function loginBlocked(key) {
  const arr = (FAILS.get(key) || []).filter((t) => Date.now() - t < LOGIN_WINDOW_MS);
  FAILS.set(key, arr);
  return arr.length >= LOGIN_MAX;
}
function recordFail(key) {
  const arr = (FAILS.get(key) || []).filter((t) => Date.now() - t < LOGIN_WINDOW_MS);
  arr.push(Date.now());
  FAILS.set(key, arr);
}

router.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const key = loginKey(req, username);
  if (loginBlocked(key)) {
    res.setHeader('Retry-After', String(Math.ceil(LOGIN_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Too many failed login attempts. Retry in a few minutes.' });
  }
  const user = auth.authenticate(username, password);
  if (!user) {
    recordFail(key);
    // Distinguish "pending approval" so the user isn't confused.
    const existing = require('../db').db.prepare('SELECT active FROM users WHERE username = ?').get(username);
    if (existing && !existing.active) {
      return res.status(403).json({ error: 'Account is pending admin approval. You will be able to sign in once approved.' });
    }
    return res.status(401).json({ error: 'invalid username or password' });
  }
  FAILS.delete(key);
  auth.pruneSessions();
  const { token, maxAgeMs } = auth.createSession(user.id);
  auth.setSessionCookie(res, token, maxAgeMs);
  res.json({ user });
});

// Public self-registration -> pending (viewer, inactive) until an admin
// approves and assigns a role on the Users screen. Rate-limited like login.
const REG_FAILS = new Map();
router.post('/auth/register', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const arr = (REG_FAILS.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (arr.length >= LOGIN_MAX) {
    res.setHeader('Retry-After', String(Math.ceil(LOGIN_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Too many registration attempts. Retry in a few minutes.' });
  }
  const { username, password, confirmPassword, displayName, email } = req.body || {};
  if (password !== confirmPassword) { arr.push(now); REG_FAILS.set(ip, arr); return res.status(400).json({ error: 'Passwords do not match' }); }
  try {
    const id = auth.registerUser({ username, password, displayName, email });
    res.json({ ok: true, id, message: 'Account requested. An admin will approve it and assign your role — you can sign in after that.' });
  } catch (e) {
    arr.push(now); REG_FAILS.set(ip, arr);
    res.status(e.status || 400).json({ error: e.message });
  }
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
