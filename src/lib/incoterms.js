'use strict';

// Incoterm inclusion rules (brief section 7/8): which inbound cost components
// the SELLER has already paid for in the quoted price, versus which the BUYER
// pays on top. This prevents double counting (a cost already in the price must
// not be added again) and drives an executable landed cost per destination.
//
// We model three buyer-paid components: main freight, cargo insurance and
// import duty. Brokerage/handling/other taxes are always buyer-paid at
// destination (destination charges), regardless of term.
//
// References: Incoterms 2020 risk/cost transfer points. This is a commercial
// simplification, not legal advice.

const INCOTERMS = {
  EXW: { freight: 'buyer', insurance: 'buyer', duty: 'buyer', label: 'Ex Works' },
  FCA: { freight: 'buyer', insurance: 'buyer', duty: 'buyer', label: 'Free Carrier' },
  FAS: { freight: 'buyer', insurance: 'buyer', duty: 'buyer', label: 'Free Alongside Ship' },
  FOB: { freight: 'buyer', insurance: 'buyer', duty: 'buyer', label: 'Free On Board' },
  CFR: { freight: 'seller', insurance: 'buyer', duty: 'buyer', label: 'Cost and Freight' },
  CPT: { freight: 'seller', insurance: 'buyer', duty: 'buyer', label: 'Carriage Paid To' },
  CIF: { freight: 'seller', insurance: 'seller', duty: 'buyer', label: 'Cost, Insurance and Freight' },
  CIP: { freight: 'seller', insurance: 'seller', duty: 'buyer', label: 'Carriage and Insurance Paid To' },
  DAP: { freight: 'seller', insurance: 'seller', duty: 'buyer', label: 'Delivered at Place' },
  DPU: { freight: 'seller', insurance: 'seller', duty: 'buyer', label: 'Delivered at Place Unloaded' },
  DAT: { freight: 'seller', insurance: 'seller', duty: 'buyer', label: 'Delivered at Terminal' },
  DDP: { freight: 'seller', insurance: 'seller', duty: 'seller', label: 'Delivered Duty Paid' },
};

const UNKNOWN = { freight: 'buyer', insurance: 'buyer', duty: 'buyer', label: 'Unknown' };

function normalize(term) {
  return term ? String(term).trim().toUpperCase().replace(/[^A-Z]/g, '') : '';
}

// Returns { freight, insurance, duty, label, known } where each value is
// 'seller' (already in the price) or 'buyer' (added on top).
function rules(term) {
  const key = normalize(term);
  if (INCOTERMS[key]) return { ...INCOTERMS[key], code: key, known: true };
  return { ...UNKNOWN, code: key || null, known: false };
}

// Which components are buyer-paid for a term (need explicit inputs to be executable).
function buyerPaid(term) {
  const r = rules(term);
  return ['freight', 'insurance', 'duty'].filter((c) => r[c] === 'buyer');
}

module.exports = { INCOTERMS, rules, buyerPaid, normalize };
