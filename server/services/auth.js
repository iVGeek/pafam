'use strict';

const crypto = require('crypto');
const { db, getSetting, audit } = require('../db');

const ROLES = ['viewer', 'analyst', 'buyer', 'admin'];
const RANK = { viewer: 1, analyst: 2, buyer: 3, admin: 4 };
const COOKIE = 'ptp_session';

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, 64).toString('hex');
  return `${s}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const calc = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createUser({ username, password, role = 'viewer', displayName, email }) {
  if (!username || !password) throw Object.assign(new Error('username and password required'), { status: 400 });
  if (!ROLES.includes(role)) throw Object.assign(new Error('invalid role'), { status: 400 });
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) throw Object.assign(new Error('username already exists'), { status: 409 });
  const info = db.prepare(
    'INSERT INTO users(username, display_name, email, password_hash, role) VALUES (?,?,?,?,?)'
  ).run(username, displayName || username, email || null, hashPassword(password), role);
  audit('system', 'create-user', 'user', Number(info.lastInsertRowid), `${username} (${role})`);
  return Number(info.lastInsertRowid);
}

function setPassword(userId, password) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
  audit('system', 'set-password', 'user', userId);
}

function listUsers() {
  return db.prepare('SELECT id, username, display_name, email, role, active, created_at, last_login FROM users ORDER BY id').all();
}

function getById(id) {
  return db.prepare('SELECT id, username, display_name, email, role, active, created_at, last_login FROM users WHERE id = ?').get(id);
}

function updateUser(id, fields) {
  const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!cur) throw Object.assign(new Error('user not found'), { status: 404 });
  db.prepare('UPDATE users SET display_name = ?, email = ?, role = ?, active = ? WHERE id = ?').run(
    fields.displayName != null ? fields.displayName : cur.display_name,
    fields.email !== undefined ? fields.email : cur.email,
    fields.role != null ? fields.role : cur.role,
    fields.active != null ? (fields.active ? 1 : 0) : cur.active,
    id
  );
  audit('system', 'update-user', 'user', id, JSON.stringify(fields));
  return getById(id);
}

function authenticate(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !user.active) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return getById(user.id);
}

function createSession(userId) {
  const hours = Number(getSetting('session_hours', '168')) || 168;
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expires);
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(userId);
  return { token, expires, maxAgeMs: hours * 3600 * 1000 };
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// remove expired sessions opportunistically
function pruneSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}

function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.username, u.display_name, u.email, u.role, u.active
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).get(token);
  if (!row || !row.active) return null;
  return row;
}

/* ---------- middleware ---------- */
function parseCookies(req, res, next) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  req.cookies = out;
  next();
}

function attachUser(req, res, next) {
  let token = (req.cookies && req.cookies[COOKIE]) || null;
  if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7);
  }
  req.sessionToken = token;
  req.user = token ? userFromToken(token) : null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'authentication required' });
  next();
}

function requireRole(minRole) {
  const min = RANK[minRole] || 99;
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'authentication required' });
    if ((RANK[req.user.role] || 0) < min) return res.status(403).json({ error: 'insufficient permissions (' + minRole + ' required)' });
    next();
  };
}

function setSessionCookie(res, token, maxAgeMs) {
  const parts = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Ensure there is at least one admin so a fresh install is reachable.
function ensureBootstrapAdmin() {
  const n = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n;
  if (n === 0) {
    const total = db.prepare('SELECT COUNT(*) n FROM users').get().n;
    const username = process.env.PTP_ADMIN_USER || 'admin';
    const password = process.env.PTP_ADMIN_PASS || (total === 0 ? 'admin123' : crypto.randomBytes(6).toString('hex'));
    const id = createUser({ username, password, role: 'admin', displayName: 'Administrator' });
    return { created: true, username, password, id };
  }
  return { created: false };
}

module.exports = {
  ROLES, RANK, COOKIE,
  hashPassword, verifyPassword, createUser, setPassword, listUsers, getById, updateUser,
  authenticate, createSession, destroySession, pruneSessions, userFromToken,
  parseCookies, attachUser, requireAuth, requireRole,
  setSessionCookie, clearSessionCookie, ensureBootstrapAdmin,
};
