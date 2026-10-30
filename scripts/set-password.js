'use strict';
// Set a user's password directly in the SQLite database.
//
//   node scripts/set-password.js admin 'new-strong-password'
//   PTP_DATA_DIR=/var/data node scripts/set-password.js admin 'secret'
//   docker exec perfumes node --no-warnings scripts/set-password.js admin 'secret'
//
// The action is written to the audit log, exactly like a password change made
// through the UI. Prefer the UI (Account > Change password) for daily use; this
// script exists for bootstrap and recovery when nobody can sign in.

require('../server/env').load();

const auth = require('../server/services/auth');
const { db } = require('../server/db');

function usage() {
  console.error("usage: node scripts/set-password.js <username> <password>");
  process.exit(2);
}

const username = process.argv[2];
const password = process.argv[3];

if (!username || !password) usage();
if (password.length < 8) {
  console.error('refusing: password must be at least 8 characters');
  process.exit(2);
}

const user = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`user not found: ${username}`);
  console.error('existing users: ' + db.prepare('SELECT username FROM users ORDER BY id').all().map((u) => u.username).join(', '));
  process.exit(1);
}

auth.setPassword(user.id, password);
console.log(`password updated for ${user.username} (${user.role})`);
db.close();
