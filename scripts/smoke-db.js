'use strict';
const { db, DB_PATH } = require('../server/db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
console.log('DB:', DB_PATH);
console.log('tables:', tables.join(', '));
console.log('settings:', JSON.stringify(db.prepare('SELECT key, value FROM settings ORDER BY key').all()));
