'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'ptp.db'), { readOnly: true });
console.log(db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai_%'").all());
