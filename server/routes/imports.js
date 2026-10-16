'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { importFile } = require('../services/importer');
const { parseList, diffLists } = require('../services/listdiff');
const auth = require('../services/auth');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 50 * 1024 * 1024 } });

// Import from an uploaded file (multipart field "file") or a server-side path.
router.post('/import', auth.requireRole('buyer'), upload.single('file'), (req, res, next) => {
  try {
    let filePath = null;
    let cleanup = false;
    if (req.file) {
      filePath = req.file.path;
      cleanup = true;
    } else if (req.body && req.body.path) {
      filePath = req.body.path;
    }
    if (!filePath) return res.status(400).json({ error: 'Provide a file upload or a "path".' });
    if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'File not found: ' + filePath });

    const result = importFile(filePath, {
      supplierCode: req.body && req.body.supplierCode,
      listDate: req.body && req.body.listDate,
      actor: req.body && req.body.actor || 'user',
      force: req.body && req.body.force === 'true',
    });
    if (cleanup) { try { fs.unlinkSync(filePath); } catch (_) {} }
    res.json(result);
  } catch (e) { next(e); }
});

// Compare two uploaded price lists (fields "fileA" and "fileB"). Matches rows
// by barcode where present, else by description, and reports added / removed /
// price / quantity / description changes. Nothing is persisted.
router.post('/compare-files', auth.requireRole('analyst'),
  upload.fields([{ name: 'fileA', maxCount: 1 }, { name: 'fileB', maxCount: 1 }]),
  (req, res, next) => {
    try {
      const fA = req.files && req.files.fileA && req.files.fileA[0];
      const fB = req.files && req.files.fileB && req.files.fileB[0];
      if (!fA || !fB) return res.status(400).json({ error: 'Upload two files (fields fileA and fileB).' });

      let a; let b;
      try {
        a = parseList(fs.readFileSync(fA.path));
        b = parseList(fs.readFileSync(fB.path));
      } finally {
        try { fs.unlinkSync(fA.path); } catch (_) { /* ignore */ }
        try { fs.unlinkSync(fB.path); } catch (_) { /* ignore */ }
      }
      if (!a.rows.length && !b.rows.length) return res.status(400).json({ error: 'No barcode/price header found in either file.' });

      const diff = diffLists(a, b);
      const cap = 500;
      const trim = (arr) => arr.slice(0, cap);
      const meta = (m, name) => ({ name, sheet: m.sheet, headerRow: m.headerRow, columns: m.columns, rowCount: m.rows.length });
      res.json({
        a: meta(a, fA.originalname),
        b: meta(b, fB.originalname),
        added: trim(diff.added),
        removed: trim(diff.removed),
        priceChanges: trim(diff.priceChanges),
        quantityChanges: trim(diff.quantityChanges),
        descriptionChanges: trim(diff.descriptionChanges),
        summary: {
          ...diff.summary,
          truncated: diff.added.length > cap || diff.removed.length > cap ||
            diff.priceChanges.length > cap || diff.quantityChanges.length > cap || diff.descriptionChanges.length > cap,
        },
      });
    } catch (e) { next(e); }
  });

module.exports = router;
