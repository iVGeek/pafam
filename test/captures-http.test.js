'use strict';
// Text-only capture intake: the HTTP routes must refuse PDF/image payloads
// (no OCR) while still accepting plain-text notes. Same fixture bootstrap as
// export.test.js so this never touches the dev database.
const os = require('os');
const path = require('path');
const fs = require('fs');
const TMP_DB = path.join(os.tmpdir(), `ptp-captures-test-${process.pid}.db`);
const SNAP = path.join(os.tmpdir(), 'ptp-test-fixture.db');
const useCache = process.env.PTP_TEST_NO_CACHE !== '1' && fs.existsSync(SNAP);

process.env.PTP_DATA_DIR = path.dirname(TMP_DB);
process.env.PTP_DB = TMP_DB;
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch (e) { /* ignore */ }
  }
});

const { test, before, after } = require('node:test');
if (useCache) fs.copyFileSync(SNAP, TMP_DB);
const assert = require('node:assert');
const http = require('http');
const { db } = require('../server/db');

if (!useCache) {
  require('../server/seedData').seedData({ log: () => {} });
}

let server;
let base;
let cookie;
let captureSecret;

before(async () => {
  const app = require('../server');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  assert.strictEqual(r.status, 200, 'login works in-process');
  cookie = r.headers.get('set-cookie');
  assert.ok(cookie, 'session cookie issued');
  captureSecret = (db.prepare("SELECT value FROM settings WHERE key = 'capture_secret'").get() || {}).value || 'change-me-capture-secret';
});

after(() => { if (server) server.close(); });

function postFile(filename, bytes, type) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), filename);
  return fetch(`${base}/api/captures/import-plaud`, { method: 'POST', headers: { cookie }, body: fd });
}

test('http: a reMarkable PDF export is refused with conversion instructions', async () => {
  const r = await postFile('CUST42-20261117-AL.pdf', Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'), 'application/pdf');
  assert.strictEqual(r.status, 415);
  const j = await r.json();
  assert.match(j.error, /no OCR/i);
  assert.match(j.error, /Convert to text/i);
});

test('http: an image export is refused too', async () => {
  const r = await postFile('page.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png');
  assert.strictEqual(r.status, 415);
  assert.match((await r.json()).error, /PNG image/);
});

test('http: a plain-text reMarkable note still imports', async () => {
  const r = await postFile(
    'CUST42-20261117-AL.txt',
    Buffer.from('CUST42 wants 500 bottles of Dylan Blue at $32.50'),
    'text/plain',
  );
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.meeting.ok, true);
  assert.ok(j.parsed.quantities >= 1);
});

test('http: the webhook refuses a PDF payload but accepts text', async () => {
  const pdf = await fetch(`${base}/api/captures/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-capture-secret': captureSecret },
    body: JSON.stringify({ source: 'remarkable', title: 'CUST42-20261117-AL', text: '%PDF-1.7\nhandwritten' }),
  });
  assert.strictEqual(pdf.status, 415);
  assert.match((await pdf.json()).error, /text-only|no OCR/i);

  const text = await fetch(`${base}/api/captures/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-capture-secret': captureSecret },
    body: JSON.stringify({ source: 'remarkable', title: 'CUST42-20261117-AL', text: 'CUST42 wants 24 Dylan Blue' }),
  });
  assert.strictEqual(text.status, 200);
  assert.strictEqual((await text.json()).ok, true);
});
