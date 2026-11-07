'use strict';
const { db } = require('./server/db');
console.log('--- Suppliers ---');
const sup = db.prepare('SELECT code, name, currency FROM suppliers').all();
console.log(JSON.stringify(sup, null, 2));
console.log('--- Customers ---');
const cust = db.prepare('SELECT id, username, display_name, email FROM users WHERE role = ?', ['customer']).all();
console.log(JSON.stringify(cust, null, 2));
db.close();