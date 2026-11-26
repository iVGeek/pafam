'use strict';

// Admin-only recorder for pilot acceptance. The assistant can READ acceptance
// state through its acceptance_evidence tool but must never write it: every
// change goes through these endpoints, is validated and lands in the audit log.

const express = require('express');
const router = express.Router();
const { setSetting, audit } = require('../db');
const auth = require('../services/auth');
const acceptance = require('../services/acceptanceEvidence');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const adminOnly = auth.requireRole('admin');

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max + 1);
}

function respond(res) {
  return res.json({ ok: true, status: acceptance.evidence() });
}

router.get('/acceptance', (req, res) => {
  res.json({ status: acceptance.evidence(), recorder: acceptance.recorderState() });
});

router.post('/acceptance/data-mode', adminOnly, (req, res) => {
  const body = req.body || {};
  const mode = String(body.mode || '').trim().toLowerCase();
  if (mode !== 'demo' && mode !== 'real') {
    return res.status(400).json({ error: "mode must be either 'demo' or 'real'" });
  }
  if (mode === 'real' && body.confirm !== 'REAL CLIENT DATA') {
    return res.status(400).json({ error: "Set confirm to 'REAL CLIENT DATA' to certify this is client real data" });
  }
  const previous = acceptance.dataMode();
  setSetting(acceptance.DATA_MODE_KEY, mode);
  audit(req.user.username, 'acceptance-set-data-mode', 'acceptance', acceptance.DATA_MODE_KEY,
    previous + ' -> ' + mode);
  return respond(res);
});

router.post('/acceptance/signoff', adminOnly, (req, res) => {
  const body = req.body || {};
  const name = text(body.name, 120);
  const email = text(body.email, 160);
  const evidenceRef = text(body.evidenceRef, 300);
  if (!name || !email || !evidenceRef) {
    return res.status(400).json({ error: 'PO name, email and signature evidence reference are required' });
  }
  if (!EMAIL.test(email)) return res.status(400).json({ error: 'Enter a valid PO email address' });
  if (!acceptance.isProof(evidenceRef)) {
    return res.status(400).json({ error: 'Evidence reference must be at least 4 characters and cannot be a placeholder (demo, sample, test, n/a, tbd)' });
  }
  const payload = {
    name, email, evidenceRef,
    recordedBy: req.user.username,
    recordedAt: new Date().toISOString(),
  };
  setSetting(acceptance.SIGNOFF_KEY, JSON.stringify(payload));
  audit(req.user.username, 'acceptance-set-signoff', 'acceptance', acceptance.SIGNOFF_KEY,
    `${name} <${email}>; signature evidence: ${evidenceRef}`);
  return respond(res);
});

router.delete('/acceptance/signoff', adminOnly, (req, res) => {
  setSetting(acceptance.SIGNOFF_KEY, '');
  audit(req.user.username, 'acceptance-clear-signoff', 'acceptance', acceptance.SIGNOFF_KEY);
  return respond(res);
});

router.post('/acceptance/criteria/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1 || id > acceptance.CRITERIA.length) {
    return res.status(404).json({ error: 'unknown acceptance criterion (1-' + acceptance.CRITERIA.length + ')' });
  }
  const evidenceRef = text((req.body || {}).evidence, 500);
  if (!acceptance.isProof(evidenceRef)) {
    return res.status(400).json({ error: 'Evidence reference must be 4-500 characters and cannot be a placeholder (demo, sample, test, n/a, tbd)' });
  }
  setSetting(acceptance.EVIDENCE_PREFIX + id, evidenceRef);
  audit(req.user.username, 'acceptance-set-criterion', 'acceptance', acceptance.EVIDENCE_PREFIX + id,
    `criterion ${id}: ${evidenceRef}`);
  return respond(res);
});

router.delete('/acceptance/criteria/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1 || id > acceptance.CRITERIA.length) {
    return res.status(404).json({ error: 'unknown acceptance criterion (1-' + acceptance.CRITERIA.length + ')' });
  }
  setSetting(acceptance.EVIDENCE_PREFIX + id, '');
  audit(req.user.username, 'acceptance-clear-criterion', 'acceptance', acceptance.EVIDENCE_PREFIX + id,
    'criterion ' + id);
  return respond(res);
});

module.exports = router;
