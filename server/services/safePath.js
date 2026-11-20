'use strict';

const path = require('path');
const fs = require('fs');

// Only spreadsheet files may be imported by server-side path.
const ALLOWED_EXT = new Set(['.xls', '.xlsx', '.csv']);

function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// Resolve a user-supplied "server-side path" for the importer. The file must be
// a regular spreadsheet inside the designated import directory. Without this,
// a buyer could point the importer at any readable host file (the SQLite
// database, /etc/passwd, another user's uploads, ...) and leak it through the
// parse/error output. Symlinks are resolved too, so a link inside the directory
// cannot escape it. Returns the canonical absolute path.
function resolveImportPath(input, importDir) {
  if (typeof input !== 'string' || !input.trim()) throw bad('A non-empty path is required.');
  if (/[\0-\x1f]/.test(input)) throw bad('Invalid path.');

  const ext = path.extname(input).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw bad('Only .xls, .xlsx and .csv files can be imported by path.');

  let root;
  try {
    root = fs.realpathSync(importDir);
  } catch (_) {
    throw bad('The import directory is not available.');
  }

  const resolved = path.resolve(root, input);
  const outside = (p) => {
    const rel = path.relative(root, p);
    return rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel);
  };
  if (outside(resolved)) throw bad('Path must be inside the import directory.');

  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (_) {
    throw bad('File not found: ' + path.basename(input));
  }
  if (outside(real)) throw bad('Path must be inside the import directory.');

  let stat;
  try {
    stat = fs.statSync(real);
  } catch (_) {
    throw bad('File not found: ' + path.basename(input));
  }
  if (!stat.isFile()) throw bad('Path must be a regular file.');

  return real;
}

module.exports = { resolveImportPath, ALLOWED_EXT };
