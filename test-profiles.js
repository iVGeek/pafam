// test-profiles.js
var r1 = /^cod\./i;
var r2 = /^ean\s*code/i;
var r3 = /^price$/i;

var h0 = 'Cod.';
var h1 = 'Ean Code';
var h5 = 'PRICE';

console.log('r1 test h0:', r1.test(h0));
console.log('r2 test h1:', r2.test(h1));
console.log('r3 test h5:', r3.test(h5));