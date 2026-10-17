'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse, load } = require('../server/env');

test('parse reads keys, quotes and inline comments', () => {
  const out = parse([
    '# a comment',
    '',
    'PLAIN=value',
    'SPACED = trimmed ',
    'QUOTED="hello world"',
    'SINGLE=\'single quoted\'',
    'INLINE=123 # trailing note',
    'ai_lower=ok',
    'BAD KEY=nope',
    'noequals',
    'AI_BASE_URL=https://models.github.ai/inference',
  ].join('\n'));
  assert.strictEqual(out.PLAIN, 'value');
  assert.strictEqual(out.SPACED, 'trimmed');
  assert.strictEqual(out.QUOTED, 'hello world');
  assert.strictEqual(out.SINGLE, 'single quoted');
  assert.strictEqual(out.INLINE, '123');
  assert.strictEqual(out.ai_lower, 'ok');
  assert.strictEqual(out.AI_BASE_URL, 'https://models.github.ai/inference');
  assert.strictEqual(out['BAD KEY'], undefined);
  assert.strictEqual(out.noequals, undefined);
});

test('load fills gaps but never overwrites the real environment', () => {
  const file = path.join(os.tmpdir(), `ptp-env-${process.pid}-${Date.now()}.env`);
  fs.writeFileSync(file, 'PTP_ENV_TEST_KEEP=from-file\nPTP_ENV_TEST_NEW=from-file\n');
  process.env.PTP_ENV_TEST_KEEP = 'from-shell';
  delete process.env.PTP_ENV_TEST_NEW;
  try {
    const parsed = load(file);
    assert.strictEqual(parsed.PTP_ENV_TEST_NEW, 'from-file');
    assert.strictEqual(process.env.PTP_ENV_TEST_KEEP, 'from-shell');
    assert.strictEqual(process.env.PTP_ENV_TEST_NEW, 'from-file');
  } finally {
    delete process.env.PTP_ENV_TEST_KEEP;
    delete process.env.PTP_ENV_TEST_NEW;
    fs.rmSync(file, { force: true });
  }
});

test('load is a no-op when the file is missing', () => {
  const missing = path.join(os.tmpdir(), `ptp-env-missing-${process.pid}.env`);
  assert.deepStrictEqual(load(missing), {});
});
