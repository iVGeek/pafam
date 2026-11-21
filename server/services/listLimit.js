'use strict';

// List endpoints accept a caller-supplied limit. Never let a single request
// materialise the whole table (and, for orders, one query per row).
function clampLimit(value, fallback = 200, max = 500) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
}

module.exports = { clampLimit };
