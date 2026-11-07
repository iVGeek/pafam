'use strict';
const { db } = require('./server/db');
console.log('--- All users ---');
const all = db.prepare('SELECT id, username, display_name, email, role FROM users ORDER BY id').all();
console.log(JSON.stringify(all, null, 2));
console.log('--- Tables ---');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log(JSON.stringify(tables, null, 2));
db.close();