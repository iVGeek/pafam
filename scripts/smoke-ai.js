'use strict';
// Smoke-test the new AI tools against the live local DB. Read-only + drafts
// (drafts never write until applied), so safe to run.
const ai = require('../server/services/ai');
const calls = [
  ['list_quotes', { limit: 3 }],
  ['list_placements', { limit: 3 }],
  ['list_shipments', { limit: 3 }],
  ['list_reservations', { limit: 3 }],
  ['get_kpis', {}],
  ['list_uploads', { limit: 3 }],
  ['list_audit', { limit: 3 }],
  ['list_fx', {}],
  ['list_users', {}],
  ['list_pfi', {}],
  ['get_recommendations', { limit: 3 }],
  ['price_calculate', { purchaseUnitPrice: 10, sellingUnitPrice: 20, quantity: 24, dutyPct: 10 }],
  ['deal_compute', { quantity: 24, landedUnitCost: 11.1, sellingUnitPrice: 20 }],
  ['ai_diagnose', {}],
  ['compare_uploads', { aId: 1, bId: 2 }],
  ['draft_reservation', { lotId: 1, quantity: 6, notes: 'smoke' }],
  ['draft_shipment', { totalCost: 120, driver: 'value', lines: [{ productId: 1, quantity: 10, basisValue: 60 }, { productId: 2, quantity: 5, basisValue: 60 }] }],
  ['draft_exception', { exceptionId: 1 }],
];
for (const [name, args] of calls) {
  try {
    const out = ai.runTool(name, args);
    const r = out.result || {};
    const keys = Object.keys(r).join(',');
    const err = r.error ? ' ERR:' + r.error : '';
    const prop = out.proposal ? ' proposal:' + out.proposal.type + '->' + out.proposal.apply.url : '';
    console.log(name.padEnd(22) + ' keys=[' + keys.slice(0, 80) + ']' + err + prop);
  } catch (e) {
    console.log(name.padEnd(22) + ' THREW:' + e.message);
  }
}
console.log('TOOLS total: ' + ai.tools.length);
