'use strict';

// The assistant. Talks to any OpenAI-compatible /chat/completions endpoint
// (OpenAI, Azure, Groq, OpenRouter, vLLM, Ollama, ...) configured entirely by
// environment variables. It never writes to the database: it reads through
// tools and *proposes* drafts that the UI applies under the signed-in user's
// own role. Numbers always come from the services below, never from the model.

const { db, getSetting } = require('../db');
const pricing = require('./pricing');
const { compareProduct } = require('./comparison');
const { sourceLowest } = require('./sourcing');
const analytics = require('./analytics');
const alerts = require('./alerts');
const orders = require('./orders');
const tasks = require('./tasks');
const purchasePlan = require('./purchasePlan');
const trends = require('./trends');
const forecast = require('./forecast');
const quoteCompare = require('./quoteCompare');
const { SYSTEM_PROMPT } = require('./aiKnowledge');

const MAX_STEPS_DEFAULT = 12;

/* ------------------------------ configuration ------------------------------ */

const DEFAULT_MODEL = 'gpt-4o-mini';

function baseUrl() { return (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''); }

// Free model catalogues churn: providers retire a model, turn it paid, or
// rate-limit it without notice. AI_MODELS holds an ordered fallback chain
// (comma separated); AI_MODEL is still honoured as the single-model form.
function models() {
  const raw = process.env.AI_MODELS || process.env.AI_MODEL || '';
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? Array.from(new Set(list)) : [DEFAULT_MODEL];
}
function model() { return models()[0]; }
function apiKey() { return process.env.AI_API_KEY || ''; }
function enabled() {
  return process.env.PTP_AI_MOCK === '1' || Boolean(process.env.AI_API_KEY) || Boolean(process.env.AI_BASE_URL);
}
function headers() {
  return Object.assign({ 'content-type': 'application/json' }, apiKey() ? { authorization: 'Bearer ' + apiKey() } : {});
}

function status() {
  return {
    enabled: enabled(),
    model: discoveredModel || model(),
    models: models(),
    discoveredModel,
    provider: baseUrl(),
    hasKey: Boolean(apiKey()),
    baseUrlSet: Boolean(process.env.AI_BASE_URL),
  };
}

/* --------------------------------- read tools ------------------------------ */

function toolSearchProducts({ query, limit } = {}) {
  const q = String(query || '').trim();
  const n = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const cols = `SELECT p.id, p.display_name, p.canonical_gtin, p.category, p.size_ml,
       (SELECT COUNT(*) FROM offers o WHERE o.product_id = p.id) AS offer_count,
       (SELECT COUNT(DISTINCT supplier_code) FROM offers o WHERE o.product_id = p.id) AS supplier_count
     FROM products p`;
  const rows = q
    ? db.prepare(`${cols} WHERE p.display_name LIKE ? OR p.canonical_gtin LIKE ? OR p.category LIKE ?
        ORDER BY supplier_count DESC, offer_count DESC, p.id LIMIT ?`).all('%' + q + '%', '%' + q + '%', '%' + q + '%', n)
    : db.prepare(`${cols} ORDER BY p.id DESC LIMIT ?`).all(n);
  return { count: rows.length, products: rows };
}

function toolProductPrices({ productId } = {}) {
  const product = db.prepare('SELECT id, display_name, canonical_gtin, category, size_ml FROM products WHERE id = ?').get(Number(productId));
  if (!product) return { found: false, error: 'product not found (' + productId + ')' };
  const cmp = compareProduct(product.id);
  return {
    found: true,
    product,
    baseCurrency: cmp.baseCurrency,
    best: cmp.best,
    savingsPerBottle: cmp.savingsPerBottle,
    savingsPct: cmp.savingsPct,
    offers: cmp.offers.slice(0, 12).map((o) => ({
      supplier: o.supplierName,
      price: o.price,
      currency: o.currency,
      priceBasis: o.priceBasis,
      priceType: o.priceType,
      perBottleBase: o.perBottleBase,
      unitsPerCase: o.unitsPerCase,
      flags: o.flags,
    })),
  };
}

function mapWinner(w) {
  if (!w) return null;
  return {
    offerId: w.offerId,
    supplierCode: w.supplier,
    supplierName: w.supplierName,
    landedUnitCost: w.landedUnitCost,
    acquisitionPerBottle: w.acquisitionPerBottle,
    currency: w.currency,
    unitsPerCase: w.unitsPerCase,
    incoterm: w.incoterm,
    flags: w.flags,
    missing: w.missing,
  };
}

function toolLowestCost({ productId, gtin, quantity } = {}) {
  const r = sourceLowest({ productId, gtin, quantity });
  if (!r.found) return { found: false, error: 'no product matched that id or barcode' };
  return {
    found: true,
    product: { id: r.product.id, display_name: r.product.display_name, canonical_gtin: r.product.canonical_gtin },
    quantity: r.quantity,
    destination: r.destination,
    baseCurrency: r.baseCurrency,
    winner: mapWinner(r.winner),
    runnerUp: mapWinner(r.runnerUp),
    counts: r.counts,
    savingsVsNext: r.savingsVsNext,
    warnings: r.warnings,
  };
}

function toolListSuppliers() {
  return { suppliers: db.prepare('SELECT code, name, currency, incoterm, default_discount_pct FROM suppliers ORDER BY name').all() };
}

function toolListCustomers() {
  return { customers: db.prepare('SELECT id, code, name, region, currency, payment_terms FROM customers ORDER BY name LIMIT 200').all() };
}

function toolListDemands({ status, limit } = {}) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const select = `SELECT d.id, d.quantity, d.target_price, d.currency, d.status,
       c.name AS customer, p.display_name AS product
     FROM demands d JOIN customers c ON c.id = d.customer_id JOIN products p ON p.id = d.product_id`;
  const rows = status
    ? db.prepare(`${select} WHERE d.status = ? ORDER BY d.id DESC LIMIT ?`).all(String(status), n)
    : db.prepare(`${select} ORDER BY d.id DESC LIMIT ?`).all(n);
  return { demands: rows };
}

function toolGetSettings() {
  const out = {};
  db.prepare('SELECT key, value FROM settings').all().forEach((r) => { out[r.key] = r.value; });
  return { settings: out };
}

/* ------------------------- wider system read tools ------------------------- */

function toolDashboard() {
  const ov = analytics.overview();
  return {
    overview: ov,
    winsByType: analytics.winsByType(),
    alerts: alerts.counts(),
  };
}

function toolListAlerts({ unreadOnly, limit } = {}) {
  const n = Math.min(Math.max(Number(limit) || 25, 1), 200);
  return {
    counts: alerts.counts(),
    alerts: alerts.listAlerts({ unreadOnly: !!unreadOnly, limit: n }),
  };
}

function toolListOrders({ status, limit } = {}) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 300);
  let rows = orders.listOrders(n);
  if (status) rows = rows.filter((o) => String(o.status) === String(status));
  return { count: rows.length, orders: rows };
}

function toolGetOrder({ orderId } = {}) {
  const o = orders.getOrder(Number(orderId));
  return o ? { found: true, order: o } : { found: false, error: 'order not found (' + orderId + ')' };
}

function toolListInventory({ productId, limit } = {}) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 300);
  const where = [];
  const params = [];
  if (productId) { where.push('i.product_id = ?'); params.push(Number(productId)); }
  const sql = `SELECT i.id, i.product_id, p.display_name, p.canonical_gtin, i.on_hand,
         i.reserved, i.in_transit, i.quarantined, i.unit_cost, i.currency,
         i.lot_reference, i.warehouse, i.expiry_date
    FROM inventory_lots i JOIN products p ON p.id = i.product_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.id DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, n);
  const totals = db.prepare(
    `SELECT COALESCE(SUM(i.on_hand), 0) AS onHand,
            COALESCE(SUM(i.reserved), 0) AS reserved,
            COALESCE(SUM(i.in_transit), 0) AS inTransit
       FROM inventory_lots i ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`
  ).get(...params);
  return { lots: rows, totals };
}

function toolListExceptions({ resolved, supplier, limit } = {}) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 300);
  const where = ['e.resolved = ?'];
  const params = [resolved ? 1 : 0];
  if (supplier) { where.push('o.supplier_code = ?'); params.push(String(supplier)); }
  const rows = db.prepare(
    `SELECT e.id, e.type, e.detail, e.resolved, e.created_at, o.supplier_code, o.description, o.gtin_source
       FROM exceptions e LEFT JOIN offers o ON o.id = e.offer_id
      WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC LIMIT ?`
  ).all(...params, n);
  return { count: rows.length, exceptions: rows };
}

function toolListCaptures({ status, limit } = {}) {
  const n = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(String(status)); }
  const rows = db.prepare(
    `SELECT id, source, title, raw_text, captured_at, status, demand_id
       FROM captures ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY captured_at DESC LIMIT ?`
  ).all(...params, n);
  return { count: rows.length, captures: rows.map((r) => ({ ...r, raw_text: (r.raw_text || '').slice(0, 400) })) };
}

function toolListTasks({ status, openOnly, owner, limit } = {}) {
  const n = Math.min(Math.max(Number(limit) || 25, 1), 100);
  return {
    summary: tasks.summary(),
    tasks: tasks.list({ status, openOnly: openOnly !== false, owner, limit: n }),
  };
}

function toolPurchasePlan({ supplierCode, approvedOnly } = {}) {
  const plan = purchasePlan.consolidateDemands({ approvedOnly: !!approvedOnly });
  if (!supplierCode) {
    return {
      suppliers: plan.suppliers,
      totals: plan.totals,
      lineCount: (plan.lines || []).length,
      lines: (plan.lines || []).slice(0, 40),
    };
  }
  const lines = (plan.lines || []).filter((l) => l.supplierCode === supplierCode);
  return { supplierCode, lineCount: lines.length, lines };
}

function toolPriceMovers({ limit } = {}) {
  return { movers: trends.priceMovers(Math.min(Math.max(Number(limit) || 25, 1), 100)) };
}

function toolProductHistory({ productId, limit } = {}) {
  const product = db.prepare('SELECT id, display_name, canonical_gtin FROM products WHERE id = ?').get(Number(productId));
  if (!product) return { found: false, error: 'product not found (' + productId + ')' };
  const series = trends.productSeries(Number(productId));
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return { found: true, product, series: (series || []).slice(0, n) };
}

function toolCompareQuotes({ a, b } = {}) {
  const r = quoteCompare.compareQuotes(Number(a), Number(b));
  if (r.error) return { error: r.error, notFound: !!r.notFound };
  return r;
}

function toolForecast({ productId } = {}) {
  const base = forecast.forecastBaseline({});
  if (!productId) return base;
  const f = base && base.products ? base.products.find((p) => p.productId === Number(productId)) : null;
  return f ? { found: true, forecast: f } : { found: false, error: 'no forecast for that product', baseline: base };
}

// Point the assistant at the export endpoints: every report and document in
// the system downloads as both .xlsx and .pdf behind the session cookie.
function toolExportInfo({ kind } = {}) {
  const kinds = Object.keys(require('./reporting').BUILDERS);
  if (kind) {
    if (!kinds.includes(String(kind))) return { found: false, error: 'unknown report kind', available: kinds };
    return { found: true, kind, xlsx: '/api/export/' + kind + '.xlsx', pdf: '/api/export/' + kind + '.pdf' };
  }
  return {
    reports: kinds.map((k) => ({ kind: k, xlsx: '/api/export/' + k + '.xlsx', pdf: '/api/export/' + k + '.pdf' })),
    documents: [
      { name: 'Customer quote (cost-masked)', xlsx: '/api/export/quote/{id}.xlsx', pdf: '/api/export/quote/{id}.pdf' },
      { name: 'Supplier order placement', xlsx: '/api/export/placement/{id}.xlsx', pdf: '/api/export/placement/{id}.pdf' },
      { name: 'Cleaned supplier import', xlsx: '/api/export/cleaned/{uploadId}.xlsx', pdf: '/api/export/cleaned/{uploadId}.pdf' },
    ],
    anyScreen: { method: 'POST', url: '/api/export/table?format=xlsx|pdf', note: 'renders the table you are looking at' },
  };
}

/* ------------------------------ draft builders ----------------------------- */

// "prepare an offer of X at rate R / target %" -> a QUOTE draft. Cost price and
// both margin conventions are shown side by side, exactly as the Offer Builder
// does, so the two readings are never confused.
function toolDraftOffer({ productId, quantity, costPerBottle, targetPct, basis, customerId, currency } = {}) {
  const product = db.prepare('SELECT id, display_name, canonical_gtin, category, size_ml FROM products WHERE id = ?').get(Number(productId));
  if (!product) return { error: 'product not found (' + productId + ')' };
  const cost = Number(costPerBottle);
  if (!Number.isFinite(cost) || cost <= 0) return { error: 'costPerBottle (supplier cost per bottle) is required' };

  const pct = Number(targetPct);
  const usePct = Number.isFinite(pct) ? pct : (Number(getSetting('default_margin_pct', '30')) || 30);
  const which = basis === 'markup_on_cost' ? 'markupOnCost' : 'marginOnSelling';
  const calc = pricing.priceFromMargin(cost, usePct);
  const chosen = calc[which];
  if (!chosen || !chosen.valid) return { error: (chosen && chosen.reason) || 'cannot price at that margin' };

  const qty = Math.max(1, Math.round(Number(quantity) || 1));
  const cur = currency || getSetting('base_currency', 'USD');
  const customer = customerId ? db.prepare('SELECT id, name, code FROM customers WHERE id = ?').get(Number(customerId)) : null;
  const convention = which === 'markupOnCost' ? 'markup on cost' : 'margin on selling';

  const proposal = {
    type: 'quote',
    title: 'Quote — ' + product.display_name + (customer ? ' for ' + customer.name : ''),
    summary: `${qty} x ${product.display_name} @ ${chosen.sellingUnitPrice} ${cur} (cost ${cost}, ${usePct}% ${convention})`,
    fields: [
      { label: 'Product', value: product.display_name + (product.canonical_gtin ? ' - ' + product.canonical_gtin : '') },
      { label: 'Customer', value: customer ? customer.name : '(choose a customer)' },
      { label: 'Quantity', value: qty },
      { label: 'Cost / bottle', value: `${cost} ${cur}` },
      { label: 'Target', value: `${usePct}% ${convention}` },
      { label: 'Selling price / bottle', value: `${chosen.sellingUnitPrice} ${cur}` },
      { label: 'Margin on selling', value: chosen.marginPctOnSell == null ? '-' : chosen.marginPctOnSell + '%' },
      { label: 'Markup on cost', value: chosen.markupPctOfCost == null ? '-' : chosen.markupPctOfCost + '%' },
    ],
    alternatives: {
      marginOnSelling: calc.marginOnSelling ? calc.marginOnSelling.sellingUnitPrice : null,
      markupOnCost: calc.markupOnCost ? calc.markupOnCost.sellingUnitPrice : null,
    },
    apply: {
      label: 'Create quote',
      method: 'POST',
      url: '/quotes',
      body: {
        customerId: customer ? customer.id : null,
        productId: product.id,
        quantity: qty,
        unitPrice: chosen.sellingUnitPrice,
        currency: cur,
        landedUnitCost: cost,
      },
    },
  };
  if (!customer) proposal.note = 'Pick a customer before saving — a quote needs a customerId.';
  return { proposal };
}

// Free models often resolve one product per tool call, which burns the step
// budget before a multi-variant draft is ready. These helpers let the draft
// tools resolve a name/barcode and the supplier's own offer server-side, so a
// whole placement can be prepared in a single call.
const MATCH_STOP = new Set([
  'the', 'and', 'for', 'with', 'of', 'de', 'du', 'la', 'le',
  'eau', 'edt', 'edp', 'parfum', 'perfume', 'cologne',
  'vaporizador', 'vaporisateur', 'vapor', 'spray', 'natural', 'bottle', 'size',
]);

function productCandidates(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const size = Number((q.match(/(\d{2,4})\s*ml/i) || [])[1]) || null;
  const tokens = q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter((t) => t.length > 1 && !MATCH_STOP.has(t));
  const cols = 'SELECT id, display_name, canonical_gtin, size_ml FROM products';
  let rows;
  if (!tokens.length) {
    rows = db.prepare(cols + ' WHERE lower(display_name) LIKE ? LIMIT 25').all('%' + q.toLowerCase() + '%');
  } else {
    const where = tokens.map(() => '(lower(display_name) LIKE ? OR canonical_gtin LIKE ?)').join(' AND ');
    const params = [];
    for (const t of tokens) params.push('%' + t + '%', '%' + t + '%');
    rows = db.prepare(cols + ' WHERE ' + where + ' LIMIT 25').all(...params);
  }
  if (!rows.length) {
    // Fall back to a looser "most tokens match" search for long supplier names.
    const loose = db.prepare(cols + ' WHERE lower(display_name) LIKE ? LIMIT 25').all('%' + (tokens.slice(-1)[0] || q.toLowerCase()) + '%');
    rows = loose;
  }
  if (size) {
    const exact = rows.filter((r) => Number(r.size_ml) === size || new RegExp('\\b' + size + '\\s*ml\\b', 'i').test(r.display_name));
    if (exact.length) rows = exact;
  }
  return rows;
}

// Cheapest cost-based offer this supplier has on the product (RRP-derived
// offers only win when there is nothing else).
function supplierOffer(productId, supplierCode) {
  const rows = db.prepare(
    `SELECT o.*, s.default_discount_pct FROM offers o JOIN suppliers s ON s.code = o.supplier_code
     WHERE o.product_id = ? AND o.supplier_code = ?`
  ).all(Number(productId), supplierCode);
  const scored = rows.map((o) => {
    const acq = pricing.unitAcquisitionPrice(o);
    return {
      offer: o,
      perBottle: Number.isFinite(acq.perBottle) ? acq.perBottle : null,
      derived: o.price_type === 'rrp',
    };
  }).filter((o) => o.perBottle != null);
  scored.sort((a, b) => (Number(a.derived) - Number(b.derived)) || (a.perBottle - b.perBottle));
  return scored[0] || null;
}

function toolDraftPlacement({ supplierCode, lines } = {}) {
  const code = String(supplierCode || '').trim();
  if (!code) return { error: 'supplierCode is required' };
  const supplier = db.prepare('SELECT code, name, currency FROM suppliers WHERE code = ?').get(code);
  if (!supplier) return { error: 'supplier not found: ' + code };
  const input = Array.isArray(lines) ? lines : [];
  if (!input.length) return { error: 'at least one line is required' };

  const prepared = [];
  for (const l of input) {
    const line = l || {};
    let product = null;
    if (line.productId != null) {
      product = db.prepare('SELECT id, display_name, canonical_gtin, size_ml FROM products WHERE id = ?').get(Number(line.productId)) || null;
      if (!product) return { error: 'product not found on a line: ' + line.productId };
    } else {
      const candidates = productCandidates(line.productQuery || line.query || line.name);
      if (!candidates.length) {
        return { error: 'no product matched "' + (line.productQuery || line.query || line.name || '') + '"' };
      }
      if (candidates.length > 1) {
        return {
          error: 'several products match "' + (line.productQuery || line.query || line.name) + '" — add the size or pass productId',
          candidates: candidates.slice(0, 6),
        };
      }
      product = candidates[0];
    }

    const best = supplierOffer(product.id, supplier.code);
    if (!best && line.unitCost == null) {
      return { error: supplier.name + ' has no usable cost offer on ' + product.display_name + ' (pass unitCost to override)' };
    }
    const upc = Math.max(1, Number((best && best.offer.units_per_case) || line.unitsPerCase) || 1);
    const unitCost = line.unitCost != null && line.unitCost !== ''
      ? Math.round(Number(line.unitCost) * 10000) / 10000
      : (best && best.perBottle != null ? Math.round(best.perBottle * 10000) / 10000 : null);

    // boxes is the supplier's unit; units are rounded up to whole boxes.
    const boxesIn = line.boxes != null && line.boxes !== '' ? Math.max(0, Math.floor(Number(line.boxes))) : null;
    const unitsIn = line.units != null && line.units !== ''
      ? Math.max(0, Number(line.units))
      : (line.quantity != null && line.quantity !== '' ? Math.max(0, Number(line.quantity)) : null);
    const units = boxesIn != null ? boxesIn * upc : (unitsIn != null ? Math.ceil(unitsIn / upc) * upc : upc);
    if (!units) return { error: 'quantity required for ' + product.display_name };

    prepared.push({
      productId: product.id,
      product: product.display_name,
      offerId: best ? best.offer.id : null,
      unitsPerCase: upc,
      boxes: units / upc,
      units,
      unitCost,
      derived: Boolean(best && best.derived),
    });
  }

  const estimated = prepared.reduce((s, l) => s + (l.unitCost != null ? l.unitCost * l.units : 0), 0);
  return {
    proposal: {
      type: 'placement',
      title: 'Supplier order — ' + supplier.name,
      summary: `${prepared.length} line(s), ${prepared.reduce((s, l) => s + l.boxes, 0)} box(es)` +
        (estimated ? ` - about ${Math.round(estimated * 100) / 100} ${supplier.currency}` : ''),
      fields: prepared.map((l) => ({
        label: l.product,
        value: `${l.boxes} box(es) = ${l.units} units` +
          (l.unitCost != null ? ` @ ${Math.round(l.unitCost * 10000) / 10000} ${supplier.currency}` : '') +
          (l.derived ? ' (RRP-derived cost)' : ''),
      })),
      apply: {
        label: 'Create placement',
        method: 'POST',
        url: '/placements',
        body: {
          supplierCode: supplier.code,
          lines: prepared.map((l) => ({ productId: l.productId, offerId: l.offerId, units: l.units, unitCost: l.unitCost })),
        },
      },
    },
  };
}

// "record that X wants N bottles of Y" -> a DEMAND draft (buyer applies it).
function toolDraftDemand({ customerId, productId, quantity, targetPrice, currency, neededBy, notes } = {}) {
  const customer = customerId ? db.prepare('SELECT id, name FROM customers WHERE id = ?').get(Number(customerId)) : null;
  if (!customer) return { error: 'customerId is required (use list_customers to find one)' };
  const product = productId ? db.prepare('SELECT id, display_name, canonical_gtin FROM products WHERE id = ?').get(Number(productId)) : null;
  if (!product) return { error: 'productId is required (use search_products to find one)' };
  const qty = Math.max(1, Math.round(Number(quantity) || 0));
  if (!qty) return { error: 'quantity must be at least 1' };
  const cur = currency || getSetting('base_currency', 'USD');

  return {
    proposal: {
      type: 'demand',
      title: 'Demand — ' + product.display_name + ' for ' + customer.name,
      summary: `${qty} x ${product.display_name}` + (targetPrice ? ` targeting ${targetPrice} ${cur}` : ''),
      fields: [
        { label: 'Customer', value: customer.name },
        { label: 'Product', value: product.display_name + (product.canonical_gtin ? ' - ' + product.canonical_gtin : '') },
        { label: 'Quantity', value: qty },
        { label: 'Target price', value: targetPrice != null ? `${targetPrice} ${cur}` : '(none)' },
        { label: 'Needed by', value: neededBy || '(no date)' },
        { label: 'Notes', value: notes || '(none)' },
      ],
      apply: {
        label: 'Add demand',
        method: 'POST',
        url: '/demands',
        body: { customerId: customer.id, productId: product.id, quantity: qty, targetPrice, currency: cur, neededBy, notes },
      },
    },
  };
}

// A confirmed quote becomes a customer order. Prefer quoteId: the order then
// inherits quantity, prices and dates from the quote, exactly as Orders does.
function toolDraftOrder({ quoteId, customerId, productId, quantity, unitPrice, unitCost, currency, supplierCode, notes } = {}) {
  let q = null;
  if (quoteId) {
    q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(Number(quoteId));
    if (!q) return { error: 'quote not found (' + quoteId + ')' };
  }
  const custId = customerId != null ? Number(customerId) : (q ? q.customer_id : null);
  const prodId = productId != null ? Number(productId) : (q ? q.product_id : null);
  if (!custId || !prodId) return { error: 'quoteId, or customerId + productId, is required' };
  const qty = quantity != null ? Number(quantity) : (q ? q.quantity : null);
  if (!qty) return { error: 'quantity required' };
  const price = unitPrice != null ? Number(unitPrice) : (q ? (q.selling_unit_price != null ? q.selling_unit_price : q.unit_price) : null);
  const cost = unitCost != null ? Number(unitCost) : (q ? q.landed_unit_cost : null);
  const cur = currency || (q && q.currency) || getSetting('base_currency', 'USD');

  const customer = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(Number(custId));
  const product = db.prepare('SELECT id, display_name FROM products WHERE id = ?').get(Number(prodId));

  return {
    proposal: {
      type: 'order',
      title: 'Customer order — ' + (product ? product.display_name : 'product #' + prodId) + (customer ? ' for ' + customer.name : ''),
      summary: `${qty} x ${product ? product.display_name : prodId} @ ${price != null ? price : '-'} ${cur}` + (q ? ` (from quote Q-${String(q.id).padStart(4, '0')})` : ''),
      fields: [
        { label: 'Customer', value: customer ? customer.name : custId },
        { label: 'Product', value: product ? product.display_name : prodId },
        { label: 'Quantity', value: qty },
        { label: 'Selling price', value: price != null ? `${price} ${cur}` : '-' },
        { label: 'Landed cost', value: cost != null ? `${cost} ${cur}` : '-' },
        { label: 'From quote', value: q ? 'Q-' + String(q.id).padStart(4, '0') : '(none)' },
      ],
      apply: {
        label: 'Create order',
        method: 'POST',
        url: '/orders',
        body: {
          quoteId: q ? q.id : undefined,
          customerId: custId,
          productId: prodId,
          quantity: qty,
          unitPrice: price,
          unitCost: cost,
          currency: cur,
          supplierCode: supplierCode || (q && q.supplier_code) || undefined,
          notes,
        },
      },
    },
  };
}

// A follow-up task: the assistant may organise work, never do it.
function toolDraftTask({ title, detail, dueDate, owner, priority, customerId, demandId } = {}) {
  const t = String(title || '').trim();
  if (!t) return { error: 'title is required' };
  return {
    proposal: {
      type: 'task',
      title: 'Follow-up task',
      summary: t,
      fields: [
        { label: 'Title', value: t },
        { label: 'Detail', value: detail || '(none)' },
        { label: 'Due', value: dueDate || '(default)' },
        { label: 'Owner', value: owner || '(unassigned)' },
        { label: 'Priority', value: priority || 'normal' },
      ],
      apply: {
        label: 'Create task',
        method: 'POST',
        url: '/tasks',
        body: { title: t, detail, dueDate, owner, priority, customerId, demandId },
      },
    },
  };
}

/* ------------------------------- tool registry ----------------------------- */

const EXECUTORS = {
  search_products: toolSearchProducts,
  product_prices: toolProductPrices,
  lowest_cost: toolLowestCost,
  list_suppliers: toolListSuppliers,
  list_customers: toolListCustomers,
  list_demands: toolListDemands,
  get_settings: toolGetSettings,
  dashboard_overview: toolDashboard,
  list_alerts: toolListAlerts,
  list_orders: toolListOrders,
  get_order: toolGetOrder,
  list_inventory: toolListInventory,
  list_exceptions: toolListExceptions,
  list_captures: toolListCaptures,
  list_tasks: toolListTasks,
  purchase_plan: toolPurchasePlan,
  price_movers: toolPriceMovers,
  product_history: toolProductHistory,
  compare_quotes: toolCompareQuotes,
  demand_forecast: toolForecast,
  export_info: toolExportInfo,
  draft_offer: toolDraftOffer,
  draft_placement: toolDraftPlacement,
  draft_demand: toolDraftDemand,
  draft_order: toolDraftOrder,
  draft_task: toolDraftTask,
};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_products',
      description: 'Find products by name, barcode (GTIN) or category. Use this first to turn a name into a product id.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'product_prices',
      description: 'Every supplier offer for one product, normalised to a per-bottle price in the base currency and ranked cheapest first.',
      parameters: { type: 'object', properties: { productId: { type: 'integer' } }, required: ['productId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lowest_cost',
      description: 'The cheapest executable landed cost for a product and quantity, with runner-up and warnings.',
      parameters: {
        type: 'object',
        properties: { productId: { type: 'integer' }, gtin: { type: 'string' }, quantity: { type: 'integer' } },
      },
    },
  },
  {
    type: 'function',
    function: { name: 'list_suppliers', description: 'All suppliers with their currency, incoterm and default trade discount.', parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: { name: 'list_customers', description: 'All customers with region, currency and payment terms.', parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: {
      name: 'list_demands',
      description: 'Customer demand rows, optionally filtered by status.',
      parameters: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer' } } },
    },
  },
  {
    type: 'function',
    function: { name: 'get_settings', description: 'System settings (base currency, destination market, policy thresholds, FX).', parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: {
      name: 'draft_offer',
      description: 'Prepare (do not save) a quote/offer from a cost price and target margin. Shows both margin conventions. Returns a proposal a human applies.',
      parameters: {
        type: 'object',
        properties: {
          productId: { type: 'integer' },
          quantity: { type: 'integer' },
          costPerBottle: { type: 'number' },
          targetPct: { type: 'number', description: 'target margin or markup in percent' },
          basis: { type: 'string', enum: ['margin_on_selling', 'markup_on_cost'] },
          customerId: { type: 'integer' },
          currency: { type: 'string' },
        },
        required: ['productId', 'costPerBottle'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_placement',
      description: 'Prepare (do not save) a supplier order/placement at cost price with full-box quantities. Resolve every line from a product name or barcode in ONE call — do not search products first. Each line: productQuery (name incl. size, e.g. "Versace Dylan Blue EDT 50 ml") or productId; boxes (preferred) or units; the supplier\'s cheapest cost offer supplies pack size and unit cost. Returns a proposal a human applies.',
      parameters: {
        type: 'object',
        properties: {
          supplierCode: { type: 'string', description: 'Supplier code from list_suppliers, e.g. ALCODIS' },
          lines: {
            type: 'array',
            description: 'One entry per variant to order',
            items: {
              type: 'object',
              properties: {
                productId: { type: 'integer' },
                productQuery: { type: 'string', description: 'Product name including size, or barcode' },
                boxes: { type: 'integer', description: 'Full boxes to order (preferred)' },
                units: { type: 'integer', description: 'Bottles; rounded up to whole boxes' },
                quantity: { type: 'integer', description: 'Alias for units' },
                unitCost: { type: 'number', description: 'Optional override; defaults to the supplier offer cost' },
                unitsPerCase: { type: 'integer', description: 'Optional override for the pack size' },
              },
            },
          },
        },
        required: ['supplierCode', 'lines'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dashboard_overview',
      description: 'Whole-system snapshot: KPIs, offer/supplier/customer counts, wins by type and current alert counts.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_alerts',
      description: 'Current alerts (price anomalies, stale offers, low stock). Set unreadOnly to hide acknowledged ones.',
      parameters: { type: 'object', properties: { unreadOnly: { type: 'boolean' }, limit: { type: 'integer' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_orders',
      description: 'Realised customer orders, newest first. Optionally filter by status (draft | confirmed | shipped | delivered | cancelled).',
      parameters: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_order',
      description: 'One realised order with its payments, by id.',
      parameters: { type: 'object', properties: { orderId: { type: 'integer' } }, required: ['orderId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_inventory',
      description: 'Stock on hand by lot, with reserved quantities and totals. Optionally filter to one product.',
      parameters: { type: 'object', properties: { productId: { type: 'integer' }, limit: { type: 'integer' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_exceptions',
      description: 'Import exceptions (blank/invalid barcode, duplicate, mismatch, no price). Set resolved=true for the resolved pile.',
      parameters: { type: 'object', properties: { resolved: { type: 'boolean' }, supplier: { type: 'string' }, limit: { type: 'integer' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_captures',
      description: 'Captured notes/inbox (Plaud, Remarkable, manual, webhook). Optionally filter by status (new | promoted | ignored).',
      parameters: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'Follow-up tasks with the open/closed summary. Filter by status, owner, or set openOnly=false to include closed.',
      parameters: { type: 'object', properties: { status: { type: 'string' }, openOnly: { type: 'boolean' }, owner: { type: 'string' }, limit: { type: 'integer' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'purchase_plan',
      description: 'Consolidated buy plan: open/wishlist/quoted demands grouped per supplier with recommended quantities. Filter to one supplier if given.',
      parameters: { type: 'object', properties: { supplierCode: { type: 'string' }, approvedOnly: { type: 'boolean' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'price_movers',
      description: 'Products whose supplier prices moved the most recently (up or down) — good for "what changed" questions.',
      parameters: { type: 'object', properties: { limit: { type: 'integer' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'product_history',
      description: 'Price/offer history series for one product.',
      parameters: { type: 'object', properties: { productId: { type: 'integer' }, limit: { type: 'integer' } }, required: ['productId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_quotes',
      description: 'Head-to-head comparison of two customer quotes (cost, margin, terms).',
      parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'demand_forecast',
      description: 'Baseline demand forecast. Without productId returns the whole product table; with it returns one product.',
      parameters: { type: 'object', properties: { productId: { type: 'integer' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'export_info',
      description: 'Where to download any report or document as Excel (.xlsx) and PDF. Ask it for one kind, or call with no argument for the full catalogue.',
      parameters: { type: 'object', properties: { kind: { type: 'string', description: 'report kind, e.g. pricing | margin | demand' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_demand',
      description: 'Prepare (do not save) a customer demand row. Returns a proposal a buyer applies.',
      parameters: {
        type: 'object',
        properties: {
          customerId: { type: 'integer' },
          productId: { type: 'integer' },
          quantity: { type: 'integer' },
          targetPrice: { type: 'number' },
          currency: { type: 'string' },
          neededBy: { type: 'string', description: 'ISO date YYYY-MM-DD' },
          notes: { type: 'string' },
        },
        required: ['customerId', 'productId', 'quantity'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_order',
      description: 'Prepare (do not save) a customer order. Prefer quoteId so quantity, prices and dates are inherited from the quote. Returns a proposal a buyer applies.',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'integer' },
          customerId: { type: 'integer' },
          productId: { type: 'integer' },
          quantity: { type: 'integer' },
          unitPrice: { type: 'number' },
          unitCost: { type: 'number' },
          currency: { type: 'string' },
          supplierCode: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draft_task',
      description: 'Prepare (do not save) a follow-up task. Returns a proposal a user applies.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          dueDate: { type: 'string', description: 'ISO date YYYY-MM-DD' },
          owner: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high'] },
          customerId: { type: 'integer' },
          demandId: { type: 'integer' },
        },
        required: ['title'],
      },
    },
  },
];

function runTool(name, args) {
  const fn = EXECUTORS[name];
  if (!fn) return { result: { error: 'unknown tool: ' + name } };
  try {
    const out = fn(args || {}) || {};
    const proposal = out.proposal;
    const result = Object.assign({}, out);
    delete result.proposal;
    return { result, proposal };
  } catch (e) {
    return { result: { error: e.message } };
  }
}

/* --------------------------------- transport ------------------------------- */

// One attempt may fail because a model was retired, turned paid or throttled.
// Fall back through AI_MODELS in order; only stop early on errors retrying
// cannot fix (bad key, no credit, malformed request).
let httpFetch = (url, opts) => fetch(url, opts);

// Swappable so tests can drive the loop without a network. When onDelta is a
// function the real transport streams tokens (SSE from the provider) and calls
// onDelta(text) per content fragment, then returns the assembled message.
function describeProvider(status, detail, modelId) {
  const d = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const id = String(modelId || '?');
  if (status === 401) {
    return { code: 'auth', retry: false, reason: 'the API key was rejected',
      message: 'The AI provider rejected the API key. Check AI_API_KEY on the server.' };
  }
  if (status === 402) {
    return { code: 'credits', retry: false, reason: 'the account has no credit',
      message: 'The AI provider account is out of credit. Top up, or switch AI_MODEL to a free model.' };
  }
  if (status === 403 && /key|auth|forbidden|permission/i.test(d)) {
    return { code: 'auth', retry: false, reason: 'access was refused',
      message: 'The AI provider refused access (HTTP 403): ' + (d || 'check the API key and model permissions') };
  }
  if (status === 404 && /unavailable for free|not a valid model|no endpoints found|does not exist|deprecated|not found/i.test(d)) {
    return { code: 'model_unavailable', retry: true, reason: 'retired or paid-only',
      message: 'Model "' + id + '" is retired or paid-only on this provider.' };
  }
  if (status === 403) {
    return { code: 'model_restricted', retry: true, reason: 'not available for this account',
      message: 'Model "' + id + '" is not available with this account' + (d ? ' (' + d + ')' : '') + '.' };
  }
  if (status === 404) {
    return { code: 'model_unavailable', retry: true, reason: 'not found',
      message: 'Model "' + id + '" was not found on this provider.' };
  }
  if (status === 429) {
    return { code: 'rate_limit', retry: true, reason: 'rate-limited (free-tier quota)',
      message: 'The provider rate-limited model "' + id + '".' };
  }
  if (status >= 500) {
    return { code: 'provider', retry: true, reason: 'provider error ' + status,
      message: 'The provider failed on model "' + id + '" (HTTP ' + status + ')' + (d ? ': ' + d : '') + '.' };
  }
  return { code: 'bad_request', retry: false, reason: 'request rejected',
    message: 'The provider rejected the request' + (d ? ': ' + d : ' (HTTP ' + status + ')') + '.' };
}

function allFailed(failures) {
  const parts = failures.map((f) => f.model + ' (' + f.reason + ')');
  const dead = failures.some((f) => f.code === 'model_unavailable' || f.code === 'model_restricted');
  const rate = failures.some((f) => f.code === 'rate_limit');
  const offline = failures.every((f) => f.code === 'network' || f.code === 'timeout');
  let hint = '';
  if (dead) hint = ' Update AI_MODEL / AI_MODELS (run "npm run check:ai" to list working models).';
  else if (rate) hint = ' The free-tier quota is exhausted - retry shortly or add another model to AI_MODELS.';
  else if (offline) hint = ' Check the provider URL, this server\'s network access and AI_TIMEOUT_MS.';
  const err = new Error('The assistant could not reach any configured model: ' + parts.join('; ') + '.' + hint);
  err.status = failures.every((f) => f.code === 'timeout') ? 504 : 502;
  err.code = failures[0] && failures[0].code;
  err.failures = failures.map((f) => ({ model: f.model, code: f.code, reason: f.reason }));
  return err;
}

async function readResponse(res, onDelta) {
  if (typeof onDelta !== 'function') {
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = null; }
    return data;
  }
  // SSE: "data: {...}" lines, terminated by "data: [DONE]". Content tokens
  // arrive as delta.content; tool calls arrive as delta.tool_calls fragments
  // keyed by index (id/name whole, arguments cumulative).
  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    const toolCalls = [];
    const takeLine = (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let j;
      try { j = JSON.parse(data); } catch (_) { return; }
      const d = j && j.choices && j.choices[0] && j.choices[0].delta;
      if (!d) return;
      if (d.content) { content += d.content; onDelta(d.content); }
      (d.tool_calls || []).forEach((tc) => {
        const i = tc.index || 0;
        if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function && tc.function.name) toolCalls[i].function.name = tc.function.name;
        if (tc.function && tc.function.arguments) toolCalls[i].function.arguments += tc.function.arguments;
      });
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        takeLine(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
      }
    }
    if (buf) takeLine(buf.replace(/\r$/, ''));
    const msg = { role: 'assistant', content };
    if (toolCalls.length) msg.tool_calls = toolCalls;
    return { choices: [{ message: msg }] };
  } catch (e) {
    const err = new Error('The AI provider stopped mid-answer. Retry to get the full reply.');
    err.status = 502;
    err.code = 'stream';
    err.retry = false;
    throw err;
  }
}

let discoveredModel = null;

function candidateOrder() {
  const order = [];
  if (discoveredModel) order.push(discoveredModel);
  for (const id of models()) if (!order.includes(id)) order.push(id);
  return order;
}

function autoDiscoverEnabled() { return process.env.AI_AUTO_DISCOVER !== '0'; }

async function discoverModels(exclude) {
  if (!autoDiscoverEnabled()) return [];
  let catalog = null;
  try {
    const r = await getJson(baseUrl() + '/models', 6000);
    if (r.ok && r.data && Array.isArray(r.data.data)) catalog = r.data.data;
  } catch (_) { return []; }
  if (!catalog) return [];
  const max = Math.max(0, Number(process.env.AI_AUTO_DISCOVER_MAX) || 2);
  return catalog
    .filter((m) => m && /:free$/.test(m.id))
    .filter((m) => m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)
    .filter((m) => (m.supported_parameters || []).includes('tools'))
    .map((m) => m.id)
    .filter((id) => !exclude.includes(id))
    .slice(0, max);
}

// One model attempt: resolves to { out } on success or { failure } when the
// next candidate should be tried. Throws only for errors retrying cannot fix.
async function attempt(id, payload, onDelta) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS) || 45000);
  try {
    const body = Object.assign({}, payload, { model: id });
    if (typeof onDelta === 'function') body.stream = true;
    const res = await httpFetch(baseUrl() + '/chat/completions', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (_) { data = null; }
      const detail = (data && data.error && (data.error.message || data.error.code)) || text || ('HTTP ' + res.status);
      const info = describeProvider(res.status, detail, id);
      if (!info.retry) {
        const err = new Error(info.message);
        err.status = 502;
        err.code = info.code;
        err.retry = false;
        err.failures = [{ model: id, code: info.code, reason: info.reason }];
        throw err;
      }
      return { failure: { model: id, code: info.code, reason: info.reason } };
    }
    const out = await readResponse(res, onDelta);
    if (out && typeof out === 'object') {
      out._model = id;
      if (!out.model) out.model = id;
    }
    return { out };
  } catch (e) {
    if (e && e.retry === false) throw e;
    if (e && e.name === 'AbortError') {
      return { failure: { model: id, code: 'timeout', reason: 'timed out after ' + Math.round((Number(process.env.AI_TIMEOUT_MS) || 45000) / 1000) + 's' } };
    }
    return { failure: { model: id, code: 'network', reason: 'could not connect: ' + e.message } };
  } finally {
    clearTimeout(timeout);
  }
}

async function callModel(payload, onDelta) {
  const failures = [];
  for (const id of candidateOrder()) {
    const r = await attempt(id, payload, onDelta);
    if (r.out) return r.out;
    failures.push(r.failure);
  }

  // The configured slugs can all be stale (retired, paid-only, throttled).
  // Ask the provider what exists right now, keep the first free tool-capable
  // model that answers, and reuse it for the rest of this process.
  const churn = failures.some((f) => f.code === 'model_unavailable' || f.code === 'model_restricted' || f.code === 'rate_limit');
  if (churn) {
    for (const id of await discoverModels(failures.map((f) => f.model))) {
      const r = await attempt(id, payload, onDelta);
      if (r.out) {
        discoveredModel = id;
        console.warn('[ai] configured models unavailable; switched to discovered model ' + id);
        return r.out;
      }
      failures.push(r.failure);
    }
  }
  throw allFailed(failures);
}

let transport = callModel;
function setTransport(fn) { transport = fn || callModel; }

function setFetch(fn) { httpFetch = fn || ((url, opts) => fetch(url, opts)); }
function resetDiscovery() { discoveredModel = null; }

/* ------------------------------- diagnostics ------------------------------- */

async function getJson(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || 8000);
  try {
    const res = await httpFetch(url, { headers: headers(), signal: controller.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = null; }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// Live health check used by GET /api/ai/diagnose and `npm run check:ai`:
// is the provider reachable, do the configured models still exist, do they
// support tool calls, does the key have credit, and what free models could
// replace a dead one.
async function diagnose() {
  const provider = baseUrl();
  const configured = models();
  const out = {
    enabled: enabled(),
    provider,
    hasKey: Boolean(apiKey()),
    configured,
    models: [],
    usable: [],
    freeAlternatives: [],
    key: null,
    reachable: null,
    ok: false,
    hint: null,
  };
  let catalog = null;
  try {
    const r = await getJson(provider + '/models', 8000);
    out.reachable = r.status;
    if (r.ok && r.data && Array.isArray(r.data.data)) catalog = r.data.data;
    else out.hint = 'GET ' + provider + '/models returned HTTP ' + r.status + '.';
  } catch (e) {
    out.reachable = false;
    out.hint = 'Could not reach ' + provider + ': ' + e.message;
  }

  if (catalog) {
    const byId = new Map(catalog.map((m) => [m.id, m]));
    for (const id of configured) {
      const m = byId.get(id);
      const params = (m && m.supported_parameters) || [];
      const free = Boolean(m) && Number(m.pricing && m.pricing.prompt) === 0 && Number(m.pricing && m.pricing.completion) === 0;
      out.models.push({ id, present: Boolean(m), supportsTools: m ? params.includes('tools') : null, free });
      if (m && params.includes('tools')) out.usable.push(id);
    }
    out.freeAlternatives = catalog
      .filter((m) => /:free$/.test(m.id))
      .filter((m) => m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)
      .filter((m) => (m.supported_parameters || []).includes('tools'))
      .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
      .slice(0, 12)
      .map((m) => ({ id: m.id, context: m.context_length || null }));
  } else {
    out.models = configured.map((id) => ({ id, present: null, supportsTools: null, free: null }));
    out.usable = configured.slice();
  }

  if (/openrouter\.ai/.test(provider)) {
    try {
      const r = await getJson(provider + '/key', 8000);
      if (r.ok && r.data && r.data.data) {
        const d = r.data.data;
        out.key = {
          label: d.label || null,
          limit: d.limit,
          remaining: d.limit_remaining,
          usage: d.usage,
          freeTier: Boolean(d.is_free_tier),
        };
        if (Number(d.limit_remaining) === 0) out.hint = 'The OpenRouter key has no remaining credit.';
      }
    } catch (_) { /* key introspection is optional */ }
  }

  out.ok = out.usable.length > 0;
  if (!out.ok && out.freeAlternatives.length) {
    out.hint = (out.hint ? out.hint + ' ' : '') + 'Configured models are missing or do not support tools; try ' +
      out.freeAlternatives.slice(0, 3).map((m) => m.id).join(', ') + '.';
  }
  return out;
}

/* ---------------------------------- chat ----------------------------------- */

function sanitize(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
}

async function chat({ messages, onEvent } = {}) {
  if (!enabled()) {
    const err = new Error('The assistant is not configured. Set AI_BASE_URL, AI_API_KEY and AI_MODEL on the server.');
    err.status = 503;
    throw err;
  }
  const convo = [{ role: 'system', content: SYSTEM_PROMPT }].concat(sanitize(messages));
  // "yes" after an offered draft must not be re-analysed: steer the model to act.
  const lastUser = [...messages].reverse().find((m) => m && m.role === 'user' && typeof m.content === 'string');
  const hadAssistant = messages.some((m) => m && m.role === 'assistant');
  if (hadAssistant && lastUser && /^\s*(yes|yep|yeah|ok|okay|sure|go ahead|do it|please do|proceed|confirm(ed)?)\b/i.test(lastUser.content)
      && lastUser.content.trim().length <= 30) {
    convo.push({
      role: 'system',
      content: 'The user confirmed your previous offer. Call the relevant draft tool now using the data already discussed (draft tools resolve product names themselves), then describe the prepared draft. Do not repeat the analysis and do not ask again.',
    });
  }
  const proposals = [];
  const proposalKeys = new Set();
  let usedModel = model();
  const emit = (event) => { if (typeof onEvent === 'function') { try { onEvent(event); } catch (_) { /* listener must not break the turn */ } } };
  const stream = typeof onEvent === 'function';
  // A multi-variant draft needs several tool rounds; 6 was too tight for free
  // models that emit one call per step.
  const maxSteps = Math.min(Math.max(Number(process.env.AI_MAX_STEPS) || MAX_STEPS_DEFAULT, 2), 24);

  for (let step = 0; step < maxSteps; step += 1) {
    // Near the limit, stop exploring and produce the answer/proposals now.
    if (step === maxSteps - 2) {
      convo.push({
        role: 'system',
        content: 'You are close to the step limit. Do not call more read tools. Call the draft tool now if one is still needed, then reply with your final answer.',
      });
    }
    const onDelta = stream ? (text) => emit({ type: 'delta', text }) : undefined;
    const resp = await transport({ model: usedModel, messages: convo, tools: TOOLS, tool_choice: 'auto' }, onDelta);
    if (resp && typeof resp === 'object' && resp._model) usedModel = resp._model;
    const msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message;
    if (!msg) throw Object.assign(new Error('The AI provider returned an empty response.'), { status: 502 });
    convo.push(msg);

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      let reply = msg.content || '';
      // A retried tool call can succeed after an early error; small models then
      // report the error and ignore the card. If a draft exists, say so.
      if (proposals.length && /\b(couldn't|could not|unable|failed|failure|error|issue)\b/i.test(reply)) {
        const one = proposals.length === 1;
        reply = 'I prepared ' + proposals.length + ' draft' + (one ? '' : 's') + ': ' +
          proposals.map((p) => p.title + (p.summary ? ' (' + p.summary + ')' : '')).join('; ') +
          '. Review the card' + (one ? '' : 's') + ' below and click Apply.';
      }
      return { reply, proposals, model: usedModel };
    }
    for (const call of calls) {
      const name = call.function && call.function.name;
      emit({ type: 'tool', name: name || 'tool' });
      let args = {};
      try { args = call.function && call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch (_) { args = {}; }
      const out = runTool(name, args);
      if (out.proposal) {
        // Models sometimes repeat the same draft call; one card is enough.
        const key = out.proposal.type + '|' + JSON.stringify(out.proposal.apply && out.proposal.apply.body);
        if (!proposalKeys.has(key)) { proposalKeys.add(key); proposals.push(out.proposal); }
      }
      convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out.result) });
    }
  }
  // Keep whatever was drafted: the proposals are still valid and applicable.
  const reply = proposals.length
    ? 'I prepared ' + proposals.length + ' draft' + (proposals.length === 1 ? '' : 's') +
      ' but ran out of steps before writing the full explanation. Review the draft(s) below.'
    : 'I hit the step limit before finishing — try narrowing the request.';
  return { reply, proposals, model: usedModel };
}

module.exports = {
  enabled,
  status,
  models,
  diagnose,
  chat,
  runTool,
  setTransport,
  setFetch,
  _resetDiscovery: resetDiscovery,
  tools: TOOLS,
  _executors: EXECUTORS,
  _describeProvider: describeProvider,
};
