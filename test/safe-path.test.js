'use strict';
// Server-side import paths must stay inside the import directory. A buyer must
// not be able to point the importer at the SQLite database, /etc/passwd, a file
// outside the directory, or a symlink that escapes it.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { test, after } = require('node:test');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-safepath-'));
const ROOT = path.join(TMP, 'imports');
const OUTSIDE = path.join(TMP, 'outside');
fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });

const { resolveImportPath } = require('../server/services/safePath');

after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

function write(file, content) {
  const p = path.join(ROOT, file);
  fs.writeFileSync(p, content || 'x');
  return p;
}

test('accepts a spreadsheet filename inside the import directory', () => {
  const p = write('list.xlsx');
  assert.strictEqual(resolveImportPath('list.xlsx', ROOT), p);
  assert.strictEqual(resolveImportPath('nested/../list.xlsx', ROOT), p);
});

test('accepts an absolute path inside the import directory', () => {
  const p = write('abs.csv');
  assert.strictEqual(resolveImportPath(p, ROOT), p);
});

test('rejects traversal outside the directory', () => {
  write('list.xlsx');
  assert.throws(() => resolveImportPath('../outside/list.xlsx', ROOT), /inside the import directory/);
  assert.throws(() => resolveImportPath('....//outside/list.xlsx', ROOT), /File not found|inside the import directory/);
});

test('rejects an absolute path outside the directory', () => {
  const p = path.join(OUTSIDE, 'secret.xlsx');
  fs.writeFileSync(p, 'secret');
  assert.throws(() => resolveImportPath(p, ROOT), /inside the import directory/);
});

test('rejects a symlink that escapes the directory', () => {
  const secret = path.join(OUTSIDE, 'secret.xlsx');
  fs.writeFileSync(secret, 'secret');
  const link = path.join(ROOT, 'link.xlsx');
  try { fs.symlinkSync(secret, link); } catch (_) { return; } // symlinks may be unavailable
  assert.throws(() => resolveImportPath('link.xlsx', ROOT), /inside the import directory/);
});

test('rejects rejected extensions (database, text, config)', () => {
  write('ptp.db', 'sqlite');
  write('notes.txt', 'text');
  assert.throws(() => resolveImportPath('ptp.db', ROOT), /Only .xls/);
  assert.throws(() => resolveImportPath('notes.txt', ROOT), /Only .xls/);
  assert.throws(() => resolveImportPath('/etc/passwd', ROOT), /Only .xls/);
});

test('rejects empty paths, control characters and directories', () => {
  assert.throws(() => resolveImportPath('', ROOT), /non-empty/);
  assert.throws(() => resolveImportPath('   ', ROOT), /non-empty/);
  assert.throws(() => resolveImportPath('list.xlsx\0bad', ROOT), /Invalid path/);
  fs.mkdirSync(path.join(ROOT, 'folder.xlsx'), { recursive: true });
  assert.throws(() => resolveImportPath('folder.xlsx', ROOT), /regular file/);
});

test('rejects a missing file without revealing the full server path', () => {
  let err;
  try { resolveImportPath('missing.xlsx', ROOT); } catch (e) { err = e; }
  assert.ok(err);
  assert.match(err.message, /File not found: missing\.xlsx/);
  assert.doesNotMatch(err.message, new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
