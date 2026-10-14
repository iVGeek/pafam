'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { importFile } = require('../services/importer');
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

module.exports = router;
