'use strict';
// Shared helpers for the Perfumes AWS runbook scripts.
// Only Node built-ins plus the AWS CLI are used, so nothing has to be
// installed into the app's dependency tree.

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE = 'deploy/aws/perfumes.yaml';
const DEFAULT_STACK = 'perfumes';
const DEFAULT_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const AWS_CLI = process.env.AWS_CLI_PATH || 'aws';

// Only these keys are pushed to the instance. Anything else in the local .env
// (mock flags, shell-only settings) stays local.
const ENV_ALLOWLIST = new Set([
  'AI_API_KEY',
  'AI_BASE_URL',
  'AI_MODEL',
  'AI_MODELS',
  'AI_AUTO_DISCOVER',
  'AI_AUTO_DISCOVER_MAX',
  'AI_DISCOVER_MAX_PRICE',
  'AI_TIMEOUT_MS',
  'AI_MAX_STEPS',
  'PTP_ADMIN_USER',
  'PTP_ADMIN_PASS',
  'PTP_BUYER_PASS',
  'PTP_ANALYST_PASS',
  'PTP_VIEWER_PASS',
  'PTP_SEED_DEMO_USERS',
  'PTP_AUTO_SEED',
]);

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i += 1;
    }
  }
  return { opts, rest };
}

function aws(args, { region = DEFAULT_REGION, output = 'json', allowFailure = false } = {}) {
  const full = [...args];
  if (!full.includes('--region')) full.push('--region', region);
  if (output && !full.includes('--output')) full.push('--output', output);

  const res = spawnSync(AWS_CLI, full, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, AWS_PAGER: '' },
  });

  if (res.error) throw new Error(`could not run the AWS CLI (${AWS_CLI}): ${res.error.message}`);
  if (res.status !== 0 && !allowFailure) {
    const message = (res.stderr || res.stdout || 'AWS CLI failed').trim();
    const err = new Error(message);
    err.status = res.status;
    err.stdout = res.stdout;
    err.stderr = res.stderr;
    throw err;
  }
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function awsJson(args, opts) {
  const out = aws(args, opts).stdout.trim();
  return out ? JSON.parse(out) : null;
}

// Long-running commands (cloudformation deploy) stream their progress instead
// of buffering it, so a 10 minute CloudFront rollout does not look hung.
function awsStream(args, { region = DEFAULT_REGION } = {}) {
  const full = [...args];
  if (!full.includes('--region')) full.push('--region', region);
  return new Promise((resolve, reject) => {
    const child = spawn(AWS_CLI, full, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, AWS_PAGER: '' },
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readEnvFile(file) {
  const out = {};
  if (!file || !fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function getParameter(name, region, { withDecryption = true } = {}) {
  const res = aws(
    [
      'ssm',
      'get-parameter',
      '--name',
      name,
      ...(withDecryption ? ['--with-decryption'] : []),
      '--query',
      'Parameter.Value',
      '--output',
      'text',
    ],
    { region, allowFailure: true },
  );
  if (res.status !== 0) return null;
  return res.stdout.replace(/\r?\n$/, '');
}

function putParameter(name, value, region, description) {
  const file = path.join(ROOT, `.env.aws.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(file, String(value).replace(/\r\n/g, '\n') + '\n', { mode: 0o600 });
  try {
    aws(
      [
        'ssm',
        'put-parameter',
        '--name',
        name,
        '--type',
        'SecureString',
        '--value',
        `file://${path.basename(file)}`,
        '--overwrite',
        '--description',
        description || 'Perfumes runtime environment',
      ],
      { region },
    );
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function buildEnv({ envFile, existingText }) {
  const existing = readEnvFileText(existingText);
  const local = readEnvFile(envFile || path.join(ROOT, '.env'));
  const env = {};

  for (const [key, value] of Object.entries(existing)) {
    if (ENV_ALLOWLIST.has(key) && value) env[key] = value;
  }
  for (const [key, value] of Object.entries(local)) {
    if (ENV_ALLOWLIST.has(key) && value) env[key] = value;
  }

  env.NODE_ENV = 'production';
  env.PORT = '8080';
  env.PTP_DATA_DIR = '/var/data';
  env.PTP_SECURE_COOKIES = '1';
  env.PTP_AUTO_SEED = 'false';

  let generatedPassword = false;
  if (!env.PTP_ADMIN_USER) env.PTP_ADMIN_USER = 'admin';
  if (!env.PTP_ADMIN_PASS) {
    env.PTP_ADMIN_PASS = crypto.randomBytes(12).toString('base64url');
    generatedPassword = true;
  }

  const text = Object.keys(env)
    .sort()
    .map((key) => `${key}=${env[key]}`)
    .join('\n');
  return { env, text, generatedPassword };
}

function readEnvFileText(text) {
  if (!text) return {};
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function requireStack(stack, region) {
  const res = aws(['cloudformation', 'describe-stacks', '--stack-name', stack], {
    region,
    allowFailure: true,
  });
  if (res.status !== 0) {
    const message = (res.stderr || res.stdout || '').trim();
    if (/NoCredentials|Unable to locate credentials|ExpiredToken/i.test(message)) {
      fail(`no usable AWS credentials. Run "aws login" in this terminal, then retry.\n${message}`, 2);
    }
    fail(`stack "${stack}" was not found in ${region}. Run "npm run aws:deploy" first.\n${message}`, 2);
  }
  const parsed = JSON.parse(res.stdout);
  const info = parsed.Stacks && parsed.Stacks[0];
  if (!info) fail(`stack "${stack}" has no description in ${region}.`, 2);
  const outputs = {};
  for (const output of info.Outputs || []) outputs[output.OutputKey] = output.OutputValue;
  return { stack: info, outputs };
}

function cloudFrontPrefixList(region) {
  const out = awsJson(
    [
      'ec2',
      'describe-managed-prefix-lists',
      '--filters',
      'Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing',
      'Name=owner-id,Values=aws',
    ],
    { region },
  );
  const list = out && out.PrefixLists && out.PrefixLists[0];
  if (!list) {
    fail(
      `could not resolve the CloudFront origin-facing prefix list in ${region}. Pass --prefix-list manually.`,
      2,
    );
  }
  return list.PrefixListId;
}

async function waitForSite(baseUrl, { timeoutMs = 20 * 60 * 1000, intervalMs = 5000 } = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/api/auth/me`;
  const startedAt = Date.now();
  let last = 'no response yet';
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status === 200) return { ok: true, url };
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err && err.message ? err.message : String(err);
    }
    await delay(intervalMs);
  }
  return { ok: false, url, last };
}

async function ssmRun({
  instanceId,
  commands,
  comment = 'perfumes',
  region = DEFAULT_REGION,
  timeoutMs = 25 * 60 * 1000,
}) {
  const inputFile = path.join(ROOT, `.aws-ssm.${process.pid}.${Date.now()}.json`);
  fs.writeFileSync(
    inputFile,
    JSON.stringify({
      DocumentName: 'AWS-RunShellScript',
      InstanceIds: [instanceId],
      Comment: comment,
      Parameters: { commands },
    }),
  );

  let commandId;
  try {
    const sent = awsJson(
      ['ssm', 'send-command', '--cli-input-json', `file://${path.basename(inputFile)}`],
      { region },
    );
    commandId = sent && sent.Command && sent.Command.CommandId;
  } finally {
    fs.rmSync(inputFile, { force: true });
  }
  if (!commandId) throw new Error('SSM did not return a command id');

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    let inv;
    try {
      inv = awsJson(
        ['ssm', 'get-command-invocation', '--command-id', commandId, '--instance-id', instanceId],
        { region },
      );
    } catch (err) {
      // The invocation record can take a moment to appear after send-command.
      if (/InvocationDoesNotExist/i.test(err.message)) {
        await delay(3000);
        continue;
      }
      throw err;
    }
    const status = inv && inv.Status;
    if (status === 'Pending' || status === 'InProgress' || status === 'Delayed') {
      await delay(3000);
      continue;
    }
    return {
      ok: status === 'Success',
      status,
      commandId,
      stdout: (inv && inv.StandardOutputContent) || '',
      stderr: (inv && inv.StandardErrorContent) || '',
    };
  }

  return {
    ok: false,
    status: 'TimedOut',
    commandId,
    stdout: '',
    stderr: `SSM command ${commandId} did not finish within ${Math.round(timeoutMs / 60000)} minutes`,
  };
}

function printCommandResult(result) {
  if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  if (!result.ok) {
    console.error(`\nRemote command ${result.commandId || ''} finished with status ${result.status}.`);
  }
}

function fail(message, code = 1) {
  console.error(`\nERROR: ${message}`);
  process.exit(code);
}

function bold(text) {
  return `\x1b[1m${text}\x1b[0m`;
}

module.exports = {
  ROOT,
  TEMPLATE,
  DEFAULT_STACK,
  DEFAULT_REGION,
  parseArgs,
  aws,
  awsJson,
  awsStream,
  sh,
  delay,
  readEnvFile,
  getParameter,
  putParameter,
  buildEnv,
  requireStack,
  cloudFrontPrefixList,
  waitForSite,
  ssmRun,
  printCommandResult,
  fail,
  bold,
  os,
  crypto,
  path,
};
