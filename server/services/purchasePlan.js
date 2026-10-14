'use strict';

const { db, getSetting } = require('../db');
const recommend = require('./recommend');
const { landedSettings } = require('./sourcing');

function consolidateDemands(opts = {}) {
  const approvedOnly = opts.approvedOnly === true || opts.approvedOnly === '1';
  const where = [
    "d.status IN ('open','wishlist','quoted')",
    'd.product_id IS NOT NULL',
  ];
  if (approvedOnly) where.push('d.approved = 1');
  const sql = `
    SELECT DISTINCT d.product_id
      FROM demands d
     WHERE ${where.join(' AND ')}
  `;
  const pids = db.prepare(sql).all().map((r) => r.product_id);
  if (!pids.length) return { items: [], totals: { count: 0, actionable: 0, capital: 0, contribution: 0 } };

  const items = [];
  const settings = landedSettings();
  const capitalLimit = Number(getSetting('capital_limit', '250000'));
  let capitalTotal = 0;
  let contribTotal = 0;
  let actionable = 0;

  for (const pid of pids) {
    const rec = recommend.recommendationFor(pid, opts);
    if (!rec) continue;
    const demandQty = rec.demandQuantity;
    const orderQty = rec.orderQuantity;
    const moq = rec.supplier && rec.supplier.offerId ? (() => {
      const o = require('./deal').getOffer(rec.supplier.offerId);
      return o ? (Number(o.moq) || null) : null;
    })() : null;
    const multiple = rec.supplier && rec.supplier.offerId ? (() => {
      const o = require('./deal').getOffer(rec.supplier.offerId);
      return o ? (Number(o.order_multiple) || null) : null;
    })() : null;

    const item = {
      productId: pid,
      product: rec.product,
      customers: rec.customers,
      demandQty,
      orderQty,
      supplier: rec.supplier,
      executable: rec.executable,
      landedUnit: rec.landedUnitCost,
      sellUnit: rec.suggestedSell,
      marginPct: rec.marginPct,
      contribution: rec.contribution,
      cashRequirement: rec.cashRequirement,
      expectedCollection: rec.expectedCollection,
      meetsPolicy: rec.meetsPolicy,
      withinCapitalLimit: rec.withinCapitalLimit,
      capitalLimit,
      missing: rec.missing,
      warnings: rec.warnings,
      reasons: rec.reasons,
      candidates: rec.candidates.slice(0, 2),
      moq,
      multiple,
      shortfallMoq: moq && demandQty < moq ? (moq - demandQty) : 0,
      buyConv: moq || multiple ? (orderQty / Math.max(1, demandQty)) : 1,
      baseCurrency: rec.baseCurrency || settings.base_currency,
    };
    items.push(item);
    if (rec.cashRequirement != null) capitalTotal += rec.cashRequirement;
    if (rec.contribution != null) contribTotal += rec.contribution;
    if (item.executable && item.meetsPolicy === true && item.withinCapitalLimit === true && (!item.missing || item.missing.length === 0)) actionable++;
  }

  items.sort((a, b) => (b.contribution || 0) - (a.contribution || 0));

  return {
    items,
    totals: {
      count: items.length,
      actionable,
      capital: Math.round(capitalTotal * 100) / 100,
      contribution: Math.round(contribTotal * 100) / 100,
      capitalLimit,
      overLimit: capitalLimit > 0 ? capitalTotal > capitalLimit : false,
    },
  };
}

module.exports = { consolidateDemands };
