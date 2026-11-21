'use strict';

// Small in-memory sliding-window limiter. Used to cap AI calls per user so a
// single session cannot run up the provider bill. Keys are pruned periodically
// (and hard-capped) so the map cannot grow without bound.
function createLimiter({ max, windowMs, maxKeys = 5000, sweepMs = 60_000 } = {}) {
  const hits = new Map();
  let lastSweep = 0;

  function prune(now) {
    if (now - lastSweep < sweepMs && hits.size <= maxKeys) return;
    lastSweep = now;
    for (const [key, arr] of hits) {
      const fresh = arr.filter((t) => now - t < windowMs);
      if (!fresh.length) hits.delete(key); else hits.set(key, fresh);
    }
    while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
  }

  return {
    // Atomically test and record one use. Returns false when over the limit.
    consume(key, now = Date.now()) {
      prune(now);
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (arr.length >= max) {
        hits.set(key, arr);
        return false;
      }
      arr.push(now);
      hits.set(key, arr);
      while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
      return true;
    },
    reset(key) { hits.delete(key); },
    size() { return hits.size; },
  };
}

module.exports = { createLimiter };
