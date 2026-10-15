'use strict';

const gtin = require('./gtin');

// Heuristic parser that turns a free-text note (Plaud voice transcript,
// reMarkable export, pasted email) into structured trading signals.
// It is deliberately conservative: everything it finds is a *suggestion* for a
// human to confirm before it becomes a demand.

const CURRENCY = {
  '€': 'EUR', '$': 'USD', '£': 'GBP',
  EUR: 'EUR', USD: 'USD', GBP: 'GBP',
};

const UNIT_WORDS = [
  'bottles?', 'btls?', 'bottle', 'units?', 'pcs', 'pieces?', 'cases?', 'boxes?', 'box',
  'pallets?', 'packs?', 'crates?',
  'botellas?', 'unidades?', 'cajas?', 'pal[eé]s?', 'bultos?',
  'bouteilles?', 'caisses?', 'palettes?', 'unit[eé]s?',
].join('|');

const PRODUCT_KEYWORDS = [
  'perfume', 'parfum', 'fragrance', 'eau de parfum', 'eau de toilette',
  'eau de cologne', 'cologne', 'colonia', 'after shave', 'aftershave', 'body mist',
  'extrait', 'splash', 'deodorant', 'edp', 'edt',
];

const INTENT_WORDS = [
  'quote', 'quotation', 'offer', 'order', 'interested', 'need', 'want', 'enquire',
  'inquiry', 'availability', 'price', 'pricing', 'discount', 'ship', 'shipping',
  'cotiz', 'presupuesto', 'oferta', 'pedido', 'interesad', 'necesit', 'disponibilidad',
  'precio', 'descuento', 'devis', 'commande', 'prix',
];

function normalizeNumber(s) {
  if (s == null) return null;
  let t = String(s).trim().replace(/[^\d.,]/g, '');
  const hasComma = t.includes(',');
  const hasDot = t.includes('.');
  if (hasComma && hasDot) t = t.replace(/\./g, '').replace(',', '.');
  else if (hasComma) t = t.replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseNote(text) {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  const out = {
    intents: [],
    quantities: [],
    prices: [],
    barcodes: [],
    customerHint: null,
    productHints: [],
    language: 'en',
  };
  if (!raw.trim()) return out;

  // intents
  for (const w of INTENT_WORDS) {
    if (new RegExp('\\b' + w, 'i').test(lower)) out.intents.push(w);
  }
  out.intents = Array.from(new Set(out.intents));

  // quantities: "500 bottles", "50 cajas", "24 x"
  const qRe = new RegExp('(\\d[\\d.,]*)\\s*(?:x\\s*)?(' + UNIT_WORDS + ')\\b', 'gi');
  let m;
  while ((m = qRe.exec(raw)) !== null) {
    const value = normalizeNumber(m[1]);
    if (value != null) out.quantities.push({ value, unit: m[2].toLowerCase().replace(/s$/, '') });
  }
  // bare "N x SKU" patterns
  const xRe = /(\d[\d.,]*)\s*[x×]\s*/gi;
  while ((m = xRe.exec(raw)) !== null) {
    const value = normalizeNumber(m[1]);
    if (value != null && value >= 5) out.quantities.push({ value, unit: 'x' });
  }

  // prices with currency
  const pRe = /(?:([€$£])|(\beur\b|\busd\b|\bgbp\b))\s*(\d[\d.,]*)|(\d[\d.,]*)\s*(?:([€$£])|(\beur\b|\busd\b|\bgbp\b))/gi;
  while ((m = pRe.exec(raw)) !== null) {
    const sym = (m[1] || m[5] || m[2] || m[6] || '').toLowerCase();
    const value = normalizeNumber(m[3] || m[4]);
    if (value != null) out.prices.push({ value, currency: CURRENCY[sym] || CURRENCY[sym.toUpperCase()] || 'EUR' });
  }

  // barcodes
  const bRe = /\b(\d{8,14})\b/g;
  const seen = new Set();
  while ((m = bRe.exec(raw)) !== null) {
    const g = gtin.analyse(m[1]);
    if (g.valid && !seen.has(g.canonical14)) { seen.add(g.canonical14); out.barcodes.push(g.canonical14); }
  }

  // customer hint: case-insensitive keyword, then a Title Case run (case-sensitive)
  const ckw = /\b(customer|client|cliente|buyer|account|for|para)\b/i.exec(raw);
  if (ckw) {
    const rest = raw.slice(ckw.index + ckw[0].length).replace(/^\s*[:\-]?\s*/, '');
    const cm = rest.match(/^([A-Z][\w&'\-]*(?:\s+[A-Z][\w&'\-]*){0,3})/);
    if (cm) out.customerHint = cm[1].trim().slice(0, 60);
  }

  // product hints: keyword-led, or "of/de X"
  const ph = [];
  for (const kw of PRODUCT_KEYWORDS) {
    const re = new RegExp('([A-Z][\\w&.\'\\- ]{0,30})?\\b' + kw + '\\b([\\w&.\'\\- ]{0,30})', 'i');
    const pm = raw.match(re);
    if (pm) ph.push((pm[0] || kw).replace(/\s+/g, ' ').trim().slice(0, 50));
  }
  const ofRe = /\b(?:of|de|del|du)\s+([A-Z][\w&.'\-]*(?:\s+[\w&.'\-]+){0,3})/g;
  while ((m = ofRe.exec(raw)) !== null) { if (ph.length < 6) ph.push(m[1].trim().slice(0, 50)); }
  out.productHints = Array.from(new Set(ph)).slice(0, 6);

  if (/[ñáéíóú¿¡]/i.test(raw) || /\b(cliente|pedido|cotiz|necesit)/i.test(lower)) out.language = 'es';

  out.suggestedQuantity = out.quantities.length ? Math.max(...out.quantities.map((q) => q.value)) : null;
  out.suggestedPrice = out.prices.length ? out.prices[0].value : null;
  out.suggestedCurrency = out.prices.length ? out.prices[0].currency : null;

  return out;
}

module.exports = { parseNote, normalizeNumber };
