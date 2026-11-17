#!/usr/bin/env node
'use strict';

// Validate a returned client onboarding package before we import it.
//
//   npm run check:client -- <package-dir>
//   npm run check:client -- <package-dir> --base USD --json
//
// The package is the 9-item checklist in 06-client-data-checklist.md plus the
// FX rate file. This script is deliberately standalone: it reads Excel files
// only, never the platform database, so it can run on the client's delivery
// before anything is loaded.
//
// Exit codes: 0 = no blockers, 1 = blockers found, 2 = bad arguments.

const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const { analyse } = require('../src/lib/gtin');
const { extract: extractRaw } = require('../src/importers/genericImporter');

const DEFAULT_BASE = 'USD';

// Active ISO-4217 codes (plus a few recently retired ones still seen in files).
const ISO_CURRENCIES = new Set(`
AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB
BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUC
CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF
GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR
KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP
MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP
PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD
SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI
UYU UYW UZS VED VES VND VUV WST XAF XAG XAU XBA XBB XBC XBD XCD XDR XOF XPD
XPF XPT XSU XTS XUA XXX YER ZAR ZMW ZWL
`.trim().split(/\s+/));

const INCOTERMS = new Set(['EXW', 'FOB', 'CIF', 'DAP', 'DDP', 'FCA', 'CPT']);
const PRICE_BASES = new Set(['cost', 'rrp']);
const OFFER_FORBIDDEN_TOKENS = ['suppliercode', 'unitcost', 'landedunitcost', 'marginpct', 'markuppct'];
const OFFER_INTERNAL_LABELS = ['approved by', 'status', 'price list basis', 'internal notes'];
const MEDIA_EXT = /\.(mp4|mov|avi|mkv|webm|png|jpe?g|gif|pdf)$/i;

// --------------------------------------------------------------- small utils

function isBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function norm(v) {
  return isBlank(v) ? '' : String(v).trim();
}

function normKey(v) {
  return norm(v).replace(/\s+/g, ' ').toLowerCase();
}

function compactKey(v) {
  return normKey(v).replace(/[^a-z0-9]/g, '');
}

function keyMatches(head, want) {
  const h = normKey(head);
  const w = normKey(want);
  if (!h || !w) return false;
  return h === w || h.startsWith(w + ' ') || h.startsWith(w + '(') || h.startsWith(w + ' (');
}

function rel(root, file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function bool01(v) {
  if (isBlank(v)) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v === 1 ? 1 : v === 0 ? 0 : null;
  const s = norm(v).toLowerCase();
  if (['1', 'yes', 'y', 'true'].includes(s)) return 1;
  if (['0', 'no', 'n', 'false'].includes(s)) return 0;
  return null;
}

function num(v) {
  if (isBlank(v)) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'boolean') return NaN;
  const s = String(v).trim().replace(/\s+/g, '');
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}

function integer(v) {
  const n = num(v);
  if (n === null || Number.isNaN(n)) return n;
  return Number.isInteger(n) ? n : NaN;
}

function isoCurrency(v) {
  const s = norm(v).toUpperCase();
  return ISO_CURRENCIES.has(s) ? s : null;
}

function isoCountry(v) {
  const s = norm(v).toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function validIso(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return { iso: null, warning: `invalid date ${y}-${m}-${d}` };
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    return { iso: null, warning: `invalid date ${y}-${m}-${d}` };
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return { iso: null, warning: `invalid date ${y}-${m}-${d}` };
  }
  return { iso: `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`, warning: null };
}

function isoOfDate(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function parseDate(v) {
  if (isBlank(v)) return { iso: null, warning: null };
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return { iso: isoOfDate(v), warning: null };
  }
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d || !d.y) return { iso: null, warning: `invalid Excel date ${v}` };
    return validIso(d.y, d.m, d.d);
  }
  const s = norm(v);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return validIso(+m[1], +m[2], +m[3]);
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) return { ...validIso(+m[1], +m[2], +m[3]), warning: 'non-ISO date (YYYY/MM/DD)' };
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) {
    // Supply lists are mostly Spanish, so this is read as DD/MM/YYYY.
    return { ...validIso(+m[3], +m[2], +m[1]), warning: 'non-ISO date interpreted as DD/MM/YYYY' };
  }
  return { iso: null, warning: `unparseable date "${s}"` };
}

// --------------------------------------------------------- workbook plumbing

function rowsOf(sheet) {
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    blankrows: true,
    raw: true,
  });
}

function tableFromSheet(sheet, required, maxRows = 40) {
  const rows = rowsOf(sheet);
  let headerRow = -1;
  let header = null;
  for (let i = 0; i < Math.min(rows.length, maxRows); i++) {
    const candidate = (rows[i] || []).map(norm);
    if (required.every((req) => candidate.some((h) => keyMatches(h, req)))) {
      headerRow = i;
      header = candidate;
      break;
    }
  }
  if (!header) return { header: null, rows: [], headerRow: -1, cols: {}, rowsRaw: rows };

  const cols = {};
  for (const req of required) {
    cols[req] = header.findIndex((h) => keyMatches(h, req));
  }

  const data = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const arr = rows[i] || [];
    if (!arr.some((v) => !isBlank(v))) continue;
    const obj = { __row: i + 1 };
    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      if (key) obj[key] = arr[c] === undefined ? '' : arr[c];
    }
    for (const req of required) {
      const idx = cols[req];
      if (idx >= 0) obj[req] = arr[idx] === undefined ? '' : arr[idx];
    }
    data.push(obj);
  }
  return { header, rows: data, headerRow: headerRow + 1, cols, rowsRaw: rows };
}

function cell(row, name) {
  if (!row || typeof row !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  const want = normKey(name);
  for (const k of Object.keys(row)) {
    if (k.startsWith('__')) continue;
    const nk = normKey(k);
    if (nk === want || nk.startsWith(want + ' ') || nk.startsWith(want + '(') || nk.startsWith(want + ' (')) {
      return row[k];
    }
  }
  return '';
}

function field(row, names) {
  for (const name of names) {
    const v = cell(row, name);
    if (!isBlank(v)) return v;
  }
  return '';
}

function isExampleRow(row) {
  const text = Object.keys(row)
    .filter((k) => !k.startsWith('__'))
    .map((k) => norm(row[k]))
    .join(' ');
  return /example\s*row|example\s*[—–-]\s*replace|example rows above/i.test(text);
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function listFilesRecursive(root, maxDepth = 5) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir, depth) => {
    for (const ent of listDir(dir)) {
      const full = path.join(dir, ent.name);
      if (ent.isFile()) out.push(full);
      else if (ent.isDirectory() && depth < maxDepth) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function findNamedFile(root, name, preferred = []) {
  const dirs = [root, ...preferred.map((p) => path.join(root, p))];
  for (const dir of dirs) {
    const direct = path.join(dir, name);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  }
  for (const dir of dirs) {
    for (const ent of listDir(dir)) {
      if (ent.isFile() && ent.name.toLowerCase() === name.toLowerCase()) return path.join(dir, ent.name);
    }
  }
  return null;
}

function findRecursive(root, name, maxDepth = 5) {
  if (!fs.existsSync(root)) return null;
  const target = name.toLowerCase();
  const walk = (dir, depth) => {
    for (const ent of listDir(dir)) {
      const full = path.join(dir, ent.name);
      if (ent.isFile() && ent.name.toLowerCase() === target) return full;
      if (ent.isDirectory() && depth < maxDepth) {
        const found = walk(full, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(root, 0);
}

function readWorkbook(file) {
  return XLSX.readFile(file, { cellDates: false, cellNF: false });
}

function pickSheet(wb, expected, required, report, item) {
  if (expected && wb.Sheets[expected]) return wb.Sheets[expected];
  for (const name of wb.SheetNames) {
    const table = tableFromSheet(wb.Sheets[name], required);
    if (table.header) {
      if (expected) report.warn(item, `sheet "${expected}" not found; reading "${name}" instead`);
      return wb.Sheets[name];
    }
  }
  return wb.Sheets[wb.SheetNames[0]] || null;
}

function openTable(file, sheetName, required, report, item) {
  let wb;
  try {
    wb = readWorkbook(file);
  } catch (e) {
    report.blocker(item, `${path.basename(file)}: cannot read workbook (${e.message})`);
    return null;
  }
  const sheet = pickSheet(wb, sheetName, required, report, item);
  if (!sheet) {
    report.blocker(item, `${path.basename(file)}: workbook has no sheets`);
    return null;
  }
  return tableFromSheet(sheet, required);
}

// ------------------------------------------------------------- report object

function createReport() {
  const checks = [];
  const add = (level, item, message) => checks.push({ level, item, message });
  return {
    checks,
    blocker: (item, message) => add('BLOCKER', item, message),
    warn: (item, message) => add('WARN', item, message),
    ok: (item, message) => add('OK', item, message),
  };
}

function buildResult(ctx) {
  const blockers = ctx.report.checks.filter((c) => c.level === 'BLOCKER');
  const warnings = ctx.report.checks.filter((c) => c.level === 'WARN');
  const passed = ctx.report.checks.filter((c) => c.level === 'OK');
  return {
    dir: ctx.dir,
    base: ctx.base,
    ok: blockers.length === 0,
    summary: {
      blockers: blockers.length,
      warnings: warnings.length,
      passed: passed.length,
      checks: ctx.report.checks.length,
    },
    checks: ctx.report.checks,
    blockers,
    warnings,
    passed,
  };
}

// ---------------------------------------------------------------- 01 suppliers

function checkSuppliers(ctx) {
  const item = '01 supplier master';
  const file = findNamedFile(ctx.dir, '01-supplier-master.xlsx');
  if (!file) {
    ctx.report.blocker(item, 'missing 01-supplier-master.xlsx');
    return;
  }
  ctx.report.ok(item, `found ${rel(ctx.dir, file)}`);

  const required = [
    'code', 'name', 'baseCurrency', 'priceType', 'priceListFormat',
    'dutyPct', 'freightPerUnit', 'insurancePct', 'brokeragePerUnit', 'handlingPerUnit',
  ];
  const table = openTable(file, 'Suppliers', required, ctx.report, item);
  if (!table) return;
  if (!table.header) {
    ctx.report.blocker(item, `no header row with the required columns: ${required.join(', ')}`);
    return;
  }
  ctx.report.ok(item, `header row ${table.headerRow}`);

  const recommended = [
    'tradeDiscountPct', 'incoterm', 'incotermPlace', 'paymentTerms', 'otherTaxPct',
    'recoverableTaxPct', 'stockCountry', 'originCountry', 'contactName', 'contactEmail',
    'contactPhone', 'active', 'notes',
  ];
  const missingRecommended = recommended.filter((c) => !table.header.some((h) => keyMatches(h, c)));
  if (missingRecommended.length) {
    ctx.report.warn(item, `recommended column(s) missing: ${missingRecommended.join(', ')}`);
  }

  const rows = table.rows.filter((r) => !isExampleRow(r));
  if (table.rows.length !== rows.length) {
    ctx.report.warn(item, `${table.rows.length - rows.length} template example row(s) ignored`);
  }
  if (!rows.length) {
    ctx.report.blocker(item, 'no real supplier rows (all rows are examples or blank)');
    return;
  }

  const seen = new Map();
  for (const r of rows) {
    const rawCode = norm(cell(r, 'code'));
    const code = rawCode.toUpperCase();
    const label = code || `row ${r.__row}`;
    if (!rawCode) ctx.report.blocker(item, `${label}: code is blank`);
    else if (rawCode !== code) ctx.report.warn(item, `${label}: code normalised to ${code} (platform codes are uppercase)`);
    if (!code) continue;
    if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(code)) {
      ctx.report.warn(item, `${label}: code contains unusual characters`);
    }
    if (seen.has(code)) {
      ctx.report.blocker(item, `${label}: duplicate supplier code (also row ${seen.get(code)})`);
    } else {
      seen.set(code, r.__row);
    }

    const name = norm(cell(r, 'name'));
    if (!name) ctx.report.blocker(item, `${label}: name is blank`);

    const currency = isoCurrency(cell(r, 'baseCurrency'));
    if (!currency) {
      ctx.report.blocker(item, `${label}: baseCurrency "${norm(cell(r, 'baseCurrency'))}" is not a valid ISO-4217 code`);
    }

    const priceType = norm(cell(r, 'priceType')).toLowerCase();
    if (!PRICE_BASES.has(priceType)) {
      ctx.report.blocker(item, `${label}: priceType must be cost or rrp (got "${norm(cell(r, 'priceType'))}")`);
    }

    const format = norm(cell(r, 'priceListFormat')).toUpperCase();
    if (!['ALCODIS', 'IGAN', 'OTHER'].includes(format)) {
      ctx.report.blocker(item, `${label}: priceListFormat must be ALCODIS, IGAN or OTHER (got "${norm(cell(r, 'priceListFormat'))}")`);
    } else if (format === 'OTHER') {
      ctx.report.warn(item, `${label}: priceListFormat=OTHER — send 2-3 raw samples with 03 so we can build the import profile`);
    }

    const discount = num(cell(r, 'tradeDiscountPct'));
    if (priceType === 'rrp') {
      if (discount === null) ctx.report.blocker(item, `${label}: tradeDiscountPct is required when priceType=rrp`);
      else if (Number.isNaN(discount)) ctx.report.blocker(item, `${label}: tradeDiscountPct is not a plain number`);
      else if (discount < 0 || discount > 100) ctx.report.blocker(item, `${label}: tradeDiscountPct must be 0-100`);
      else if (discount === 0) ctx.report.warn(item, `${label}: rrp with 0% trade discount — confirm this is real`);
    } else if (discount !== null && !Number.isNaN(discount) && discount !== 0) {
      ctx.report.warn(item, `${label}: tradeDiscountPct=${discount} is ignored because priceType=cost`);
    }

    for (const f of ['dutyPct', 'freightPerUnit', 'insurancePct', 'brokeragePerUnit', 'handlingPerUnit']) {
      const n = num(cell(r, f));
      if (n === null) ctx.report.blocker(item, `${label}: ${f} is blank (required for landed cost)`);
      else if (Number.isNaN(n)) ctx.report.blocker(item, `${label}: ${f} is not a plain number`);
      else if (n < 0) ctx.report.blocker(item, `${label}: ${f} cannot be negative`);
    }
    for (const f of ['dutyPct', 'insurancePct', 'otherTaxPct', 'recoverableTaxPct']) {
      const n = num(cell(r, f));
      if (n !== null && !Number.isNaN(n) && (n < 0 || n > 100)) {
        ctx.report.blocker(item, `${label}: ${f} must be between 0 and 100`);
      }
    }
    for (const f of ['otherTaxPct', 'recoverableTaxPct']) {
      const n = num(cell(r, f));
      if (n !== null && Number.isNaN(n)) ctx.report.blocker(item, `${label}: ${f} is not a plain number`);
    }

    const incoterm = norm(cell(r, 'incoterm')).toUpperCase();
    if (incoterm && !INCOTERMS.has(incoterm)) {
      ctx.report.warn(item, `${label}: incoterm "${incoterm}" is not one of ${[...INCOTERMS].join('/')}`);
    }
    if (incoterm && !norm(cell(r, 'incotermPlace'))) {
      ctx.report.warn(item, `${label}: incotermPlace is blank`);
    }

    const active = bool01(cell(r, 'active'));
    if (active === null && !isBlank(cell(r, 'active'))) {
      ctx.report.warn(item, `${label}: active must be 1 or 0`);
    }

    for (const f of ['stockCountry', 'originCountry']) {
      const v = norm(cell(r, f));
      if (v && !isoCountry(v)) ctx.report.warn(item, `${label}: ${f} "${v}" is not a 2-letter country code`);
    }

    const email = norm(cell(r, 'contactEmail'));
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      ctx.report.warn(item, `${label}: contactEmail looks invalid`);
    }

    ctx.suppliers.set(code, {
      code,
      name,
      currency,
      priceType,
      format,
      discount: discount === null || Number.isNaN(discount) ? null : discount,
      row: r.__row,
    });
  }

  ctx.report.ok(item, `${rows.length} real supplier(s): ${[...ctx.suppliers.keys()].join(', ')}`);
}

// ---------------------------------------------------------------- 02 customers

function checkCustomers(ctx) {
  const item = '02 customer master';
  const file = findNamedFile(ctx.dir, '02-customer-master.xlsx');
  if (!file) {
    ctx.report.blocker(item, 'missing 02-customer-master.xlsx');
    return;
  }
  ctx.report.ok(item, `found ${rel(ctx.dir, file)}`);

  const required = ['name', 'baseCurrency'];
  const table = openTable(file, 'Customers', required, ctx.report, item);
  if (!table) return;
  if (!table.header) {
    ctx.report.blocker(item, 'no header row with the required columns: name, baseCurrency');
    return;
  }
  ctx.report.ok(item, `header row ${table.headerRow}`);
  if (!table.header.some((h) => keyMatches(h, 'code'))) {
    ctx.report.warn(item, 'code column missing — customer codes are needed for document naming and offer matching');
  }
  if (!table.header.some((h) => keyMatches(h, 'creditLimit'))) {
    ctx.report.warn(item, 'creditLimit column missing — the credit KPI will stay blank');
  }

  const rows = table.rows.filter((r) => !isExampleRow(r));
  if (table.rows.length !== rows.length) {
    ctx.report.warn(item, `${table.rows.length - rows.length} template example row(s) ignored`);
  }
  if (!rows.length) {
    ctx.report.blocker(item, 'no real customer rows (all rows are examples or blank)');
    return;
  }

  const seen = new Map();
  for (const r of rows) {
    const rawCode = norm(cell(r, 'code'));
    const code = rawCode.toUpperCase();
    const label = code || `row ${r.__row}`;
    const name = norm(cell(r, 'name'));
    if (!name) ctx.report.blocker(item, `${label}: name is required`);
    if (rawCode && seen.has(code)) {
      ctx.report.blocker(item, `${label}: duplicate customer code (also row ${seen.get(code)})`);
    } else if (rawCode) {
      seen.set(code, r.__row);
    }
    if (!rawCode) {
      ctx.report.warn(item, `${label}: code is blank — the platform will auto-assign one, but document naming needs a stable code`);
    }

    const currency = isoCurrency(cell(r, 'baseCurrency'));
    if (!currency) {
      ctx.report.blocker(item, `${label}: baseCurrency "${norm(cell(r, 'baseCurrency'))}" is not a valid ISO-4217 code`);
    }

    const credit = num(cell(r, 'creditLimit'));
    if (credit !== null && Number.isNaN(credit)) {
      ctx.report.blocker(item, `${label}: creditLimit is not a plain number`);
    } else if (credit !== null && credit < 0) {
      ctx.report.blocker(item, `${label}: creditLimit cannot be negative`);
    }

    for (const f of ['sanctioned', 'active']) {
      const v = cell(r, f);
      if (!isBlank(v) && bool01(v) === null) {
        ctx.report.warn(item, `${label}: ${f} must be 1 or 0`);
      }
    }

    const record = { code: code || null, name, currency, row: r.__row };
    if (code) ctx.customers.set(code, record);
    if (name) ctx.customerByName.set(name.toLowerCase(), record);
  }

  ctx.report.ok(item, `${rows.length} real customer(s)`);
}

// -------------------------------------------------------------------- 10 FX

function checkFx(ctx) {
  const item = '10 FX rates';
  const file = findNamedFile(ctx.dir, '10-fx-rates.xlsx');
  if (!file) {
    ctx.report.blocker(item, 'missing 10-fx-rates.xlsx');
    return;
  }
  ctx.report.ok(item, `found ${rel(ctx.dir, file)}`);

  const required = ['base', 'quote', 'rate', 'rateDate'];
  const table = openTable(file, 'FXRates', required, ctx.report, item);
  if (!table) return;
  if (!table.header) {
    ctx.report.blocker(item, `no header row with the required columns: ${required.join(', ')}`);
    return;
  }
  ctx.report.ok(item, `header row ${table.headerRow}`);
  if (!table.header.some((h) => keyMatches(h, 'source'))) {
    ctx.report.warn(item, 'source column missing — rates will have no audit trail');
  }

  const rows = table.rows;
  const templateRows = new Set([
    'EUR|USD|2026-10-19|ECB|1.08',
    'GBP|USD|2026-10-19|ECB|1.27',
  ]);
  const seen = new Map();

  for (const r of rows) {
    const base = isoCurrency(cell(r, 'base'));
    const quote = isoCurrency(cell(r, 'quote'));
    const label = `row ${r.__row}`;
    if (!base) ctx.report.blocker(item, `${label}: base "${norm(cell(r, 'base'))}" is not a valid ISO-4217 code`);
    if (!quote) ctx.report.blocker(item, `${label}: quote "${norm(cell(r, 'quote'))}" is not a valid ISO-4217 code`);
    if (base && quote && base === quote) {
      ctx.report.blocker(item, `${label}: base and quote are both ${base}`);
    }

    const rate = num(cell(r, 'rate'));
    if (rate === null) ctx.report.blocker(item, `${label}: rate is blank`);
    else if (Number.isNaN(rate)) ctx.report.blocker(item, `${label}: rate is not a plain number`);
    else if (rate <= 0) ctx.report.blocker(item, `${label}: rate must be greater than 0`);

    const date = parseDate(cell(r, 'rateDate'));
    if (!date.iso) {
      if (date.warning) ctx.report.blocker(item, `${label}: rateDate ${date.warning}`);
      else ctx.report.blocker(item, `${label}: rateDate is required`);
    } else if (date.warning) {
      ctx.report.warn(item, `${label}: ${date.warning}`);
    }

    const source = norm(cell(r, 'source'));
    if (!source) ctx.report.warn(item, `${label}: source is blank`);
    const booked = cell(r, 'booked');
    if (!isBlank(booked) && bool01(booked) === null) {
      ctx.report.warn(item, `${label}: booked must be 1 or 0`);
    }

    if (base && quote) {
      const key = `${base}|${quote}|${date.iso || '?'}|${source}`;
      if (seen.has(key)) {
        ctx.report.blocker(item, `${label}: duplicate rate (same base, quote, date and source as row ${seen.get(key)})`);
      } else {
        seen.set(key, r.__row);
      }
      const pair = `${base}>${quote}`;
      const inverse = `${quote}>${base}`;
      if (ctx.ratePairs.has(inverse)) {
        ctx.report.warn(item, `${label}: both ${inverse} and ${pair} are supplied — the platform derives the inverse automatically`);
      }
      ctx.ratePairs.add(pair);
    }
  }

  if (rows.length && rows.every((r) => templateRows.has(
    `${norm(cell(r, 'base')).toUpperCase()}|${norm(cell(r, 'quote')).toUpperCase()}|${parseDate(cell(r, 'rateDate')).iso || ''}|${norm(cell(r, 'source'))}|${num(cell(r, 'rate'))}`
  ))) {
    ctx.report.warn(item, 'FX rows look like the unchanged template example — replace them with real rates');
  }

  const needed = new Map();
  for (const s of ctx.suppliers.values()) {
    if (s.currency) needed.set(s.currency, `supplier ${s.code}`);
  }
  for (const c of ctx.customers.values()) {
    if (c.currency) needed.set(c.currency, `customer ${c.code || c.name}`);
  }

  let missing = 0;
  for (const [currency, who] of needed) {
    if (currency === ctx.base) continue;
    const direct = ctx.ratePairs.has(`${currency}>${ctx.base}`);
    const inverse = ctx.ratePairs.has(`${ctx.base}>${currency}`);
    if (!direct && !inverse) {
      missing += 1;
      ctx.report.blocker(item, `no FX path ${currency} -> ${ctx.base} (needed by ${who}); a missing pair converts at 1.0 silently`);
    }
  }
  if (!missing) {
    ctx.report.ok(item, `every supplier/customer currency reaches ${ctx.base} through a direct or inverse pair`);
  }
}

// --------------------------------------------------------- 03 raw list log

function checkRawLog(ctx) {
  const item = '03 raw price list log';
  const file = findNamedFile(ctx.dir, '03-raw-price-list-log.xlsx');
  if (!file) {
    ctx.report.blocker(item, 'missing 03-raw-price-list-log.xlsx');
    return;
  }
  ctx.report.ok(item, `found ${rel(ctx.dir, file)}`);

  const required = [
    'supplierCode', 'originalFileName', 'receivedDate', 'fileCurrency', 'priceBasis', 'hasBarcodeColumn',
  ];
  const table = openTable(file, 'RawPriceListLog', required, ctx.report, item);
  if (!table) return;
  if (!table.header) {
    ctx.report.blocker(item, `no header row with the required columns: ${required.join(', ')}`);
    return;
  }
  ctx.report.ok(item, `header row ${table.headerRow}`);

  const rows = table.rows.filter((r) => !isExampleRow(r));
  if (table.rows.length !== rows.length) {
    ctx.report.warn(item, `${table.rows.length - rows.length} template example row(s) ignored`);
  }
  if (!rows.length) {
    ctx.report.blocker(item, 'no real raw-list rows (all rows are examples or blank)');
    return;
  }

  const rawDir = path.join(ctx.dir, 'raw-price-lists');
  if (!fs.existsSync(rawDir)) {
    ctx.report.blocker(item, 'raw-price-lists/ folder is missing');
  }
  const rawIndex = new Map();
  if (fs.existsSync(rawDir)) {
    for (const f of listFilesRecursive(rawDir)) rawIndex.set(path.basename(f).toLowerCase(), f);
  }

  for (const r of rows) {
    const code = norm(cell(r, 'supplierCode')).toUpperCase();
    const label = code || `row ${r.__row}`;
    const supplier = ctx.suppliers.get(code);
    if (!code) {
      ctx.report.blocker(item, `${label}: supplierCode is blank`);
    } else if (!supplier) {
      ctx.report.blocker(item, `${label}: supplierCode ${code} does not exist in 01-supplier-master.xlsx`);
    }

    const filename = norm(cell(r, 'originalFileName'));
    if (!filename) {
      ctx.report.blocker(item, `${label}: originalFileName is blank`);
    } else {
      let found = rawIndex.get(filename.toLowerCase()) || null;
      let outside = false;
      if (!found) {
        found = findRecursive(ctx.dir, filename);
        if (found) outside = true;
      }
      if (!found) {
        ctx.report.blocker(item, `${label}: raw file "${filename}" not found under raw-price-lists/`);
      } else {
        if (outside) {
          ctx.report.warn(item, `${label}: raw file found outside raw-price-lists/ (${rel(ctx.dir, found)})`);
        } else {
          ctx.report.ok(item, `${label}: raw file present (${rel(ctx.dir, found)})`);
        }
        validateRawFile(ctx, item, supplier, found, r);
      }
    }

    const received = parseDate(cell(r, 'receivedDate'));
    if (!received.iso) {
      if (received.warning) ctx.report.blocker(item, `${label}: receivedDate ${received.warning}`);
      else ctx.report.blocker(item, `${label}: receivedDate is required`);
    } else if (received.warning) {
      ctx.report.warn(item, `${label}: ${received.warning}`);
    }

    const fileCurrency = isoCurrency(cell(r, 'fileCurrency'));
    if (!fileCurrency) {
      ctx.report.blocker(item, `${label}: fileCurrency "${norm(cell(r, 'fileCurrency'))}" is not a valid ISO-4217 code`);
    } else if (supplier && supplier.currency && fileCurrency !== supplier.currency) {
      ctx.report.warn(item, `${label}: fileCurrency ${fileCurrency} differs from the supplier baseCurrency ${supplier.currency}`);
    }

    const basis = norm(cell(r, 'priceBasis')).toLowerCase();
    if (!PRICE_BASES.has(basis)) {
      ctx.report.blocker(item, `${label}: priceBasis must be cost or rrp`);
    } else if (supplier && supplier.priceType && basis !== supplier.priceType) {
      ctx.report.warn(item, `${label}: priceBasis ${basis} differs from the supplier priceType ${supplier.priceType} in 01`);
    }

    const hasBarcode = norm(cell(r, 'hasBarcodeColumn')).toUpperCase();
    if (!['YES', 'NO'].includes(hasBarcode)) {
      ctx.report.blocker(item, `${label}: hasBarcodeColumn must be YES or NO`);
    } else if (hasBarcode === 'NO') {
      ctx.report.warn(item, `${label}: no barcode column — products cannot be created from this file; flag it before sending`);
    } else if (!norm(cell(r, 'barcodeColumnHeader'))) {
      ctx.report.warn(item, `${label}: barcodeColumnHeader is blank`);
    }

    const headerRow = integer(cell(r, 'headerRowNumber'));
    if (headerRow !== null && (Number.isNaN(headerRow) || headerRow < 1)) {
      ctx.report.warn(item, `${label}: headerRowNumber must be a positive integer`);
    } else if (headerRow === null) {
      ctx.report.warn(item, `${label}: headerRowNumber is blank`);
    }

    const unitsPerCase = integer(cell(r, 'defaultUnitsPerCase'));
    if (unitsPerCase !== null && (Number.isNaN(unitsPerCase) || unitsPerCase < 1)) {
      ctx.report.warn(item, `${label}: defaultUnitsPerCase must be a positive integer`);
    }

    const from = parseDate(cell(r, 'listValidFrom'));
    const to = parseDate(cell(r, 'listValidTo'));
    if (from.warning) ctx.report.warn(item, `${label}: listValidFrom ${from.warning}`);
    if (to.warning) ctx.report.warn(item, `${label}: listValidTo ${to.warning}`);
    if (from.iso && to.iso && to.iso < from.iso) {
      ctx.report.warn(item, `${label}: listValidTo ${to.iso} is before listValidFrom ${from.iso}`);
    }

    const discount = num(cell(r, 'tradeDiscountPctIfRrp'));
    if (basis === 'rrp') {
      if (discount === null) ctx.report.blocker(item, `${label}: tradeDiscountPctIfRrp is required when priceBasis=rrp`);
      else if (Number.isNaN(discount)) ctx.report.blocker(item, `${label}: tradeDiscountPctIfRrp is not a plain number`);
      else if (discount < 0 || discount > 100) ctx.report.blocker(item, `${label}: tradeDiscountPctIfRrp must be 0-100`);
      else if (discount === 0) ctx.report.warn(item, `${label}: rrp basis with 0% trade discount — confirm`);
    } else if (discount !== null && !Number.isNaN(discount) && discount !== 0) {
      ctx.report.warn(item, `${label}: tradeDiscountPctIfRrp is ignored because priceBasis=cost`);
    }

    if (code) {
      ctx.rawBySupplier.set(code, {
        filename,
        unitsPerCase: unitsPerCase === null || Number.isNaN(unitsPerCase) ? null : unitsPerCase,
        row: r.__row,
      });
    }
  }

  ctx.report.ok(item, `${rows.length} raw list(s) logged`);
}

function validateRawFile(ctx, item, supplier, found, logRow) {
  const name = path.basename(found);
  const declared = supplier ? supplier.format : null;
  let info;
  try {
    info = extractRaw(found, { supplierId: supplier ? supplier.code : '', supplierName: supplier ? supplier.name : '' });
  } catch (e) {
    if (/No known header row/i.test(e.message) && declared === 'OTHER') {
      ctx.report.warn(item, `${name}: no known import profile (expected for priceListFormat=OTHER) — attach 2-3 samples so we can build one`);
    } else {
      ctx.report.blocker(item, `${name}: raw file cannot be parsed (${e.message})`);
    }
    return;
  }

  const profileId = String(info.profile.id || '').toUpperCase();
  if (declared && declared !== 'OTHER' && profileId !== declared) {
    ctx.report.warn(item, `${name}: file matches profile ${profileId}, but 01 says priceListFormat=${declared}`);
  }
  if (declared === 'OTHER') {
    ctx.report.warn(item, `${name}: file matches known profile ${profileId} — update priceListFormat in 01 from OTHER`);
  }

  const logCurrency = isoCurrency(cell(logRow, 'fileCurrency'));
  if (logCurrency && info.profile.currency && logCurrency !== info.profile.currency) {
    ctx.report.warn(item, `${name}: detected currency ${info.profile.currency}, log says ${logCurrency}`);
  }

  const loggedHeader = integer(cell(logRow, 'headerRowNumber'));
  if (loggedHeader !== null && !Number.isNaN(loggedHeader) && loggedHeader !== info.rowIndex) {
    ctx.report.warn(item, `${name}: log says header row ${loggedHeader}, importer found it on row ${info.rowIndex}`);
  }

  const expectedBasis = profileId === 'IGAN' ? 'rrp' : 'cost';
  const loggedBasis = norm(cell(logRow, 'priceBasis')).toLowerCase();
  if (loggedBasis && loggedBasis !== expectedBasis) {
    ctx.report.warn(item, `${name}: profile ${profileId} prices are ${expectedBasis}, log says ${loggedBasis}`);
  }

  const offers = info.offers || [];
  if (!offers.length) {
    ctx.report.warn(item, `${name}: no data rows found below the header`);
    return;
  }

  const hasBarcode = norm(cell(logRow, 'hasBarcodeColumn')).toUpperCase() === 'YES';
  if (hasBarcode) {
    const valid = offers.filter((o) => o._gtin && o._gtin.valid).length;
    const rate = valid / offers.length;
    if (rate < 0.9) {
      ctx.report.blocker(item, `${name}: barcode validity ${(rate * 100).toFixed(1)}% is below the 90% acceptance threshold (${valid}/${offers.length})`);
    } else {
      ctx.report.ok(item, `${name}: barcode validity ${(rate * 100).toFixed(1)}% (${valid}/${offers.length})`);
    }
  }

  const noPrice = offers.filter((o) => o.price == null).length;
  if (noPrice) {
    ctx.report.warn(item, `${name}: ${noPrice} row(s) have no price and will become no_price exceptions`);
  }

  const seen = new Map();
  let duplicates = 0;
  for (const o of offers) {
    const key = o._gtin && o._gtin.canonical14;
    if (!key) continue;
    if (seen.has(key)) duplicates += 1;
    else seen.set(key, true);
  }
  if (duplicates) {
    ctx.report.warn(item, `${name}: ${duplicates} duplicate valid barcode(s) inside the file`);
  }
}

// --------------------------------------------------------- 04 prepared list

function checkPrepared(ctx) {
  const item = '04 prepared price list';
  const file = findNamedFile(ctx.dir, '04-prepared-price-list.xlsx', ['prepared-price-lists']);
  if (!file) {
    ctx.report.blocker(item, 'missing 04-prepared-price-list.xlsx (root or prepared-price-lists/)');
    return;
  }
  ctx.report.ok(item, `found ${rel(ctx.dir, file)}`);

  const required = [
    'ean', 'brand', 'product', 'sizeMl', 'supplierCode', 'supplierListDate',
    'costPerUnit', 'costCurrency', 'landedCost', 'sellPrice', 'sellCurrency',
  ];
  const table = openTable(file, 'PreparedPriceList', required, ctx.report, item);
  if (!table) return;
  if (!table.header) {
    ctx.report.blocker(item, `no header row with the required columns: ${required.join(', ')}`);
    return;
  }
  ctx.report.ok(item, `header row ${table.headerRow}`);

  const rows = table.rows.filter((r) => !isExampleRow(r));
  if (table.rows.length !== rows.length) {
    ctx.report.warn(item, `${table.rows.length - rows.length} template example row(s) ignored`);
  }
  if (!rows.length) {
    ctx.report.blocker(item, 'no real prepared-list rows (all rows are examples or blank)');
    return;
  }

  const seenEan = new Map();
  const missingRecommended = {
    concentration: 0, gender: 0, casePack: 0, markupPct: 0, rrp: 0,
    availability: 0, validUntil: 0, incoterm: 0, leadTimeDays: 0,
  };

  for (const r of rows) {
    const rowLabel = `row ${r.__row}`;
    const eanRaw = cell(r, 'ean');
    const gtin = analyse(eanRaw);
    if (!gtin.digits) {
      ctx.report.blocker(item, `${rowLabel}: ean is blank`);
    } else if (!gtin.valid) {
      ctx.report.blocker(item, `${rowLabel}: ean "${gtin.source}" fails the GS1 check digit (${gtin.length} digits)`);
    } else {
      if (seenEan.has(gtin.canonical14)) {
        ctx.report.warn(item, `${rowLabel}: duplicate barcode (also row ${seenEan.get(gtin.canonical14)})`);
      } else {
        seenEan.set(gtin.canonical14, r.__row);
      }
      if (typeof eanRaw === 'number') {
        ctx.report.warn(item, `${rowLabel}: ean is stored as a number — format the column as Text to preserve leading zeros`);
      }
    }

    const brand = norm(cell(r, 'brand'));
    const product = norm(cell(r, 'product'));
    if (!brand) ctx.report.blocker(item, `${rowLabel}: brand is blank`);
    if (!product) ctx.report.blocker(item, `${rowLabel}: product is blank`);

    const size = num(cell(r, 'sizeMl'));
    if (size === null) {
      ctx.report.warn(item, `${rowLabel}: sizeMl is blank`);
    } else if (Number.isNaN(size) || size <= 0) {
      ctx.report.blocker(item, `${rowLabel}: sizeMl must be a positive number`);
    }

    const code = norm(cell(r, 'supplierCode')).toUpperCase();
    const supplier = ctx.suppliers.get(code);
    if (!code) ctx.report.blocker(item, `${rowLabel}: supplierCode is blank`);
    else if (!supplier) ctx.report.blocker(item, `${rowLabel}: supplierCode ${code} does not exist in 01-supplier-master.xlsx`);

    const listDate = parseDate(cell(r, 'supplierListDate'));
    if (!listDate.iso) {
      if (listDate.warning) ctx.report.blocker(item, `${rowLabel}: supplierListDate ${listDate.warning}`);
      else ctx.report.blocker(item, `${rowLabel}: supplierListDate is required`);
    } else if (listDate.warning) {
      ctx.report.warn(item, `${rowLabel}: ${listDate.warning}`);
    }

    const cost = num(cell(r, 'costPerUnit'));
    if (cost === null) ctx.report.blocker(item, `${rowLabel}: costPerUnit is blank`);
    else if (Number.isNaN(cost) || cost <= 0) ctx.report.blocker(item, `${rowLabel}: costPerUnit must be greater than 0`);

    const costCurrency = isoCurrency(cell(r, 'costCurrency'));
    if (!costCurrency) {
      ctx.report.blocker(item, `${rowLabel}: costCurrency "${norm(cell(r, 'costCurrency'))}" is not a valid ISO-4217 code`);
    } else if (supplier && supplier.currency && costCurrency !== supplier.currency) {
      ctx.report.warn(item, `${rowLabel}: costCurrency ${costCurrency} differs from the supplier baseCurrency ${supplier.currency}`);
    }

    const landed = num(cell(r, 'landedCost'));
    if (landed === null) ctx.report.blocker(item, `${rowLabel}: landedCost is blank`);
    else if (Number.isNaN(landed) || landed <= 0) ctx.report.blocker(item, `${rowLabel}: landedCost must be greater than 0`);

    const sell = num(cell(r, 'sellPrice'));
    if (sell === null) ctx.report.blocker(item, `${rowLabel}: sellPrice is blank`);
    else if (Number.isNaN(sell) || sell <= 0) ctx.report.blocker(item, `${rowLabel}: sellPrice must be greater than 0`);

    const sellCurrency = isoCurrency(cell(r, 'sellCurrency'));
    if (!sellCurrency) {
      ctx.report.blocker(item, `${rowLabel}: sellCurrency "${norm(cell(r, 'sellCurrency'))}" is not a valid ISO-4217 code`);
    }

    const fxRate = num(cell(r, 'fxRateToSell'));
    if (costCurrency && sellCurrency && costCurrency !== sellCurrency) {
      if (fxRate === null) ctx.report.blocker(item, `${rowLabel}: fxRateToSell is required when cost and sell currencies differ`);
      else if (Number.isNaN(fxRate) || fxRate <= 0) ctx.report.blocker(item, `${rowLabel}: fxRateToSell must be greater than 0`);
    } else {
      if (fxRate !== null && Number.isNaN(fxRate)) {
        ctx.report.blocker(item, `${rowLabel}: fxRateToSell is not a plain number`);
      } else if (fxRate !== null && Math.abs(fxRate - 1) > 0.001) {
        ctx.report.warn(item, `${rowLabel}: fxRateToSell is ${fxRate} but cost and sell currencies are the same`);
      }
    }

    const casePack = integer(cell(r, 'casePack'));
    if (casePack !== null && (Number.isNaN(casePack) || casePack < 1)) {
      ctx.report.blocker(item, `${rowLabel}: casePack must be a positive integer`);
    } else if (casePack === null) {
      const raw = ctx.rawBySupplier.get(code);
      if (raw && raw.unitsPerCase && raw.unitsPerCase > 1) {
        ctx.report.warn(item, `${rowLabel}: casePack is blank while the raw log says this supplier prices cases of ${raw.unitsPerCase}`);
      }
    }

    const markup = num(cell(r, 'markupPct'));
    if (markup !== null && (Number.isNaN(markup) || markup < 0)) {
      ctx.report.blocker(item, `${rowLabel}: markupPct must be a non-negative number`);
    }
    const rrp = num(cell(r, 'rrp'));
    if (rrp !== null && (Number.isNaN(rrp) || rrp <= 0)) {
      ctx.report.blocker(item, `${rowLabel}: rrp must be greater than 0 when supplied`);
    }
    const lead = integer(cell(r, 'leadTimeDays'));
    if (lead !== null && (Number.isNaN(lead) || lead < 0)) {
      ctx.report.blocker(item, `${rowLabel}: leadTimeDays must be a non-negative integer`);
    }

    const validUntil = parseDate(cell(r, 'validUntil'));
    if (validUntil.warning) ctx.report.warn(item, `${rowLabel}: validUntil ${validUntil.warning}`);
    if (validUntil.iso && listDate.iso && validUntil.iso < listDate.iso) {
      ctx.report.warn(item, `${rowLabel}: validUntil ${validUntil.iso} is before supplierListDate ${listDate.iso}`);
    }

    for (const f of Object.keys(missingRecommended)) {
      if (isBlank(cell(r, f))) missingRecommended[f] += 1;
    }

    if (code) ctx.preparedBySupplier.add(code);
  }

  for (const [f, count] of Object.entries(missingRecommended)) {
    if (count) ctx.report.warn(item, `${count} row(s) have no ${f} (recommended)`);
  }

  for (const code of ctx.rawBySupplier.keys()) {
    if (!ctx.preparedBySupplier.has(code)) {
      ctx.report.warn(item, `supplier ${code} has a raw list but no prepared-list rows`);
    }
  }

  ctx.report.ok(item, `${rows.length} prepared line(s) for ${[...ctx.preparedBySupplier].join(', ') || 'no supplier'}`);
}

// ------------------------------------------------------------ 05/06 offers

function parseOffer(sheet, kind) {
  const rows = rowsOf(sheet);
  const wanted = kind === 'company'
    ? ['line', 'product', 'qty', 'unitPriceSell', 'lineTotal']
    : ['line', 'product', 'qty', 'unitPrice', 'lineTotal'];

  let headerRow = -1;
  for (let i = 0; i < Math.min(rows.length, 80); i++) {
    const heads = (rows[i] || []).map(norm);
    if (wanted.every((w) => heads.some((h) => keyMatches(h, w)))) {
      headerRow = i;
      break;
    }
  }
  if (headerRow < 0) {
    return { error: `no line-item header row with ${wanted.join(', ')}` };
  }

  const header = (rows[headerRow] || []).map(norm);
  const cols = {};
  header.forEach((h, i) => {
    const k = normKey(h);
    if (k && cols[k] === undefined) cols[k] = i;
  });

  const getLabel = (label) => {
    const key = normKey(label);
    for (const row of rows.slice(0, headerRow)) {
      for (let i = 0; i < (row || []).length; i++) {
        if (normKey(row[i]) !== key) continue;
        for (let j = i + 1; j < Math.min(row.length, i + 4); j++) {
          if (!isBlank(row[j])) return row[j];
        }
      }
    }
    return '';
  };

  let totalsStart = rows.length;
  for (let i = headerRow + 1; i < rows.length; i++) {
    const keys = (rows[i] || []).map(normKey);
    if (keys.includes('subtotal') || keys.includes('total') || keys.some((k) => /^(freight|charges|shipping|other)/.test(k))) {
      totalsStart = i;
      break;
    }
  }

  const readAmount = (row, labelRe) => {
    for (let i = 0; i < (row || []).length; i++) {
      if (!labelRe.test(normKey(row[i]))) continue;
      for (let j = i + 1; j < row.length; j++) {
        const n = num(row[j]);
        if (n !== null && !Number.isNaN(n)) return n;
      }
    }
    return null;
  };

  let subtotal = null;
  let total = null;
  let charges = 0;
  let sawSubtotal = false;
  let sawTotal = false;
  for (let i = totalsStart; i < rows.length; i++) {
    const row = rows[i] || [];
    const sub = readAmount(row, /^subtotal$/);
    if (sub !== null) { subtotal = sub; sawSubtotal = true; }
    const tot = readAmount(row, /^total$/);
    if (tot !== null) { total = tot; sawTotal = true; }
    const charge = readAmount(row, /^(freight|charges|shipping|other)/);
    if (charge !== null) charges += charge;
  }

  const items = [];
  for (let i = headerRow + 1; i < totalsStart; i++) {
    const row = rows[i] || [];
    if (!row.some((v) => !isBlank(v))) continue;
    const obj = { __row: i + 1 };
    for (let c = 0; c < header.length; c++) {
      if (header[c]) obj[header[c]] = row[c] === undefined ? '' : row[c];
    }
    if (isExampleRow(obj)) continue;
    items.push(obj);
  }

  return {
    rows,
    header,
    headerRow: headerRow + 1,
    cols,
    items,
    subtotal,
    total,
    charges,
    sawSubtotal,
    sawTotal,
    getLabel,
  };
}

function parseOfferFile(file, kind, expectedSheet, report, item) {
  let wb;
  try {
    wb = readWorkbook(file);
  } catch (e) {
    report.blocker(item, `${path.basename(file)}: cannot read workbook (${e.message})`);
    return null;
  }
  let sheet = wb.Sheets[expectedSheet];
  if (!sheet) {
    const wanted = kind === 'company'
      ? ['line', 'product', 'qty', 'unitPriceSell', 'lineTotal']
      : ['line', 'product', 'qty', 'unitPrice', 'lineTotal'];
    for (const name of wb.SheetNames) {
      const rows = rowsOf(wb.Sheets[name]);
      if (rows.some((row) => wanted.every((w) => (row || []).map(norm).some((h) => keyMatches(h, w))))) {
        sheet = wb.Sheets[name];
        break;
      }
    }
  }
  if (!sheet) sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) {
    report.blocker(item, `${path.basename(file)}: workbook has no sheets`);
    return null;
  }
  const parsed = parseOffer(sheet, kind);
  if (parsed.error) {
    report.blocker(item, `${path.basename(file)}: ${parsed.error}`);
    return null;
  }
  return parsed;
}

function reconcileOffer(ctx, item, kind, parsed) {
  const computed = parsed.items.reduce((sum, obj) => {
    const lt = num(cell(obj, 'lineTotal'));
    if (lt !== null && !Number.isNaN(lt)) return sum + lt;
    const q = num(cell(obj, 'qty'));
    const p = num(field(obj, ['unitPriceSell', 'unitPrice']));
    if (q !== null && !Number.isNaN(q) && p !== null && !Number.isNaN(p)) return sum + q * p;
    return sum;
  }, 0);

  const tolerance = (x) => Math.max(0.02, Math.abs(x) * 0.005);
  let checked = 0;

  if (parsed.sawSubtotal) {
    if (parsed.subtotal === null) {
      ctx.report.warn(item, `${kind}: subtotal row has no numeric value`);
    } else {
      checked += 1;
      const diff = Math.abs(parsed.subtotal - computed);
      if (diff > tolerance(computed)) {
        ctx.report.blocker(item, `${kind}: subtotal ${parsed.subtotal} does not match the line sum ${computed.toFixed(2)}`);
      } else if (diff > 0.011) {
        ctx.report.warn(item, `${kind}: subtotal differs from the line sum by ${diff.toFixed(2)} (rounding?)`);
      }
    }
  }

  if (!parsed.sawTotal) {
    ctx.report.blocker(item, `${kind}: totals block has no TOTAL row`);
  } else if (parsed.total === null) {
    ctx.report.blocker(item, `${kind}: TOTAL row has no numeric value`);
  } else {
    checked += 1;
    const expected = (parsed.sawSubtotal && parsed.subtotal !== null ? parsed.subtotal : computed) + parsed.charges;
    const diff = Math.abs(parsed.total - expected);
    if (diff > tolerance(expected)) {
      ctx.report.blocker(item, `${kind}: TOTAL ${parsed.total} does not match ${expected.toFixed(2)}`);
    } else if (diff > 0.011) {
      ctx.report.warn(item, `${kind}: TOTAL differs from the calculated amount by ${diff.toFixed(2)} (rounding?)`);
    }
  }

  return { computed, checked };
}

function checkOfferItems(ctx, item, kind, parsed) {
  if (!parsed.items.length) {
    ctx.report.blocker(item, `${kind}: no real line items (all lines are examples or blank)`);
    return;
  }
  for (const obj of parsed.items) {
    const label = `${kind} line ${norm(cell(obj, 'line')) || obj.__row}`;
    const qty = num(cell(obj, 'qty'));
    if (qty === null) ctx.report.blocker(item, `${label}: qty is blank`);
    else if (Number.isNaN(qty) || qty <= 0) ctx.report.blocker(item, `${label}: qty must be greater than 0`);

    const price = num(field(obj, ['unitPriceSell', 'unitPrice']));
    if (price === null) ctx.report.blocker(item, `${label}: unit price is blank`);
    else if (Number.isNaN(price) || price <= 0) ctx.report.blocker(item, `${label}: unit price must be greater than 0`);

    const lineTotal = num(cell(obj, 'lineTotal'));
    if (lineTotal !== null && (Number.isNaN(lineTotal) || lineTotal <= 0)) {
      ctx.report.blocker(item, `${label}: lineTotal must be greater than 0`);
    }

    if (!norm(cell(obj, 'brand'))) ctx.report.blocker(item, `${label}: brand is blank`);
    if (!norm(cell(obj, 'product'))) ctx.report.blocker(item, `${label}: product is blank`);

    if (kind === 'company') {
      const code = norm(cell(obj, 'supplierCode')).toUpperCase();
      if (!code) ctx.report.blocker(item, `${label}: supplierCode is required on the company copy`);
      else if (!ctx.suppliers.has(code)) ctx.report.warn(item, `${label}: supplierCode ${code} is not in 01-supplier-master.xlsx`);

      for (const f of ['unitCost', 'landedUnitCost']) {
        const n = num(cell(obj, f));
        if (n === null) ctx.report.blocker(item, `${label}: ${f} is required on the company copy`);
        else if (Number.isNaN(n) || n <= 0) ctx.report.blocker(item, `${label}: ${f} must be greater than 0`);
      }
      for (const f of ['marginPct', 'markupPct']) {
        const n = num(cell(obj, f));
        if (n === null) ctx.report.warn(item, `${label}: ${f} is blank (recommended on the company copy)`);
        else if (Number.isNaN(n)) ctx.report.blocker(item, `${label}: ${f} is not a plain number`);
      }
    }
  }
}

function checkOffers(ctx) {
  const item = '05/06 offers';
  const companyFile = findNamedFile(ctx.dir, '05-offer-company-copy.xlsx', ['offers']);
  const customerFile = findNamedFile(ctx.dir, '06-offer-customer-copy.xlsx', ['offers']);

  if (!companyFile) ctx.report.blocker(item, 'missing 05-offer-company-copy.xlsx (root or offers/)');
  if (!customerFile) ctx.report.blocker(item, 'missing 06-offer-customer-copy.xlsx (root or offers/)');

  const company = companyFile ? parseOfferFile(companyFile, 'company', 'Offer-Internal', ctx.report, item) : null;
  const customer = customerFile ? parseOfferFile(customerFile, 'customer', 'Offer-Customer', ctx.report, item) : null;

  if (companyFile && company) {
    ctx.report.ok(item, `found ${rel(ctx.dir, companyFile)} (header row ${company.headerRow})`);
    const compact = company.header.map(compactKey);
    for (const col of ['suppliercode', 'unitcost', 'landedunitcost']) {
      if (!compact.includes(col)) {
        ctx.report.blocker(item, `company copy: line-item column "${col}" is missing — internal cost data is required`);
      }
    }
    for (const col of ['marginpct', 'markuppct']) {
      if (!compact.includes(col)) ctx.report.warn(item, `company copy: line-item column "${col}" is missing (recommended)`);
    }
    const ref = norm(company.getLabel('offer reference'));
    const currency = isoCurrency(company.getLabel('currency'));
    if (!ref) ctx.report.warn(item, 'company copy: offer reference is missing');
    if (!currency) ctx.report.blocker(item, 'company copy: currency is missing or not ISO-4217');
    if (!norm(company.getLabel('date'))) ctx.report.warn(item, 'company copy: date is missing');
    if (!norm(company.getLabel('valid until'))) ctx.report.warn(item, 'company copy: valid-until date is missing');
    if (!norm(company.getLabel('customer code')) && !norm(company.getLabel('customer name'))) {
      ctx.report.warn(item, 'company copy: customer code/name is missing');
    }
    checkOfferItems(ctx, item, 'company', company);
    if (company.items.length) reconcileOffer(ctx, item, 'company', company);
  }

  if (customerFile && customer) {
    ctx.report.ok(item, `found ${rel(ctx.dir, customerFile)} (header row ${customer.headerRow})`);

    const forbiddenHeaders = customer.header
      .map(compactKey)
      .filter((h) => OFFER_FORBIDDEN_TOKENS.includes(h));
    if (forbiddenHeaders.length) {
      ctx.report.blocker(item, `customer copy: forbidden internal column(s): ${forbiddenHeaders.join(', ')}`);
    }

    // Also catch cost/margin values hidden in a differently-named column or a
    // stray cell: the customer copy must never contain these tokens.
    const allText = [];
    for (const row of customer.rows) {
      for (const v of row || []) allText.push(compactKey(v));
    }
    const leaked = allText.filter((t) => OFFER_FORBIDDEN_TOKENS.some((token) => t.includes(token)));
    if (leaked.length) {
      ctx.report.blocker(item, `customer copy: cost/margin data leaked (${[...new Set(leaked)].join(', ')})`);
    }

    const internalLabels = OFFER_INTERNAL_LABELS.filter((label) => !isBlank(customer.getLabel(label)));
    if (internalLabels.length) {
      ctx.report.warn(item, `customer copy: internal header label(s) present: ${internalLabels.join(', ')}`);
    }

    const ref = norm(customer.getLabel('offer reference'));
    const currency = isoCurrency(customer.getLabel('currency'));
    if (!ref) ctx.report.warn(item, 'customer copy: offer reference is missing');
    if (!currency) ctx.report.blocker(item, 'customer copy: currency is missing or not ISO-4217');
    if (!norm(customer.getLabel('date'))) ctx.report.warn(item, 'customer copy: date is missing');
    if (!norm(customer.getLabel('valid until'))) ctx.report.warn(item, 'customer copy: valid-until date is missing');
    if (!norm(customer.getLabel('customer'))) ctx.report.warn(item, 'customer copy: customer name is missing');

    checkOfferItems(ctx, item, 'customer', customer);
    if (customer.items.length) reconcileOffer(ctx, item, 'customer', customer);
  }

  if (company && customer) {
    const companyRef = norm(company.getLabel('offer reference'));
    const customerRef = norm(customer.getLabel('offer reference'));
    if (companyRef && customerRef && companyRef.toLowerCase() !== customerRef.toLowerCase()) {
      ctx.report.warn(item, `offer references differ between copies: ${companyRef} vs ${customerRef}`);
    }

    const companyCurrency = isoCurrency(company.getLabel('currency'));
    const customerCurrency = isoCurrency(customer.getLabel('currency'));
    if (companyCurrency && customerCurrency && companyCurrency !== customerCurrency) {
      ctx.report.warn(item, `currencies differ between copies: ${companyCurrency} vs ${customerCurrency}`);
    }

    const companyName = norm(company.getLabel('customer name'));
    const customerName = norm(customer.getLabel('customer'));
    if (companyName && customerName && companyName.toLowerCase() !== customerName.toLowerCase()) {
      ctx.report.warn(item, `customer names differ between copies: ${companyName} vs ${customerName}`);
    }

    const companyLines = company.items.map((o) => num(cell(o, 'lineTotal'))).filter((n) => n !== null && !Number.isNaN(n));
    const customerLines = customer.items.map((o) => num(cell(o, 'lineTotal'))).filter((n) => n !== null && !Number.isNaN(n));
    if (companyLines.length !== customerLines.length) {
      ctx.report.warn(item, `line counts differ between copies: ${companyLines.length} internal vs ${customerLines.length} customer`);
    } else {
      for (let i = 0; i < companyLines.length; i++) {
        if (Math.abs(companyLines[i] - customerLines[i]) > 0.02) {
          ctx.report.warn(item, `line ${i + 1} total differs between copies: ${companyLines[i]} vs ${customerLines[i]}`);
        }
      }
    }

    const code = norm(company.getLabel('customer code')).toUpperCase();
    const master = code ? ctx.customers.get(code) : null;
    if (code && !master) {
      ctx.report.warn(item, `company copy customer code ${code} is not in 02-customer-master.xlsx`);
    }
    if (master && customerCurrency && master.currency && customerCurrency !== master.currency) {
      ctx.report.warn(item, `customer copy currency ${customerCurrency} differs from the customer master currency ${master.currency}`);
    }
    if (customerName) {
      const byName = ctx.customerByName.get(customerName.toLowerCase());
      if (!byName) ctx.report.warn(item, `customer copy name "${customerName}" is not in 02-customer-master.xlsx`);
      else if (customerCurrency && byName.currency && customerCurrency !== byName.currency) {
        ctx.report.warn(item, `customer copy currency ${customerCurrency} differs from the customer master currency ${byName.currency}`);
      }
    }
  }
}

// ------------------------------------------------------------- 07 naming

function patternMatchesExample(pattern, example) {
  if (!pattern || !example) return true;
  if (!/\{[^}]+\}/.test(pattern) || /\s/.test(pattern)) return true;
  let src = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  src = src.replace(/\\\{[^}]+\\\}/g, '.+?');
  try {
    return new RegExp('^' + src + '(?:\\.[A-Za-z0-9]+)?$', 'i').test(example);
  } catch {
    return true;
  }
}

function checkNaming(ctx) {
  const item = '07 document naming';
  const file = findNamedFile(ctx.dir, '07-document-naming.xlsx');
  if (!file) {
    ctx.report.blocker(item, 'missing 07-document-naming.xlsx');
    return;
  }
  ctx.report.ok(item, `found ${rel(ctx.dir, file)}`);

  const required = ['documentType', 'pattern'];
  const table = openTable(file, 'Naming', required, ctx.report, item);
  if (!table) return;
  if (!table.header) {
    ctx.report.blocker(item, 'no header row with the required columns: documentType, pattern');
    return;
  }
  ctx.report.ok(item, `header row ${table.headerRow}`);

  const rows = table.rows;
  if (!rows.length) {
    ctx.report.blocker(item, 'naming sheet has no rows');
    return;
  }

  const blankCurrent = [];
  const seenTypes = new Map();
  for (const r of rows) {
    const docType = norm(cell(r, 'documentType'));
    const label = docType || `row ${r.__row}`;
    const pattern = norm(cell(r, 'pattern'));
    if (!docType) ctx.report.warn(item, `${label}: documentType is blank`);
    if (!pattern) {
      ctx.report.blocker(item, `${label}: pattern is blank`);
    }

    if (docType) {
      const key = docType.toLowerCase();
      if (seenTypes.has(key)) ctx.report.warn(item, `${label}: duplicate documentType (also row ${seenTypes.get(key)})`);
      else seenTypes.set(key, r.__row);
    }

    if (!norm(cell(r, 'yourCurrentNamePattern'))) blankCurrent.push(label);

    const example = norm(cell(r, 'example'));
    if (!example) {
      ctx.report.warn(item, `${label}: example is blank`);
    } else if (pattern && !patternMatchesExample(pattern, example)) {
      ctx.report.warn(item, `${label}: example "${example}" does not match pattern "${pattern}"`);
    }

    const audience = norm(cell(r, 'audience')).toLowerCase();
    const confidential = norm(cell(r, 'containsConfidential')).toLowerCase();
    if (docType && /offer/i.test(docType)) {
      if (/internal|company/.test(docType) && audience.includes('customer') && !confidential.startsWith('yes')) {
        ctx.report.warn(item, `${label}: internal offer should be marked containsConfidential=YES`);
      }
      if (/customer/.test(docType) && confidential.startsWith('yes')) {
        ctx.report.warn(item, `${label}: customer-facing offer must not be marked confidential`);
      }
    }
  }

  if (blankCurrent.length) {
    ctx.report.warn(item, `${blankCurrent.length} row(s) have no yourCurrentNamePattern (e.g. ${blankCurrent.slice(0, 3).join('; ')})`);
  }

  const requiredTypes = [
    ['supplier raw price list', /supplier raw|raw price/i],
    ['prepared price list', /prepared price/i],
    ['offer company copy', /company copy|internal/i],
    ['offer customer copy', /customer copy/i],
    ['customer purchase order', /purchase order|\bPO\b/i],
    ['process capture', /process capture/i],
  ];
  const docTypes = rows.map((r) => norm(cell(r, 'documentType'))).filter(Boolean);
  for (const [label, re] of requiredTypes) {
    if (!docTypes.some((t) => re.test(t))) {
      ctx.report.warn(item, `no naming row found for ${label}`);
    }
  }

  ctx.report.ok(item, `${rows.length} document type(s) covered`);
}

// ----------------------------------------------------------- 08 captures

function readDeferrals(ctx) {
  const names = ['deferrals.md', 'deferrals.txt', 'unavailable.md', 'unavailable.txt', 'DEFERRED.txt', 'deferred.txt'];
  const texts = [];
  for (const base of [ctx.dir, path.join(ctx.dir, 'process-captures')]) {
    for (const name of names) {
      const f = path.join(base, name);
      if (fs.existsSync(f)) {
        try { texts.push(fs.readFileSync(f, 'utf8')); } catch { /* ignore */ }
      }
    }
  }
  const text = texts.join('\n');
  const ids = new Set((text.match(/\bP\d{1,2}\b/gi) || []).map((s) => s.toUpperCase()));
  return { text, ids, all: /\ball\b|everything|entire (package|capture set)/i.test(text) };
}

function checkCaptures(ctx) {
  const item = '08 process captures';
  const file = findNamedFile(ctx.dir, '08-process-capture-checklist.xlsx');
  if (!file) {
    ctx.report.blocker(item, 'missing 08-process-capture-checklist.xlsx');
    return;
  }
  ctx.report.ok(item, `found ${rel(ctx.dir, file)}`);

  const required = ['id', 'process'];
  const table = openTable(file, 'Processes', required, ctx.report, item);
  if (!table) return;
  if (!table.header) {
    ctx.report.blocker(item, 'no header row with the required columns: id, process');
    return;
  }
  ctx.report.ok(item, `header row ${table.headerRow}`);

  const deferrals = readDeferrals(ctx);
  const expected = Array.from({ length: 11 }, (_, i) => `P${i + 1}`);
  const present = new Map();
  let blankTools = 0;
  for (const r of table.rows) {
    const id = norm(cell(r, 'id')).toUpperCase();
    if (!id) {
      ctx.report.warn(item, `row ${r.__row}: id is blank`);
      continue;
    }
    if (present.has(id)) {
      ctx.report.warn(item, `${id}: duplicate process id (also row ${present.get(id).row})`);
    }
    present.set(id, { row: r.__row, record: r });
    if (!norm(cell(r, 'process'))) ctx.report.blocker(item, `${id}: process description is blank`);
    if (!norm(cell(r, 'fileNaming'))) ctx.report.warn(item, `${id}: fileNaming is blank`);
    if (!norm(cell(r, 'captureType'))) ctx.report.warn(item, `${id}: captureType is blank`);
    if (!norm(cell(r, 'currentTools'))) blankTools += 1;

    const received = parseDate(cell(r, 'receivedDate'));
    if (received.warning) ctx.report.warn(item, `${id}: receivedDate ${received.warning}`);
  }

  for (const id of expected) {
    if (!present.has(id)) {
      if (deferrals.ids.has(id) || deferrals.all) {
        ctx.report.warn(item, `${id}: missing from the sheet but explicitly deferred`);
      } else {
        ctx.report.blocker(item, `${id}: missing from the capture plan`);
      }
    }
  }

  if (blankTools === table.rows.length && table.rows.length) {
    ctx.report.warn(item, 'currentTools column is empty — fill it as you capture each process');
  }

  const mediaDir = path.join(ctx.dir, 'process-captures');
  const media = fs.existsSync(mediaDir)
    ? listFilesRecursive(mediaDir).filter((f) => MEDIA_EXT.test(f))
    : [];

  if (!media.length) {
    if (deferrals.all) {
      ctx.report.warn(item, 'process captures explicitly deferred (no process-captures/ media yet)');
    } else {
      ctx.report.blocker(item, 'no process-captures/ media found (if you only capture three, do P3, P6 and P7)');
    }
  } else {
    const byProcess = new Map();
    for (const f of media) {
      const base = path.basename(f);
      const m = /\bP(\d{1,2})\b/i.exec(base);
      if (m) {
        const id = `P${Number(m[1])}`;
        if (!byProcess.has(id)) byProcess.set(id, []);
        byProcess.get(id).push(f);
      }
      if (!/^PROC-P\d{1,2}_.+\.(mp4|mov|avi|mkv|webm|png|jpe?g|gif|pdf)$/i.test(base)) {
        ctx.report.warn(item, `${base}: does not follow PROC-{processId}_{step}_{YYYYMMDD}.ext`);
      }
    }
    for (const id of expected) {
      if (!byProcess.has(id)) {
        if (deferrals.ids.has(id) || deferrals.all) ctx.report.warn(item, `${id}: no media file (explicitly deferred)`);
        else ctx.report.warn(item, `${id}: no media file found in process-captures/`);
      }
    }
    ctx.report.ok(item, `${media.length} media file(s) for ${byProcess.size} process(es)`);
  }

  ctx.report.ok(item, `${table.rows.length} process row(s) in the capture plan`);
}

// ----------------------------------------------------------- 09 formulas

function checkFormulas(ctx) {
  const item = '09 VLOOKUP formulas';
  const file = findNamedFile(ctx.dir, '09-vlookup-formulas.xlsx');
  if (!file) {
    ctx.report.blocker(item, 'missing 09-vlookup-formulas.xlsx');
    return;
  }
  ctx.report.ok(item, `found ${rel(ctx.dir, file)}`);

  const required = ['formulaText', 'businessPurpose'];
  const table = openTable(file, 'Formulas', required, ctx.report, item);
  if (!table) return;
  if (!table.header) {
    ctx.report.blocker(item, 'no header row with the required columns: formulaText, businessPurpose');
    return;
  }
  ctx.report.ok(item, `header row ${table.headerRow}`);

  const rows = table.rows.filter((r) => {
    const id = norm(cell(r, 'id')).toUpperCase();
    if (id === 'F01' || id === 'F02') return false;
    const all = Object.keys(r)
      .filter((k) => !k.startsWith('__'))
      .map((k) => norm(r[k]))
      .join(' ');
    return !/example rows above/i.test(all) && !isExampleRow(r);
  });

  if (!rows.length) {
    ctx.report.blocker(item, 'no real formulas (only the template example rows F01/F02 remain)');
    return;
  }

  for (const r of rows) {
    const label = norm(cell(r, 'id')) || `row ${r.__row}`;
    const formulaText = norm(cell(r, 'formulaText'));
    const purpose = norm(cell(r, 'businessPurpose'));
    if (!formulaText) ctx.report.blocker(item, `${label}: formulaText is blank`);
    if (!purpose) ctx.report.blocker(item, `${label}: businessPurpose is blank`);
    else if (purpose.split(/\s+/).length < 3) ctx.report.warn(item, `${label}: businessPurpose is too short to explain the formula`);

    if (!norm(cell(r, 'workbookFile'))) ctx.report.warn(item, `${label}: workbookFile is blank`);
    if (!norm(cell(r, 'sheetName'))) ctx.report.warn(item, `${label}: sheetName is blank`);
    if (!norm(cell(r, 'cellOrColumn'))) ctx.report.warn(item, `${label}: cellOrColumn is blank`);

    if (/#REF!|#NAME\?/i.test(formulaText)) ctx.report.warn(item, `${label}: formula contains a broken reference`);
    if (formulaText && !formulaText.startsWith('=')) ctx.report.warn(item, `${label}: formulaText does not start with "="`);

    const processId = norm(cell(r, 'relatedProcessId')).toUpperCase();
    if (processId && !/^P([1-9]|1[01])$/.test(processId)) {
      ctx.report.warn(item, `${label}: relatedProcessId "${processId}" is not P1-P11`);
    }
  }

  ctx.report.ok(item, `${rows.length} real formula row(s)`);
}

// ------------------------------------------------------------- entry points

function validatePackage(dir, opts = {}) {
  const base = String(opts.base || DEFAULT_BASE).toUpperCase();
  const resolved = path.resolve(dir);
  const report = createReport();
  const ctx = {
    dir: resolved,
    base,
    report,
    suppliers: new Map(),
    customers: new Map(),
    customerByName: new Map(),
    ratePairs: new Set(),
    rawBySupplier: new Map(),
    preparedBySupplier: new Set(),
  };

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    report.blocker('package', `directory not found: ${resolved}`);
    return buildResult(ctx);
  }
  if (!ISO_CURRENCIES.has(base)) {
    report.blocker('package', `base currency "${base}" is not a valid ISO-4217 code`);
    return buildResult(ctx);
  }

  const sections = [
    checkSuppliers,
    checkCustomers,
    checkFx,
    checkRawLog,
    checkPrepared,
    checkOffers,
    checkNaming,
    checkCaptures,
    checkFormulas,
  ];
  for (const section of sections) {
    try {
      section(ctx);
    } catch (e) {
      report.blocker(section.name, `internal error: ${e.message}`);
    }
  }
  return buildResult(ctx);
}

function parseArgs(argv) {
  const out = { dir: null, base: DEFAULT_BASE, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--base') {
      i += 1;
      out.base = argv[i];
    } else if (a.startsWith('--base=')) out.base = a.slice(7);
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else out.dir = a;
  }
  return out;
}

function printUsage() {
  console.log('Usage: npm run check:client -- <package-dir> [--base USD] [--json]');
  console.log('');
  console.log('  <package-dir>  folder returned by the client (the 9-item pack + 10-fx-rates.xlsx)');
  console.log('  --base         company base currency (default USD)');
  console.log('  --json         machine-readable output');
  console.log('');
  console.log('Exit code: 0 = no blockers, 1 = blockers found, 2 = bad arguments.');
}

function printHuman(result) {
  console.log(`Client data package: ${result.dir}`);
  console.log(`Company base currency: ${result.base}`);
  console.log('');
  for (const c of result.checks) {
    const tag = c.level === 'OK' ? '[OK]     ' : c.level === 'WARN' ? '[WARN]   ' : '[BLOCKER]';
    console.log(`${tag} ${c.item} — ${c.message}`);
  }
  console.log('');
  console.log(`Summary: ${result.summary.blockers} blocker(s), ${result.summary.warnings} warning(s), ${result.summary.passed} check(s) passed`);
  if (result.ok) console.log('Package passes the intake checks. Safe to start the import.');
  else console.log('Fix the [BLOCKER] items and re-run.');
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    printUsage();
    process.exit(2);
  }
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.dir) {
    printUsage();
    process.exit(2);
  }
  const base = String(args.base || DEFAULT_BASE).toUpperCase();
  if (!ISO_CURRENCIES.has(base)) {
    console.error(`Unknown base currency "${args.base}". Use an ISO-4217 code.`);
    process.exit(2);
  }
  const result = validatePackage(args.dir, { base });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  validatePackage,
  parseArgs,
  parseDate,
  parseOffer,
  patternMatchesExample,
  DEFAULT_BASE,
  ISO_CURRENCIES,
};
