'use strict';
// Clear the remembered "last good AI model" hint so the configured chain
// order (free model first) is what gets tried next.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'ptp.db'));
db.prepare("UPDATE settings SET value = '' WHERE key = 'ai_model_last_good'").run();
console.log('cleared');
