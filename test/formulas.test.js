'use strict';
// Spreadsheet formulas are evaluated by a real engine, both on upload and in
// the assistant. The model never supplies a number that the engine did not
// compute, and a formula error is never silently turned into a zero.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test } = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx');

const formulas = require('../server/services/formulas');
const ai = require('../server/services/ai');
const { extract } = require('../src/importers/genericImporter');

test('engine registers the full Excel catalogue including VLOOKUP and XLOOKUP', () => {
  const names = formulas.functionNames();
  assert.ok(names.length >= 400, `expected 400+ functions, got ${names.length}`);
  assert.ok(names.includes('VLOOKUP'));
  assert.ok(names.includes('XLOOKUP'));
  assert.ok(names.includes('SUMIFS'));
  assert.ok(names.includes('INDEX'));
  assert.ok(names.includes('MATCH'));
  const listed = formulas.listFunctions('LOOKUP');
  assert.ok(listed.names.includes('VLOOKUP') && listed.names.includes('XLOOKUP'));
  assert.ok(listed.totalFunctions >= 400);
});

test('evaluateFormula computes VLOOKUP with FALSE/TRUE literals', () => {
  const values = [['banana', 5], ['apple', 12], ['pear', 8]];
  const out = formulas.evaluateFormula('=VLOOKUP("apple",A1:B3,2,FALSE)', values);
  assert.strictEqual(out.error, null);
  assert.strictEqual(out.value, 12);
});

test('evaluateFormula computes XLOOKUP and other functions', () => {
  const values = [['banana', 5], ['apple', 12], ['pear', 8]];
  const out = formulas.evaluateFormula('XLOOKUP("pear",A1:A3,B1:B3)', values);
  assert.strictEqual(out.error, null);
  assert.strictEqual(out.value, 8);
  const sum = formulas.evaluateFormula('SUM(A1:A3)', [[1], [2], [3]]);
  assert.strictEqual(sum.value, 6);
});

test('callFunction accepts named functions and array-range arguments', () => {
  const out = formulas.callFunction('SUM', [[[1, 2], [3, 4]]]);
  assert.strictEqual(out.error, null);
  assert.strictEqual(out.value, 10);
  const match = formulas.callFunction('MATCH', [2, [[1], [2], [3]], 0]);
  assert.strictEqual(match.value, 2);
});

test('unknown functions and bad formulas fail explicitly', () => {
  assert.throws(() => formulas.callFunction('NOT_A_REAL_FUNCTION', []), /unknown Excel function/);
  assert.throws(() => formulas.evaluateFormula('x'.repeat(9000)), /exceeds/);
  assert.throws(() => formulas.evaluateFormula('=SUM(A1:A2)', Array.from({ length: 25000 }, () => [1])), /rows/);
});

test('evaluateWorkbook computes formula cells and surfaces errors', () => {
  const ws = XLSX.utils.aoa_to_sheet([['key', 'value', '', 'calculated'], [1, 10], [2, 20]]);
  ws['D2'] = { t: 'n', f: 'VLOOKUP(2,A1:B3,2,0)', v: 0 };
  ws['D3'] = { t: 'n', f: '1/0', v: 0 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Prices');
  const file = path.join(os.tmpdir(), `ptp-formulas-${process.pid}.xlsx`);
  XLSX.writeFile(wb, file);
  try {
    const out = formulas.evaluateWorkbook(file);
    assert.strictEqual(out.formulaCount, 2);
    const cells = out.sheets.Prices;
    const d1 = cells.find((c) => c.row === 1 && c.col === 3);
    const d2 = cells.find((c) => c.row === 2 && c.col === 3);
    assert.strictEqual(d1.value, 20);
    assert.strictEqual(d1.error, null);
    assert.ok(/^#/.test(d2.error));
    assert.strictEqual(d2.value, null);
  } finally {
    try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
  }
});

test('evaluateWorkbook resolves cross-sheet lookups and labels error cells', () => {
  const lookup = XLSX.utils.aoa_to_sheet([['key', 'price'], [1, 10], [2, 20]]);
  const prices = XLSX.utils.aoa_to_sheet([['name', 'cost', '', 'check'], ['apple', 0]]);
  prices['B2'] = { t: 'n', f: 'VLOOKUP(2,Lookup!$A$1:$B$3,2,0)', v: 0 };
  prices['D2'] = { t: 'n', f: '1/0', v: 0 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, lookup, 'Lookup');
  XLSX.utils.book_append_sheet(wb, prices, 'prices');
  const out = formulas.evaluateWorkbook(wb);
  const computed = out.sheets.prices;
  assert.strictEqual(computed.find((c) => c.row === 1 && c.col === 1).value, 20);
  assert.ok(out.errors.some((e) => e.startsWith('prices!D2: #')), out.errors.join(' | '));
});

test('importer uses evaluated prices from formula cells', () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['BRAND', 'EAN', 'Descrip', 'NEW CP', 'SP', 'QTY', '', '', ''],
    ['TEST', '1234567890123', 'Test 50ml', 0, 100, 5],
  ]);
  ws['D2'] = { t: 'n', f: 'VLOOKUP(1,$H$1:$I$2,2,0)', v: 0 };
  ws['H1'] = { t: 'n', v: 1 };
  ws['I1'] = { t: 'n', v: 7.5 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const file = path.join(os.tmpdir(), `ptp-formula-import-${process.pid}.xlsx`);
  XLSX.writeFile(wb, file);
  try {
    const out = extract(file, { supplierId: 'FORMULA', supplierName: 'Formula Test' });
    assert.strictEqual(out.formulas.count, 1);
    assert.strictEqual(out.offers.length, 1);
    assert.strictEqual(out.offers[0].price, 7.5, 'stale cached price must not be imported');
  } finally {
    try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
  }
});

test('AI exposes formula tools and computes through the engine', () => {
  const tools = ai.toolsForRole('viewer').map((t) => t.function.name);
  assert.ok(tools.includes('excel_formula'));
  assert.ok(tools.includes('excel_function'));
  assert.ok(tools.includes('excel_functions'));

  const r = ai.runTool('excel_formula', {
    formula: '=XLOOKUP("pear",A1:A3,B1:B3)',
    values: [['banana', 5], ['apple', 12], ['pear', 8]],
  }, 'viewer');
  assert.ok(!r.result.error, r.result.error || 'no error expected');
  assert.strictEqual(r.result.value, 8);

  const f = ai.runTool('excel_function', { functionName: 'VLOOKUP', args: [2, [[1, 10], [2, 20]], 2, 0] }, 'viewer');
  assert.strictEqual(f.result.value, 20);

  const bad = ai.runTool('excel_function', { functionName: 'DROP_TABLE', args: [] }, 'viewer');
  assert.match(bad.result.error, /unknown Excel function/);
});
