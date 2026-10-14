'use strict';

const { db, getSetting } = require('../db');
const pricing = require('./pricing');
const fx = require('./fx');
const { computeLanded } = require('./landing');
const { landedSettings } = require('./sourcing');

// Build a full deal from a supplier offer (buy side) and a customer (sell side):
// landed cost + profitability/metrics + dated cash flow + capital employed.
// Any part can be overridden explicitly (e.g. manual landed cost, terms days).

function getOffer(offerId) {
  return db.prepare(
    `SELECT o.*, s.name AS supplier_name, s.default_discount_pct AS supplier_discount,
            s.incoterm AS supplier_incoterm, s.payment_terms AS supplier_payment_terms,
            s.duty_pct, s.freight_per_unit, s.insurance_pct, s.brokerage_per_unit,
            s.handling_per_unit, s.other_tax_pct
       FROM offers o JOIN suppliers s ON s.code = o.supplier_code
      WHERE o.id = ?`
  ).get(Number(offerId));
}

function supplierFromRow(r) {
  return {
    name: r.supplier_name,
    default_discount_pct: r.supplier_discount,
    incoterm: r.supplier_incoterm,
    payment_terms: r.supplier_payment_terms,
    duty_pct: r.duty_pct,
    freight_per_unit: r.freight_per_unit,
    insurance_pct: r.insurance_pct,
    brokerage_per_unit: r.brokerage_per_unit,
    handling_per_unit: r.handling_per_unit,
    other_tax_pct: r.other_tax_pct,
  };
}

function buildDeal(input) {
  const settings = landedSettings();
  const base = input.baseCurrency || settings.base_currency;
  const dest = (input.destination || settings.dest_market || 'US').toUpperCase();
  const quantity = Number(input.quantity) > 0 ? Number(input.quantity) : 1;

  const offer = input.offerId ? getOffer(input.offerId) : null;
  if (input.offerId && !offer) return { found: false, error: 'offer not found' };

  // ---- Buy side: landed unit cost ----
  let landedUnitCost;
  let landed = null;
  let supplierSummary = null;
  if (offer) {
    const rate = fx.getRate(offer.currency, base) || 1;
    landed = computeLanded(offer, supplierFromRow(offer), {
      quantity, destination: dest, baseCurrency: base, settings, fxRate: rate,
    });
    landedUnitCost = landed.landedUnitCost;
    supplierSummary = { code: offer.supplier_code, name: offer.supplier_name, incoterm: landed.incoterm };
  } else {
    landedUnitCost = Number(input.landedUnitCost);
  }
  if (!Number.isFinite(landedUnitCost)) {
    return { found: false, error: 'no landed cost — provide offerId or landedUnitCost' };
  }

  // ---- Sell side: price to customer ----
  const rrp = input.rrp != null ? Number(input.rrp) : (offer ? offer.rrp : null);
  const sellingUnitPrice = input.sellingUnitPrice != null ? Number(input.sellingUnitPrice)
    : (rrp != null ? rrp : (offer ? offer.rrp || offer.price : null));

  // ---- Terms ----
  const supplierTermsText = offer ? offer.supplier_payment_terms : null;
  const supplierPayDays = input.supplierPayDays != null
    ? Number(input.supplierPayDays)
    : pricing.parseTermsDays(supplierTermsText, Number(getSetting('default_supplier_payment_days', '0')));

  let customer = null;
  if (input.customerId) customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(input.customerId));
  const customerPayDays = input.customerPayDays != null
    ? Number(input.customerPayDays)
    : pricing.parseTermsDays(customer && customer.payment_terms, Number(getSetting('default_customer_payment_days', '30')));

  const leadTimeDays = input.leadTimeDays != null ? Number(input.leadTimeDays)
    : (offer && offer.lead_time_days != null ? Number(offer.lead_time_days) : 0);
  const transitDays = input.transitDays != null ? Number(input.transitDays) : Number(getSetting('default_transit_days', '0'));

  const deal = pricing.computeDeal({
    quantity,
    landedUnitCost,
    sellingUnitPrice,
    discountPct: input.discountPct,
    rebatePct: input.rebatePct,
    returnsAllowancePct: input.returnsAllowancePct,
    customerDeductionPct: input.customerDeductionPct,
    paymentTermsCostPct: input.paymentTermsCostPct,
    outboundPerUnit: input.outboundPerUnit,
    storagePerUnit: input.storagePerUnit,
    financingPerUnit: input.financingPerUnit,
    commissionPct: input.commissionPct,
    transactionFeePct: input.transactionFeePct,
    expectedCreditLossPct: input.expectedCreditLossPct,
    daysToCash: customerPayDays,
    minMarginPct: Number(getSetting('min_margin_pct', '15')),
    minMarkup: Number(getSetting('min_markup', '0.75')),
    supplierPayDays,
    customerPayDays,
    leadTimeDays,
    transitDays,
    orderDate: input.orderDate,
  });

  const discountOffRrpPct = rrp != null ? pricing.discountOffRrpPct(sellingUnitPrice, rrp) : null;

  return {
    found: true,
    baseCurrency: base,
    destination: dest,
    quantity,
    offer: offer ? {
      id: offer.id, productId: offer.product_id, supplier: offer.supplier_code, description: offer.description,
      currency: offer.currency, price: offer.price, priceBasis: offer.price_basis,
      priceType: offer.price_type, rrp: offer.rrp,
    } : null,
    supplier: supplierSummary,
    customer: customer ? { id: customer.id, name: customer.name, region: customer.region, payment_terms: customer.payment_terms } : null,
    landed,
    selling: {
      rrp, sellingUnitPrice: pricing.round4(sellingUnitPrice), discountOffRrpPct,
      currency: base,
    },
    deal,
    terms: { supplierPayDays, customerPayDays, leadTimeDays, transitDays, supplierTermsText },
  };
}

module.exports = { buildDeal, getOffer };
