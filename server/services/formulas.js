'use strict';

// Deterministic spreadsheet formula evaluation.
//
// Uploaded .xlsx files used to be read as their cached values, so a supplier
// sheet whose prices were computed with VLOOKUP/XLOOKUP arrived as whatever the
// sending machine last cached (or as blank). HyperFormula evaluates the real
// formulas here instead. The same engine backs the AI tools, so a number the
// assistant reports is computed by the engine, never invented by the model.
//
// Bound every input: a hostile workbook or a long AI-generated formula must
// not be able to allocate unbounded memory inside the request.

const XLSX = require('xlsx');
const HF = require('hyperformula');
const HyperFormula = HF.HyperFormula || (HF.default && HF.default.HyperFormula);

const LANG = 'enUS';
try {
  const languages = require('hyperformula/i18n/languages');
  if (languages && languages[LANG]) HyperFormula.registerLanguage(LANG, languages[LANG]);
} catch (_) {
  // Already registered, or an older build without the language pack: the
  // built-in enGB still evaluates every function, only TRUE/FALSE literals
  // need normalising (handled in normalizeFormula).
}

const LIMITS = {
  formulaChars: 8000,
  rows: 20000,
  cols: 256,
  cells: 200000,
  argItems: 10000,
};

let cachedNames = null;

function config() {
  return { licenseKey: 'gpl-v3', language: LANG };
}

// Excel accepts bare TRUE/FALSE; HyperFormula expects TRUE()/FALSE(). Skip
// quoted text so a supplier description containing "FALSE" is untouched.
function normalizeFormula(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s.startsWith('=')) s = '=' + s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '"') {
      out += s[i++];
      while (i < s.length) {
        out += s[i];
        if (s[i] === '"') {
          if (s[i + 1] === '"') { out += s[i + 1]; i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    const m = /^(TRUE|FALSE)\b(?!\s*\()/i.exec(s.slice(i));
    if (m && (i === 0 || !/[A-Za-z0-9_.]/.test(s[i - 1]))) {
      out += m[1].toUpperCase() + '()';
      i += m[0].length;
      continue;
    }
    out += s[i++];
  }
  return out;
}

function functionNames() {
  if (!cachedNames) {
    cachedNames = HyperFormula.getRegisteredFunctionNames(LANG).slice().sort();
  }
  return cachedNames;
}

function errorOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.value === 'string' && /^#/.test(raw.value)) {
    return raw.message ? `${raw.value} (${raw.message})` : raw.value;
  }
  return null;
}

function scalar(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (errorOf(v)) return errorOf(v);
    if (v.value !== undefined && typeof v.value !== 'object') return v.value;
    return String(v);
  }
  return String(v).slice(0, 1000);
}

function serialize(raw) {
  if (Array.isArray(raw)) return raw.map((row) => (Array.isArray(row) ? row.map(scalar) : scalar(row)));
  if (raw && typeof raw.values === 'function') return serialize(raw.values());
  return scalar(raw);
}

function normalizeCell(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.slice(0, 5000);
  if (Array.isArray(v)) return v.slice(0, LIMITS.argItems).map(normalizeCell);
  if (typeof v === 'object') {
    if (v.value !== undefined && typeof v.value !== 'object') return normalizeCell(v.value);
    return String(v).slice(0, 5000);
  }
  return String(v).slice(0, 5000);
}

// A text cell starting with '=' would be parsed as a formula by the engine;
// prefixing with an apostrophe keeps it as literal text (Excel does the same).
function cellValue(v) {
  const value = normalizeCell(v);
  if (typeof value === 'string' && value.startsWith('=')) return "'" + value;
  return value;
}

function prepareGrid(values) {
  if (values == null) return [[]];
  if (!Array.isArray(values)) throw new Error('values must be an array of rows');
  if (values.length > LIMITS.rows) throw new Error(`values exceed ${LIMITS.rows} rows`);
  let cells = 0;
  const grid = values.slice(0, LIMITS.rows).map((row) => {
    const cellsRow = Array.isArray(row) ? row : [row];
    if (cellsRow.length > LIMITS.cols) cellsRow.length = LIMITS.cols;
    cells += cellsRow.length;
    if (cells > LIMITS.cells) throw new Error(`values exceed ${LIMITS.cells} cells`);
    return cellsRow.map(cellValue);
  });
  return grid.length ? grid : [[]];
}

function evaluateInGrid(formula, grid) {
  const text = normalizeFormula(formula);
  if (text.length > LIMITS.formulaChars) throw new Error(`formula exceeds ${LIMITS.formulaChars} characters`);
  const hf = HyperFormula.buildFromSheets({ Sheet1: grid }, config());
  try {
    const raw = hf.calculateFormula(text, 0);
    const error = errorOf(raw);
    return { formula: text, value: error ? null : serialize(raw), error };
  } finally {
    hf.destroy();
  }
}

// Evaluate one formula, optionally against a caller-supplied value grid placed
// at A1. Used by the AI tools and by tests; the import path uses evaluateWorkbook.
function evaluateFormula(formula, values) {
  return evaluateInGrid(formula, prepareGrid(values));
}

function scalarArg(v) {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite numbers are not valid function arguments');
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE()' : 'FALSE()';
  if (typeof v === 'object') {
    if (v.value !== undefined && typeof v.value !== 'object') return scalarArg(v.value);
    throw new Error('objects are not valid function arguments');
  }
  return '"' + String(v).replace(/"/g, '""') + '"';
}

function colLabel(index) {
  let label = '';
  let n = index + 1;
  while (n > 0) {
    label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

function rangeRef(r0, r1, c0, c1) {
  const start = colLabel(c0) + (r0 + 1);
  const end = colLabel(c1) + (r1 + 1);
  return start === end ? start : `${start}:${end}`;
}

// HyperFormula's lookup functions require a real cell range: an array literal
// such as VLOOKUP(2,{1,10;2,20},2,0) fails with #VALUE!. Write every array
// argument into the engine grid and pass the range address instead. Scalars
// stay inline. Each array gets its own rows so ranges can never overlap.
function buildArgCall(list) {
  const grid = [[]];
  const parts = [];
  let nextRow = 0;
  let usedCells = 0;
  for (const arg of list) {
    if (!Array.isArray(arg)) {
      parts.push(scalarArg(arg));
      continue;
    }
    const matrix = arg.length && Array.isArray(arg[0]) ? arg : arg.map((item) => [item]);
    const rows = matrix.length;
    const cols = matrix.reduce((m, row) => Math.max(m, Array.isArray(row) ? row.length : 1), 0);
    if (!rows || !cols) throw new Error('empty array arguments are not supported');
    if (rows > LIMITS.rows || cols > LIMITS.cols) throw new Error('array argument is too large');
    usedCells += rows * cols;
    if (usedCells > LIMITS.cells) throw new Error(`array arguments exceed ${LIMITS.cells} cells`);
    for (let r = 0; r < rows; r++) {
      while (grid.length <= nextRow + r) grid.push([]);
      const row = Array.isArray(matrix[r]) ? matrix[r] : [matrix[r]];
      for (let c = 0; c < cols; c++) grid[nextRow + r][c] = cellValue(row[c]);
    }
    parts.push(rangeRef(nextRow, nextRow + rows - 1, 0, cols - 1));
    nextRow += rows;
  }
  return { formula: '(' + parts.join(',') + ')', grid };
}

// Call any registered Excel function by name. The function name is checked
// against the engine's own catalogue so it can never inject arbitrary code.
function callFunction(functionName, args) {
  const name = String(functionName || '').trim().toUpperCase();
  if (!functionNames().includes(name)) throw new Error('unknown Excel function: ' + name);
  if (args != null && !Array.isArray(args)) throw new Error('args must be an array');
  const list = (args || []).slice(0, 50);
  const built = buildArgCall(list);
  return evaluateInGrid('=' + name + built.formula, built.grid);
}

function listFunctions(query, limit) {
  const q = String(query || '').trim().toUpperCase();
  const all = functionNames();
  const matched = q ? all.filter((n) => n.includes(q)) : all;
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return { totalFunctions: all.length, matched: matched.length, names: matched.slice(0, n) };
}

// Evaluate the formulas in a workbook and return the computed value of every
// formula cell. Non-formula cells are left alone by the caller. Sheet names are
// preserved so cross-sheet references keep working wherever HyperFormula
// accepts them; a fallback name is used for names it rejects.
function evaluateWorkbook(input) {
  const wb = typeof input === 'string'
    ? XLSX.readFile(input, { cellDates: false, cellNF: false, cellFormula: true })
    : input;
  const result = { hadFormulas: false, formulaCount: 0, sheets: {}, errors: [] };
  if (!wb || !wb.SheetNames) return result;

  const sheets = {};
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rows = range.e.r + 1;
    const cols = range.e.c + 1;
    if (rows > LIMITS.rows || cols > LIMITS.cols || rows * cols > LIMITS.cells) {
      result.errors.push(`sheet ${name}: too large to evaluate (${rows}x${cols}); cached values kept`);
      continue;
    }

    const grid = [];
    const formulaCells = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell && typeof cell.f === 'string' && cell.f.length) {
          const text = normalizeFormula(cell.f);
          row.push(text);
          formulaCells.push({ row: r, col: c, formula: text });
        } else {
          row.push(cellValue(cell && cell.v !== undefined ? cell.v : ''));
        }
      }
      grid.push(row);
    }
    sheets[name] = { grid, formulaCells };
    if (formulaCells.length) {
      result.hadFormulas = true;
      result.formulaCount += formulaCells.length;
    }
  }
  if (!Object.values(sheets).some((s) => s.formulaCells.length)) return result;

  // Build every sheet together so formulas that reference another sheet keep
  // working. A workbook with a name the engine rejects is retried with safe
  // generated names; local formulas still evaluate in that fallback.
  const nameMap = {};
  const allSheets = {};
  for (const name of Object.keys(sheets)) { allSheets[name] = sheets[name].grid; nameMap[name] = name; }
  let hf;
  try {
    hf = HyperFormula.buildFromSheets(allSheets, config());
  } catch (_) {
    const safe = {};
    Object.keys(sheets).forEach((name, i) => {
      const key = 'Sheet' + (i + 1);
      safe[key] = sheets[name].grid;
      nameMap[name] = key;
    });
    try {
      hf = HyperFormula.buildFromSheets(safe, config());
      result.errors.push('sheet names were normalised for evaluation; cross-sheet references may need review');
    } catch (e) {
      result.errors.push('workbook could not be evaluated: ' + e.message + '; cached values kept');
      return result;
    }
  }
  try {
    for (const name of Object.keys(sheets)) {
      const { formulaCells } = sheets[name];
      if (!formulaCells.length) continue;
      const values = hf.getSheetValues(hf.getSheetId(nameMap[name]));
      const computed = formulaCells.map((fc) => {
        const raw = values[fc.row] && values[fc.row][fc.col];
        const error = errorOf(raw);
        if (error) result.errors.push(`${name}!${XLSX.utils.encode_cell({ r: fc.row, c: fc.col })}: ${error}`);
        return { row: fc.row, col: fc.col, formula: fc.formula, value: error ? null : serialize(raw), error };
      });
      result.sheets[name] = computed;
    }
  } finally {
    hf.destroy();
  }
  return result;
}

module.exports = {
  LIMITS,
  evaluateFormula,
  callFunction,
  listFunctions,
  evaluateWorkbook,
  normalizeFormula,
  functionNames,
};
