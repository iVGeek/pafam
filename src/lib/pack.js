'use strict';

// Parse a pack/case size out of a free-text product description.
// Handles: "4*6", "6 PACK", "12 Uds", "24 Botellas", "4x6", "(24)", etc.
// Returns an integer number of units, or null if none is confidently found.

function parsePackSize(description) {
  if (!description) return null;
  const text = String(description).toUpperCase();

  // "4*6" or "4x6" or "4 x 6"
  const mult = text.match(/(\d{1,3})\s*[*×xX]\s*(\d{1,3})(?!\d)/);
  if (mult) {
    const a = Number(mult[1]);
    const b = Number(mult[2]);
    if (a >= 2 && b >= 2 && a <= 100 && b <= 100) return a * b;
  }

  // "6 PACK", "12 UDS", "24 BOTELLAS", "10 LATAS", "6 UNIDADES"
  const kw = text.match(/(\d{1,3})\s*(PACK|PKS|UDS?|UNID(?:ADES)?|BOT(?:ELLAS?)?|LATAS?|CAJAS?|MINIS?)/);
  if (kw) {
    const n = Number(kw[1]);
    if (n >= 2 && n <= 200) return n;
  }

  // trailing "(24)" or "x24"
  const paren = text.match(/[(\[]\s*(\d{1,3})\s*[)\]]\s*$/);
  if (paren) {
    const n = Number(paren[1]);
    if (n >= 2 && n <= 200) return n;
  }

  return null;
}

module.exports = { parsePackSize };
