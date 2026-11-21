'use strict';
// Bootstrap/admin credential hardening: no source-code-known default password,
// password changes revoke live sessions, and a generated bootstrap password
// locks the rest of the API until it is changed.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP_DB = path.join(os.tmpdir(), `ptp-auth-test-${process.pid}.db`);
process.env.PTP_DATA_DIR = path.dirname(TMP_DB);
process.env.PTP_DB = TMP_DB;
delete process.env.PTP_ADMIN_PASS;
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch (_) { /* ignore */ }
  }
});

const db = require('../server/db').db;
const auth = require('../server/services/auth');

// Empty DB: the acceptance runbook's PTP_AUTO_SEED=false path.
function cleanUserTables() {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
}

test('bootstrap admin never falls back to a known password', () => {
  cleanUserTables();
  const boot = auth.ensureBootstrapAdmin();
  assert.strictEqual(boot.created, true);
  assert.notStrictEqual(boot.password, 'admin123', 'no source-code-known default');
  assert.ok(boot.password.length >= 32, 'generated secret is long enough');
  assert.strictEqual(boot.generated, true, 'a generated password forces a change');

  const stored = db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(boot.id);
  assert.strictEqual(stored.must_change_password, 1);
  assert.ok(auth.authenticate(boot.username, boot.password), 'generated password authenticates');

  // A second call is a no-op — the password is not rotated on restart.
  const again = auth.ensureBootstrapAdmin();
  assert.strictEqual(again.created, false);
  assert.ok(auth.authenticate(boot.username, boot.password));
});

test('PTP_ADMIN_PASS is honoured and does not force a change', () => {
  cleanUserTables();
  process.env.PTP_ADMIN_PASS = 'operator-chosen-pass';
  try {
    const boot = auth.ensureBootstrapAdmin();
    assert.strictEqual(boot.password, 'operator-chosen-pass');
    assert.strictEqual(boot.generated, false);
    const stored = db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(boot.id);
    assert.strictEqual(stored.must_change_password, 0);
  } finally {
    delete process.env.PTP_ADMIN_PASS;
  }
});

test('changing a password revokes existing sessions and clears the flag', () => {
  cleanUserTables();
  const id = auth.createUser({ username: 'rotate_me', password: 'old-pass-123', role: 'admin', mustChangePassword: true });
  const session = auth.createSession(id);
  assert.ok(auth.userFromToken(session.token), 'token works before the change');

  auth.setPassword(id, 'new-pass-456');
  assert.strictEqual(auth.userFromToken(session.token), null, 'old token is dead immediately');
  assert.ok(!auth.authenticate('rotate_me', 'old-pass-123'), 'old password no longer works');
  assert.ok(auth.authenticate('rotate_me', 'new-pass-456'), 'new password works');
  const stored = db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(id);
  assert.strictEqual(stored.must_change_password, 0);
});
