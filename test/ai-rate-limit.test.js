'use strict';
// Paid AI calls are capped per signed-in user, and the limiter's key map stays
// bounded. No provider network: the AI transport is swapped for a fake.
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `ptp-ailimit-${process.pid}.db`);
process.env.PTP_DATA_DIR = path.dirname(TMP_DB);
process.env.PTP_DB = TMP_DB;
process.env.PTP_AI_MOCK = '1';
process.env.AI_RATE_LIMIT_PER_HOUR = '3';
delete process.env.AI_API_KEY;
delete process.env.AI_BASE_URL;
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch (_) { /* ignore */ }
  }
});

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createLimiter } = require('../server/services/rateLimit');
const ai = require('../server/services/ai');

test('createLimiter enforces the window and expires old hits', () => {
  const l = createLimiter({ max: 2, windowMs: 1000, maxKeys: 10, sweepMs: 0 });
  assert.strictEqual(l.consume('u', 1000), true);
  assert.strictEqual(l.consume('u', 1010), true);
  assert.strictEqual(l.consume('u', 1020), false, 'third use in window refused');
  assert.strictEqual(l.consume('other', 1020), true, 'other keys unaffected');
  assert.strictEqual(l.consume('u', 2100), true, 'old hits expire');
});

test('createLimiter hard-caps the number of keys', () => {
  const l = createLimiter({ max: 1, windowMs: 100_000, maxKeys: 3, sweepMs: 0 });
  for (let i = 0; i < 20; i += 1) l.consume('u' + i, 1000);
  assert.ok(l.size() <= 3, 'key map never exceeds maxKeys');
});

let server;
let base;
let cookie;
let viewerCookie;

before(async () => {
  ai.setTransport(async () => ({
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
    _model: 'mock:model',
  }));
  const app = require('../server');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  require('../server/services/auth').createUser({ username: 'admin', password: 'admin123', role: 'admin' });
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  assert.strictEqual(r.status, 200);
  cookie = r.headers.get('set-cookie');
  require('../server/services/auth').createUser({ username: 'viewer', password: 'viewer123', role: 'viewer' });
  const v = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'viewer', password: 'viewer123' }),
  });
  assert.strictEqual(v.status, 200);
  viewerCookie = v.headers.get('set-cookie');
});

after(() => { if (server) server.close(); });

test('http: AI chat is capped per signed-in user', async () => {
  const post = () => fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  for (let i = 0; i < 3; i += 1) {
    const r = await post();
    assert.strictEqual(r.status, 200, 'allowed call ' + (i + 1));
    const j = await r.json();
    assert.strictEqual(j.reply, 'ok');
  }
  const blocked = await post();
  assert.strictEqual(blocked.status, 429, 'fourth call is throttled');
  assert.ok(blocked.headers.get('retry-after'));
  // Unauthenticated calls are rejected by auth before the limiter, as usual.
  const anon = await fetch(`${base}/api/ai/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  });
  assert.strictEqual(anon.status, 401);
});

test('http: AI diagnose is admin-only and rate-limited', async () => {
  const byViewer = await fetch(`${base}/api/ai/diagnose`, { headers: { cookie: viewerCookie } });
  assert.strictEqual(byViewer.status, 403, 'viewer cannot reach provider/account diagnostics');
  const first = await fetch(`${base}/api/ai/diagnose`, { headers: { cookie } });
  assert.notStrictEqual(first.status, 403, 'admin passes the role gate');
  const second = await fetch(`${base}/api/ai/diagnose`, { headers: { cookie } });
  assert.strictEqual(second.status, 429, 'a second admin call within 5 minutes is throttled');
  assert.ok(second.headers.get('retry-after'));
});
