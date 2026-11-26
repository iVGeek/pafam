'use strict';
// HTTP coverage for the admin-only acceptance recorder: role gating, input
// validation, audit entries, and agreement with the authoritative AI tool.
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `ptp-accept-recorder-${process.pid}.db`);
process.env.PTP_DATA_DIR = path.dirname(TMP_DB);
process.env.PTP_DB = TMP_DB;
delete process.env.AI_API_KEY;
delete process.env.AI_BASE_URL;
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch (e) { /* ignore */ }
  }
});

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

let server;
let base;
let adminCookie;
let viewerCookie;

async function call(method, url, cookie, body) {
  const headers = { cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(base + '/api' + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function login(username, password) {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.strictEqual(r.status, 200, username + ' login');
  return r.headers.get('set-cookie');
}

before(async () => {
  const app = require('../server');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const auth = require('../server/services/auth');
  auth.createUser({ username: 'admin', password: 'admin123', role: 'admin' });
  auth.createUser({ username: 'viewer', password: 'viewer123', role: 'viewer' });
  adminCookie = await login('admin', 'admin123');
  viewerCookie = await login('viewer', 'viewer123');
});

after(() => { if (server) server.close(); });

test('acceptance state is readable by signed-in users but only admins can change it', async () => {
  const read = await call('GET', '/acceptance', viewerCookie);
  assert.strictEqual(read.status, 200);
  const body = await read.json();
  assert.equal(body.status.dataMode, 'demo');
  assert.equal(body.status.met, 0);
  assert.equal(body.recorder.criteria.length, 10);

  const writes = [
    ['POST', '/acceptance/data-mode', { mode: 'demo' }],
    ['POST', '/acceptance/signoff', { name: 'PO', email: 'po@example.test', evidenceRef: 'Evidence pack v1' }],
    ['POST', '/acceptance/criteria/1', { evidence: 'Evidence pack v1' }],
    ['DELETE', '/acceptance/criteria/1'],
    ['DELETE', '/acceptance/signoff'],
  ];
  for (const [method, url, payload] of writes) {
    const r = await call(method, url, viewerCookie, payload);
    assert.strictEqual(r.status, 403, method + ' ' + url + ' is admin-only');
  }
  const anon = await call('POST', '/acceptance/data-mode', undefined, { mode: 'demo' });
  assert.strictEqual(anon.status, 401);
});

test('data mode requires an explicit real-data certification and is audited', async () => {
  const badMode = await call('POST', '/acceptance/data-mode', adminCookie, { mode: 'live' });
  assert.strictEqual(badMode.status, 400);

  const noConfirm = await call('POST', '/acceptance/data-mode', adminCookie, { mode: 'real' });
  assert.strictEqual(noConfirm.status, 400);
  assert.match((await noConfirm.json()).error, /REAL CLIENT DATA/);

  const ok = await call('POST', '/acceptance/data-mode', adminCookie, {
    mode: 'real', confirm: 'REAL CLIENT DATA',
  });
  assert.strictEqual(ok.status, 200);
  assert.equal((await ok.json()).status.dataMode, 'real');

  const auditRows = await (await call('GET', '/audit', adminCookie)).json();
  const entry = auditRows.find((r) => r.action === 'acceptance-set-data-mode');
  assert.ok(entry, 'data mode change is in the audit log');
  assert.equal(entry.actor, 'admin');
  assert.match(entry.detail, /demo -> real/);
});

test('PO sign-off needs a name, valid email and signature evidence reference', async () => {
  const missing = await call('POST', '/acceptance/signoff', adminCookie, {
    name: 'PO Name', email: 'not-an-email', evidenceRef: 'Evidence pack v3',
  });
  assert.strictEqual(missing.status, 400);

  const placeholder = await call('POST', '/acceptance/signoff', adminCookie, {
    name: 'PO Name', email: 'po@example.test', evidenceRef: 'sample signature',
  });
  assert.strictEqual(placeholder.status, 400);

  const ok = await call('POST', '/acceptance/signoff', adminCookie, {
    name: 'PO Name', email: 'po@example.test', evidenceRef: 'Evidence pack v3, page 12 signed',
  });
  assert.strictEqual(ok.status, 200);
  const status = (await ok.json()).status;
  assert.equal(status.poSignoff.name, 'PO Name');
  assert.equal(status.poSignoff.recordedBy, 'admin');
  assert.equal(status.met, 0, 'sign-off alone proves no criterion');

  const rows = await (await call('GET', '/audit', adminCookie)).json();
  assert.ok(rows.some((r) => r.action === 'acceptance-set-signoff' && r.actor === 'admin'));
});

test('criteria require valid ids and real evidence references, and are audited', async () => {
  const badId = await call('POST', '/acceptance/criteria/11', adminCookie, { evidence: 'Evidence pack v3' });
  assert.strictEqual(badId.status, 404);

  const placeholder = await call('POST', '/acceptance/criteria/1', adminCookie, { evidence: 'n/a' });
  assert.strictEqual(placeholder.status, 400);

  const ok = await call('POST', '/acceptance/criteria/1', adminCookie, {
    evidence: 'Evidence pack v3, criterion 1 worksheet',
  });
  assert.strictEqual(ok.status, 200);
  const status = (await ok.json()).status;
  assert.equal(status.met, 1);
  assert.equal(status.criteria[0].status, 'met');
  assert.equal(status.criteria[1].status, 'unproven');

  const rows = await (await call('GET', '/audit', adminCookie)).json();
  assert.ok(rows.some((r) => r.action === 'acceptance-set-criterion' && r.entity_id === 'acceptance_criterion_1'));

  const cleared = await call('DELETE', '/acceptance/criteria/1', adminCookie);
  assert.strictEqual(cleared.status, 200);
  assert.equal((await cleared.json()).status.met, 0);
});

test('generic settings API cannot write or expose acceptance fields', async () => {
  const r = await call('POST', '/settings', adminCookie, {
    acceptance_data_mode: 'demo',
    acceptance_signoff: '{"name":"Fake"}',
    base_currency: 'EUR',
  });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual((await r.json()).ignoredAcceptanceKeys.sort(), [
    'acceptance_data_mode', 'acceptance_signoff',
  ]);

  const status = await (await call('GET', '/acceptance', adminCookie)).json();
  assert.equal(status.status.dataMode, 'real', 'settings POST did not downgrade data mode');
  assert.equal(status.status.poSignoff.name, 'PO Name', 'settings POST did not replace sign-off');

  const settings = await (await call('GET', '/settings', adminCookie)).json();
  assert.ok(!Object.keys(settings).some((k) => k.startsWith('acceptance_')));

  const ai = require('../server/services/ai');
  const tool = ai.runTool('acceptance_evidence', {}).result;
  assert.equal(tool.dataMode, 'real');
  assert.equal(tool.met, 0, 'AI tool agrees: cleared criterion is unproven');
});

test('sign-off can be cleared and is immediately reflected in the AI tool', async () => {
  const r = await call('DELETE', '/acceptance/signoff', adminCookie);
  assert.strictEqual(r.status, 200);
  const status = (await r.json()).status;
  assert.equal(status.poSignoff, null);
  assert.equal(status.met, 0);

  const ai = require('../server/services/ai');
  const tool = ai.runTool('acceptance_evidence', {}).result;
  assert.equal(tool.poSignoff, null);
  assert.equal(tool.verdict, 'not_confirmed');
});
