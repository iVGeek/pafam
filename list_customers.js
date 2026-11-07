'use strict';
const { db } = require('./server/db');
console.log('--- Customers table ---');
const cust = db.prepare('SELECT * FROM customers').all();
console.log(JSON.stringify(cust, null, 2));
db.close();