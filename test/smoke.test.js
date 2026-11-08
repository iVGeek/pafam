'use strict';
// Frontend smoke test: the UI files must load and contain the critical
// wiring that broke once before (chat launcher, nav icons, fonts, finder).
// Catches "null.innerHTML" class crashes at the level Node can check:
// every id the JS expects must exist in index.html or be created by the JS.
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `ptp-smoke-${process.pid}.db`);
process.env.PTP_DATA_DIR = path.dirname(TMP_DB);
process.env.PTP_DB = TMP_DB;
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch (e) { /* ignore */ }
  }
});

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('index.html: shell, nav, gated demo creds, fonts preloaded', () => {
  const html = pub('index.html');
  for (const id of ['nav', 'view', 'globalSearch', 'chatLauncher', 'toasts', 'demoCreds']) {
    // chatLauncher is created by JS, the rest must be in the shell
    if (id === 'chatLauncher') continue;
    assert.ok(html.includes(`id="${id}"`), 'missing #' + id);
  }
  assert.ok(!html.includes('chatLauncher'), 'launcher must be JS-created, not static');
  // Demo creds must be hidden by default (JS reveals on localhost only)
  assert.match(html, /class="[^"]*hidden[^"]*"[^>]*id="demoCreds"|id="demoCreds"[^>]*hidden/);
  assert.match(html, /href="\/styles\.css"/);
});

test('app.js: chat wiring, icons, finder, stepper all present', () => {
  const js = ['ui-helpers.js', 'ui-routes.js', 'app.js'].map(pub).join('\n');
  for (const needle of [
    'chatLauncher', 'chatPanel', 'chatBody', 'chatInput', 'chatSend',
    'decorateNav', 'ROUTE_ICONS', 'icon(',
    'globalFind', 'dealStepper', 'installTableSorting',
    'renderChatInto', 'aiBody', 'aiList', 'aiInput', 'deleteChat',
    'copyText', "icon('paperclip'",
  ]) {
    assert.ok(js.includes(needle), 'UI missing: ' + needle);
  }
  // UI split files must each parse as classic scripts in load order.
  for (const f of ['ui-helpers.js', 'ui-routes.js', 'app.js']) {
    const src = pub(f);
    new Function(src); // throws on syntax error
  }
  // The crash we shipped once: attach icon must be written AFTER panel is
  // appended to the document. Guard the ordering statically.
  const app = pub('app.js');
  const attachIdx = app.indexOf("$('#chatAttachBtn').innerHTML");
  const appendIdx = app.indexOf('document.body.appendChild(panel)');
  assert.ok(attachIdx > appendIdx, 'attach icon write must come after appendChild(panel)');
  assert.ok(!js.includes("$('#toast')"), 'stale #toast reference (now #toasts)');
});

test('styles.css: fonts, sticky headers, density, stepper', () => {
  const css = pub('styles.css');
  for (const needle of ['@font-face', 'Inter-var', 'Fraunces-var', 'JetBrainsMono-var', 'density-compact', 'position: sticky', 'deal-stepper', '.ds.active']) {
    assert.ok(css.includes(needle), 'styles.css missing: ' + needle);
  }
});

test('fonts: all three variable font files exist and are non-trivial', () => {
  for (const f of ['Inter-var.ttf', 'Fraunces-var.ttf', 'JetBrainsMono-var.ttf']) {
    const p = path.join(__dirname, '..', 'public', 'fonts', f);
    assert.ok(fs.existsSync(p), 'missing font ' + f);
    assert.ok(fs.statSync(p).size > 50000, f + ' suspiciously small');
  }
});

test('http: serves the shell + assets 200', async () => {
  const auth = require('../server/services/auth');
  try { auth.createUser({ username: 'admin', password: 'admin123', role: 'admin' }); } catch (e) { if (e.status !== 409) throw e; }
  const app = require('../server');
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const root = await fetch(base + '/');
    assert.equal(root.status, 200);
    const rootBody = await root.text();
    assert.match(rootBody, /id="demoCreds"/);
    assert.match(rootBody, /class="[^"]*hidden[^"]*"[^>]*id="demoCreds"|id="demoCreds"[^>]*hidden/);
    for (const u of ['/app.js', '/styles.css', '/fonts/Inter-var.ttf']) {
      const res = await fetch(base + u);
      assert.equal(res.status, 200, u);
    }
    // Login as admin works and /ai/status reports the chain
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    const status = await fetch(base + '/api/ai/status', { headers: { cookie } });
    assert.equal(status.status, 200);
    const sj = await status.json();
    assert.equal(sj.enabled, true);
  } finally {
    server.closeAllConnections && server.closeAllConnections();
    await Promise.race([
      new Promise((r) => server.close(r)),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  }
});
