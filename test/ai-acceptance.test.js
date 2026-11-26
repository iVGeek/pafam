'use strict';
// Acceptance claims and record counts must come from authoritative tools,
// never from the model's reading of a dashboard or a demo dataset.
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_DB = path.join(os.tmpdir(), `ptp-accept-${process.pid}.db`);
process.env.PTP_DATA_DIR = path.dirname(TMP_DB);
process.env.PTP_DB = TMP_DB;
process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch (e) { /* ignore */ }
  }
});

const { test } = require('node:test');
const assert = require('node:assert');
const { init, db, setSetting } = require('../server/db');
init();

const ai = require('../server/services/ai');
const { SYSTEM_PROMPT } = require('../server/services/aiKnowledge');

test('record_counts returns exact COUNT(*) integers and rejects unknown entities', () => {
  db.prepare('INSERT INTO suppliers (code, name, currency) VALUES (?, ?, ?)').run('S1', 'One', 'USD');
  db.prepare('INSERT INTO suppliers (code, name, currency) VALUES (?, ?, ?)').run('S2', 'Two', 'EUR');

  const out = ai.runTool('record_counts', { entities: ['suppliers', 'products'] }).result;
  assert.equal(out.counts.suppliers, 2);
  assert.equal(out.counts.products, 0);
  assert.match(out.note, /never count rows/i);

  const bad = ai.runTool('record_counts', { entities: ['suppliers; DROP TABLE suppliers'] }).result;
  assert.match(bad.error, /unknown entity/);
});

test('acceptance_evidence never confirms a criterion on demo data', () => {
  const out = ai.runTool('acceptance_evidence', {}).result;
  assert.equal(out.dataMode, 'demo');
  assert.equal(out.met, 0);
  assert.equal(out.total, 10);
  assert.equal(out.verdict, 'not_confirmed');
  assert.equal(out.criteria.length, 10);
  assert.ok(out.criteria.every((c) => c.status === 'unproven'));
  assert.match(out.note, /demo\/synthetic/i);
});

test('acceptance_evidence needs real data, PO sign-off and a recorded reference', () => {
  setSetting('acceptance_data_mode', 'real');
  setSetting('acceptance_signoff', JSON.stringify({
    name: 'PO Name', email: 'po@example.test', evidenceRef: 'Evidence pack v3, PO signature page',
  }));

  const signed = ai.runTool('acceptance_evidence', {}).result;
  assert.equal(signed.dataMode, 'real');
  assert.equal(signed.met, 0, 'sign-off alone is not evidence');
  assert.ok(signed.criteria.every((c) => c.status === 'unproven'));

  setSetting('acceptance_criterion_1', 'signed evidence pack reference');
  const withProof = ai.runTool('acceptance_evidence', {}).result;
  assert.equal(withProof.met, 1);
  assert.equal(withProof.criteria[0].status, 'met');
  assert.equal(withProof.criteria[1].status, 'unproven');
  assert.equal(withProof.verdict, 'not_confirmed');
});

test('incomplete sign-offs and placeholder references never count as evidence', () => {
  setSetting('acceptance_data_mode', 'real');
  setSetting('acceptance_criterion_1', 'signed evidence pack reference');

  setSetting('acceptance_signoff', JSON.stringify({ name: 'PO Name', email: 'po@example.test' }));
  assert.equal(ai.runTool('acceptance_evidence', {}).result.met, 0, 'signature reference is mandatory');

  setSetting('acceptance_signoff', JSON.stringify({
    name: 'PO Name', email: 'po@example.test', evidenceRef: 'sample signature',
  }));
  assert.equal(ai.runTool('acceptance_evidence', {}).result.met, 0, 'placeholder is not a signature');

  setSetting('acceptance_signoff', JSON.stringify({
    name: 'PO Name', email: 'po@example.test', evidenceRef: 'Evidence pack v3, PO signature page',
  }));
  setSetting('acceptance_criterion_2', 'demo evidence');
  const out = ai.runTool('acceptance_evidence', {}).result;
  assert.equal(out.met, 1, 'only the real reference counts');
  assert.equal(out.criteria[1].status, 'unproven');

  setSetting('acceptance_data_mode', 'demo');
});

test('acceptance and count tools are visible to every role', () => {
  for (const toolName of ['acceptance_evidence', 'record_counts']) {
    assert.ok(ai.toolsForRole('viewer').some((t) => t.function.name === toolName));
    assert.ok(ai.toolsForRole('admin').some((t) => t.function.name === toolName));
  }
});

test('402 budget reasons are classified separately from an empty account', () => {
  const inflight = ai._describeProvider(402, 'This request would exceed your available credits given your current in-flight requests', 'm');
  assert.equal(inflight.code, 'in_flight');
  assert.equal(inflight.retry, false);

  const weight = ai._describeProvider(402, "This request's maximum cost exceeds your available credits", 'm');
  assert.equal(weight.code, 'budget_weight');
  assert.equal(weight.retry, true);

  const empty = ai._describeProvider(402, 'Insufficient credits', 'm');
  assert.equal(empty.code, 'credits');
});

test('prompt forbids inferred acceptance and hand-counted rows', () => {
  for (const phrase of [
    'acceptance_evidence BEFORE answering',
    'Record counts, dashboard KPIs, demo rows and product totals are NOT',
    'If dataMode is "demo"',
    'call record_counts and quote its exact',
    'Never count rows yourself',
    'You cannot record',
    'Admin → Acceptance',
  ]) {
    assert.ok(SYSTEM_PROMPT.includes(phrase), 'missing rule: ' + phrase);
  }
});
