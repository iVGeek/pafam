'use strict';
// One-off: split public/app.js (3361 lines) into:
///   ui-helpers.js  (~510 lines: helpers, icons, state, export, picker)
///   ui-routes.js   (~2200 lines: all 27 route renderers)
///   app.js         (~750 lines: router, login, AI chat, boot)
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const lines = src.split('\n');

// 1-based boundaries (inclusive)
const cut1 = 509;   // end of helpers (product picker)
const cut2 = 2705;  // end of routes (routes.users)

const helpers = lines.slice(0, cut1).join('\n');
const routes = lines.slice(cut1, cut2).join('\n');
const rest = lines.slice(cut2).join('\n');

fs.writeFileSync(path.join(__dirname, '..', 'public', 'ui-helpers.js'), helpers);
fs.writeFileSync(path.join(__dirname, '..', 'public', 'ui-routes.js'), routes);
fs.writeFileSync(path.join(__dirname, '..', 'public', 'app.js'), rest);
console.log('helpers lines: ' + helpers.split('\n').length);
console.log('routes lines: ' + routes.split('\n').length);
console.log('app lines: ' + rest.split('\n').length);
