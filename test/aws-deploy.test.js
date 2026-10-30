'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, sh, buildEnv } = require('../deploy/aws/lib');

function writeTempEnv(lines) {
  const file = path.join(os.tmpdir(), `ptp-env-${process.pid}-${Date.now()}.env`);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

test('parseArgs supports flags, values and repeated options', () => {
  const { opts, rest } = parseArgs(['--stack', 'prod', '--new-ami', '--data-size', '30', 'hello']);
  assert.strictEqual(opts.stack, 'prod');
  assert.strictEqual(opts['new-ami'], true);
  assert.strictEqual(opts['data-size'], '30');
  assert.strictEqual(rest[0], 'hello');
});

test('sh quotes single quotes safely for remote bash', () => {
  assert.strictEqual(sh("it's fine"), `'it'\\''s fine'`);
});

test('buildEnv only uploads allowlisted keys and sets production defaults', () => {
  const file = writeTempEnv([
    '# comment',
    'AI_API_KEY=secret-value',
    'AI_MODEL=openai/gpt-4o-mini',
    'PTP_AI_MOCK=1',
    'PTP_ADMIN_USER=admin',
    'UNRELATED=drop-me',
  ]);
  const built = buildEnv({ envFile: file });

  assert.strictEqual(built.env.AI_API_KEY, 'secret-value');
  assert.strictEqual(built.env.AI_MODEL, 'openai/gpt-4o-mini');
  assert.strictEqual(built.env.PTP_ADMIN_USER, 'admin');
  assert.strictEqual(built.env.UNRELATED, undefined);
  assert.strictEqual(built.env.PTP_AI_MOCK, undefined);
  assert.strictEqual(built.env.PORT, '8080');
  assert.strictEqual(built.env.PTP_DATA_DIR, '/var/data');
  assert.strictEqual(built.env.PTP_SECURE_COOKIES, '1');
  assert.strictEqual(built.env.PTP_AUTO_SEED, 'false');
  assert.ok(built.text.split('\n').includes('PTP_SECURE_COOKIES=1'));
  fs.rmSync(file, { force: true });
});

test('buildEnv reuses the password already stored in SSM', () => {
  const file = writeTempEnv(['AI_API_KEY=secret-value']);
  const built = buildEnv({
    envFile: file,
    existingText: 'PTP_ADMIN_USER=admin\nPTP_ADMIN_PASS=existing-pass\nAI_MODEL=stored-model',
  });

  assert.strictEqual(built.env.PTP_ADMIN_PASS, 'existing-pass');
  assert.strictEqual(built.env.AI_MODEL, 'stored-model');
  assert.strictEqual(built.generatedPassword, false);
  fs.rmSync(file, { force: true });
});

test('buildEnv generates a bootstrap password when none exists', () => {
  const file = writeTempEnv(['AI_API_KEY=secret-value']);
  const built = buildEnv({ envFile: file });

  assert.strictEqual(built.generatedPassword, true);
  assert.ok(built.env.PTP_ADMIN_PASS.length >= 16);
  fs.rmSync(file, { force: true });
});
