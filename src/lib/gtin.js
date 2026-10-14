'use strict';

// GTIN (barcode) utilities per GS1 rules.
// Supports EAN-8, UPC-A (12), EAN-13, GTIN-14. Preserves the source value and
// derives a canonical (zero-padded to 14) representation for matching.

function digitsOnly(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[^0-9]/g, '');
}

function checkDigit(digitsWithoutCheck) {
  // GS1 mod-10: rightmost data digit carries weight 3, alternating.
  let sum = 0;
  const rev = digitsWithoutCheck.split('').reverse();
  for (let i = 0; i < rev.length; i++) {
    const d = Number(rev[i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

function isValid(digits) {
  if (!/^[0-9]+$/.test(digits)) return false;
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  const body = digits.slice(0, -1);
  const given = Number(digits.slice(-1));
  return checkDigit(body) === given;
}

function typeOf(digits) {
  switch (digits.length) {
    case 8: return 'EAN-8';
    case 12: return 'UPC-A';
    case 13: return 'EAN-13';
    case 14: return 'GTIN-14';
    default: return 'UNKNOWN';
  }
}

function canonical(digits) {
  if (!isValid(digits)) return null;
  return digits.padStart(14, '0');
}

// Public: analyse a raw barcode value.
function analyse(raw) {
  const source = raw === null || raw === undefined ? '' : String(raw).trim();
  const digits = digitsOnly(source);
  const valid = isValid(digits);
  return {
    source,
    digits,
    length: digits.length,
    valid,
    type: typeOf(digits),
    canonical14: valid ? canonical(digits) : null,
    // matching key: canonical when valid, else the raw digit string (flagged uncertain)
    matchKey: valid ? canonical(digits) : (digits ? 'raw:' + digits : ''),
  };
}

// Key used to test whether two offers refer to the same book/product unit.
function matchKeyFor(raw) {
  return analyse(raw).matchKey;
}

module.exports = { digitsOnly, checkDigit, isValid, typeOf, canonical, analyse, matchKeyFor };
