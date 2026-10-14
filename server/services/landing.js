'use strict';

// Executable landed-cost engine (brief sections 1, 7, 8).
//
// Answers business Q1: "Which supplier offers the lowest executable landed cost
// for an exact SKU and quantity delivered to our US destination?"
//
// It combines:
//   - quantity price breaks (tiers) and MOQ/order multiples,
//   - unit vs case vs RRP normalisation,
//   - FX to the base (selling) currency,
//   - an Incoterm-aware landed-cost build-up (freight, insurance, duty,
//     brokerage, handling, other non-recoverable taxes).
//
// Every cost is labelled with its source. A buyer-paid component with no
// explicit input is shown as MISSING (assumed zero) so the result reports
// "incomplete" rather than a false zero-cost (brief section 8).

const { rules: incotermRules } = require('../../src/lib/incoterms');
const pricing = require('./pricing');

const round4 = pricing.round4;

function toNum(v, d = null) {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// Pick the unit acquisition price for a given order quantity from optional
// quantity tiers: [{ min, max, price, basis }]. Falls back to the base price.
function selectTier(tiersJson, quantity, basePrice, baseBasis) {
  let tiers = null;
  if (Array.isArray(tiersJson)) tiers = tiersJson;
  else if (typeof tiersJson === 'string' && tiersJson.trim()) {
    try { tiers = JSON.parse(tiersJson); } catch { tiers = null; }
  }
  if (!Array.isArray(tiers) || !tiers.length) {
    return { price: basePrice, basis: baseBasis, tier: null, applied: false };
  }
  const q = toNum(quantity, 0);
  const sorted = tiers
    .map((t) => ({ min: toNum(t.min, 0), max: toNum(t.max, null), price: toNum(t.price, null), basis: t.basis }))
    .filter((t) => t.price != null)
    .sort((a, b) => a.min - b.min);
  let chosen = null;
  for (const t of sorted) {
    if (q >= t.min && (t.max == null || q <= t.max)) { chosen = t; break; }
  }
  if (!chosen && sorted.length && q > sorted[sorted.length - 1].max) chosen = sorted[sorted.length - 1];
  if (!chosen) return { price: basePrice, basis: baseBasis, tier: null, applied: false };
  return { price: chosen.price, basis: chosen.basis || baseBasis, tier: chosen, applied: true };
}

// Resolve one cost input: prefer an explicit supplier value, then a non-zero
// setting, else it is missing (assumed 0). Never silently invent a value.
function resolveInput(explicit, settingVal) {
  const e = toNum(explicit, null);
  if (e != null) return { value: e, source: 'supplier', provided: true };
  const s = toNum(settingVal, null);
  if (s != null && s !== 0) return { value: s, source: 'setting', provided: true };
  return { value: 0, source: 'missing', provided: false };
}

function includesDestination(permitted, destination) {
  if (!permitted || !destination) return true; // unknown = not restricted
  const p = String(permitted).toUpperCase();
  const d = String(destination).toUpperCase();
  if (p === 'ALL' || p === '*') return true;
  return p.split(/[,\s;/|]+/).includes(d);
}

// Core computation for a single offer at a given quantity.
function computeLanded(offer, supplier, opts) {
  const quantity = toNum(opts.quantity, 1) || 1;
  const destination = (opts.destination || 'US').toUpperCase();
  const baseCurrency = opts.baseCurrency || 'USD';
  const s = opts.settings || {};
  const sup = supplier || {};

  const unitsPerCase = toNum(offer.units_per_case, 0) > 0 ? Number(offer.units_per_case) : 1;
  const discountPct = toNum(sup.default_discount_pct, toNum(offer.default_discount_pct, 0)) || 0;
  const basePrice = toNum(offer.price, null);
  const tierSel = selectTier(offer.tiers_json, quantity, basePrice, offer.price_basis || 'unit');

  const flags = [];
  const missing = [];

  let acquisition = null;   // per bottle, source currency
  let acquisitionNotes = [];
  if (tierSel.price != null) {
    let p = toNum(tierSel.price, null);
    if (offer.price_type === 'rrp') {
      if (discountPct > 0) { p = p * (1 - discountPct / 100); acquisitionNotes.push(`RRP − ${discountPct}%`); }
      else flags.push('retail-price');
    }
    const basis = tierSel.basis || offer.price_basis || 'unit';
    if (basis === 'case') { p = p / unitsPerCase; acquisitionNotes.push(`per case of ${unitsPerCase}`); }
    acquisition = p;
  }
  if (tierSel.applied) flags.push('tier-applied');

  const fxRate = toNum(opts.fxRate, 1) || 1;
  const purchaseUSD = acquisition == null ? null : round4(acquisition * fxRate);

  const inc = incotermRules(offer.incoterm || sup.incoterm);
  const buyerPaidFreight = inc.freight === 'buyer';
  const buyerPaidInsurance = inc.insurance === 'buyer';
  const buyerPaidDuty = inc.duty === 'buyer';

  const components = {};
  let added = 0;

  function addComponent(name, value, source, provided) {
    components[name] = { value: round4(value), source, provided: provided !== false };
    added += value;
    if (provided === false) missing.push(name);
  }

  if (purchaseUSD == null) {
    return {
      offerId: offer.id, supplier: offer.supplier_code, currency: offer.currency,
      quantity, destination, baseCurrency, unitsPerCase,
      price: basePrice, priceBasis: offer.price_basis, priceType: offer.price_type,
      acquisitionPerBottle: null, fxRate, purchaseUSD: null,
      incoterm: inc.code, incotermKnown: inc.known, components: {},
      landedUnitCost: null, totalCost: null, complete: false,
      missing: ['price'], flags: [...flags, 'no-price'], executable: false,
    };
  }

  // Components already inside the price (seller-paid) — not added again.
  if (!buyerPaidFreight) components.freight = { value: 0, source: 'included', provided: true };
  else { const r = resolveInput(sup.freight_per_unit, s.default_freight_per_unit); addComponent('freight', r.value, r.source, r.provided); }

  if (!buyerPaidInsurance) components.insurance = { value: 0, source: 'included', provided: true };
  else { const r = resolveInput(sup.insurance_pct, s.default_insurance_pct); addComponent('insurance', purchaseUSD * r.value / 100, r.source, r.provided); }

  if (!buyerPaidDuty) components.duty = { value: 0, source: 'included', provided: true };
  else { const r = resolveInput(sup.duty_pct, s.default_duty_pct); addComponent('duty', purchaseUSD * r.value / 100, r.source, r.provided); }

  // Destination charges — always buyer-paid.
  { const r = resolveInput(sup.brokerage_per_unit, s.default_brokerage); addComponent('brokerage', r.value, r.source, r.provided); }
  { const r = resolveInput(sup.handling_per_unit, s.default_handling_per_unit); addComponent('handling', r.value, r.source, r.provided); }
  { const r = resolveInput(sup.other_tax_pct, s.default_other_tax_pct); addComponent('otherTaxes', purchaseUSD * r.value / 100, r.source, r.provided); }

  const landedUnitCost = round4(purchaseUSD + added);
  const totalCost = round4(landedUnitCost * quantity);

  // Executability vs the order.
  const moq = toNum(offer.moq, null);
  const orderMultiple = toNum(offer.order_multiple, null);
  const moqOk = moq == null || quantity >= moq;
  const multipleOk = orderMultiple == null || orderMultiple <= 0 || Math.abs(quantity % orderMultiple) < 1e-9;
  const available = toNum(offer.available_quantity, null);
  const unit = (offer.quantity_unit || '').toLowerCase();
  const unitComparable = !unit || ['unit', 'units', 'bottle', 'bottles', 'pcs'].includes(unit);
  let availableOk = null;
  if (available != null) {
    if (unitComparable) availableOk = quantity <= available;
    else flags.push('availability-unit-unknown');
  }
  const today = new Date().toISOString().slice(0, 10);
  const notExpired = !offer.valid_until || String(offer.valid_until).slice(0, 10) >= today;
  const eligible = includesDestination(offer.permitted_destination, destination);

  if (!moqOk) flags.push('below-moq');
  if (!multipleOk) flags.push('not-order-multiple');
  if (availableOk === false) flags.push('insufficient-stock');
  if (!notExpired) flags.push('expired');
  if (!eligible) flags.push('not-eligible');
  if (inc.known === false) flags.push('incoterm-unknown');
  if (missing.length) flags.push('incomplete-cost');

  const isRetail = flags.includes('retail-price');
  const executable = !isRetail && moqOk && multipleOk && availableOk !== false && notExpired && eligible;

  return {
    offerId: offer.id,
    supplier: offer.supplier_code,
    supplierName: offer.supplier_name || sup.name || offer.supplier_code,
    description: offer.description || null,
    currency: offer.currency,
    baseCurrency,
    quantity,
    destination,
    unitsPerCase,
    price: basePrice,
    priceBasis: offer.price_basis,
    priceType: offer.price_type,
    tierApplied: tierSel.applied ? tierSel.tier : null,
    acquisitionPerBottle: acquisition == null ? null : round4(acquisition),
    acquisitionNotes: acquisitionNotes.join(', '),
    fxRate,
    purchaseUSD,
    incoterm: inc.code,
    incotermLabel: inc.label,
    incotermKnown: inc.known,
    components,
    landedUnitCost,
    totalCost,
    complete: missing.length === 0,
    missing,
    moq, orderMultiple, moqOk, multipleOk,
    availableQuantity: available, availableOk,
    validUntil: offer.valid_until || null, notExpired,
    eligible,
    executable,
    flags,
  };
}

module.exports = { computeLanded, selectTier, includesDestination };
