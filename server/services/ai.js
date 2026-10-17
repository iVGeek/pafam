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
const { SYSTEM_PROMPT } = require('./aiKnowledge');

const MAX_STEPS = 6;

/* ------------------------------ configuration ------------------------------ */

function baseUrl() { return (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''); }
function model() { return process.env.AI_MODEL || 'gpt-4o-mini'; }
function apiKey() { return process.env.AI_API_KEY || ''; }
function enabled() {
  return process.env.PTP_AI_MOCK === '1' || Boolean(process.env.AI_API_KEY) || Boolean(process.env.AI_BASE_URL);
}

function status() {
  return {
    enabled: enabled(),
    model: model(),
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

function toolDraftPlacement({ supplierCode, lines } = {}) {
  const code = String(supplierCode || '').trim();
  if (!code) return { error: 'supplierCode is required' };
  const supplier = db.prepare('SELECT code, name, currency FROM suppliers WHERE code = ?').get(code);
  if (!supplier) return { error: 'supplier not found: ' + code };
  const input = Array.isArray(lines) ? lines : [];
  if (!input.length) return { error: 'at least one line is required' };

  const prepared = [];
  for (const l of input) {
    const product = l && l.productId != null
      ? db.prepare('SELECT id, display_name, canonical_gtin FROM products WHERE id = ?').get(Number(l.productId))
      : null;
    if (!product) return { error: 'product not found on a line: ' + (l && l.productId) };
    const qty = Math.max(0, Math.round(Number(l.quantity) || 0));
    if (!qty) return { error: 'quantity required for ' + product.display_name };
    prepared.push({
      productId: product.id,
      product: product.display_name,
      quantity: qty,
      unitCost: l.unitCost != null && l.unitCost !== '' ? Number(l.unitCost) : null,
    });
  }

  const estimated = prepared.reduce((s, l) => s + (l.unitCost != null ? l.unitCost * l.quantity : 0), 0);
  return {
    proposal: {
      type: 'placement',
      title: 'Supplier order — ' + supplier.name,
      summary: `${prepared.length} line(s)` + (estimated ? ` - about ${estimated} ${supplier.currency}` : ''),
      fields: prepared.map((l) => ({
        label: l.product,
        value: `${l.quantity} units` + (l.unitCost != null ? ` @ ${l.unitCost}` : ' (cost taken from the offer)'),
      })),
      apply: {
        label: 'Create placement',
        method: 'POST',
        url: '/placements',
        body: {
          supplierCode: supplier.code,
          lines: prepared.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCost: l.unitCost })),
        },
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
  draft_offer: toolDraftOffer,
  draft_placement: toolDraftPlacement,
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
      description: 'Prepare (do not save) a supplier order/placement at cost price with full-box quantities. Returns a proposal a human applies.',
      parameters: {
        type: 'object',
        properties: {
          supplierCode: { type: 'string' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: { productId: { type: 'integer' }, quantity: { type: 'integer' }, unitCost: { type: 'number' } },
              required: ['productId', 'quantity'],
            },
          },
        },
        required: ['supplierCode', 'lines'],
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

// Swappable so tests can drive the loop without a network. Real one below.
async function callModel(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS) || 45000);
  let res;
  try {
    res = await fetch(baseUrl() + '/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, apiKey() ? { authorization: 'Bearer ' + apiKey() } : {}),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    const err = new Error(e.name === 'AbortError' ? 'The AI provider timed out.' : 'Could not reach the AI provider: ' + e.message);
    err.status = e.name === 'AbortError' ? 504 : 502;
    throw err;
  }
  clearTimeout(timeout);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { data = null; }
  if (!res.ok) {
    const detail = (data && data.error && data.error.message) || text || ('HTTP ' + res.status);
    const err = new Error('AI provider error: ' + detail);
    err.status = 502;
    throw err;
  }
  return data;
}

let transport = callModel;
function setTransport(fn) { transport = fn || callModel; }

/* ---------------------------------- chat ----------------------------------- */

function sanitize(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
}

async function chat({ messages } = {}) {
  if (!enabled()) {
    const err = new Error('The assistant is not configured. Set AI_BASE_URL, AI_API_KEY and AI_MODEL on the server.');
    err.status = 503;
    throw err;
  }
  const convo = [{ role: 'system', content: SYSTEM_PROMPT }].concat(sanitize(messages));
  const proposals = [];

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const resp = await transport({ model: model(), messages: convo, tools: TOOLS, tool_choice: 'auto' });
    const msg = resp && resp.choices && resp.choices[0] && resp.choices[0].message;
    if (!msg) throw Object.assign(new Error('The AI provider returned an empty response.'), { status: 502 });
    convo.push(msg);

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      return { reply: msg.content || '', proposals, model: model() };
    }
    for (const call of calls) {
      const name = call.function && call.function.name;
      let args = {};
      try { args = call.function && call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch (_) { args = {}; }
      const out = runTool(name, args);
      if (out.proposal) proposals.push(out.proposal);
      convo.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out.result) });
    }
  }
  return { reply: 'I hit the step limit before finishing — try narrowing the request.', proposals, model: model() };
}

module.exports = {
  enabled,
  status,
  chat,
  runTool,
  setTransport,
  tools: TOOLS,
  _executors: EXECUTORS,
};
