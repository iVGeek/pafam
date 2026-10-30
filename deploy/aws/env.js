#!/usr/bin/env node
'use strict';
// Push the local .env into the SSM SecureString and restart the app.
//
//   npm run aws:env
//   npm run aws:env -- --env-file .env.production
//   npm run aws:env -- --no-restart
//
// Existing values already in SSM are merged first, so a key that is absent from
// the local file is not lost. Only the AI_* and PTP_* allowlist is uploaded.

const {
  DEFAULT_STACK,
  DEFAULT_REGION,
  parseArgs,
  awsJson,
  getParameter,
  putParameter,
  buildEnv,
  requireStack,
  ssmRun,
  printCommandResult,
  fail,
  bold,
} = require('./lib');

async function main() {
  const { opts } = parseArgs();
  const stack = String(opts.stack || DEFAULT_STACK);
  const region = String(opts.region || DEFAULT_REGION);

  const { outputs } = requireStack(stack, region);
  const envParam = outputs.EnvParameterName || '/perfumes/env';
  const instanceId = outputs.InstanceId;

  const existingText = getParameter(envParam, region, { withDecryption: true });
  const built = buildEnv({
    envFile: opts['env-file'] ? String(opts['env-file']) : undefined,
    existingText,
  });

  putParameter(envParam, built.text, region, 'Perfumes container environment (managed by deploy/aws)');
  console.log(bold(`Updated ${envParam}`));
  console.log(`  keys: ${Object.keys(built.env).join(', ')}`);

  if (built.generatedPassword) {
    console.log('');
    console.log('A PTP_ADMIN_PASS was generated because none was configured:');
    console.log(`  username: ${built.env.PTP_ADMIN_USER}`);
    console.log(`  password: ${built.env.PTP_ADMIN_PASS}`);
  }

  if (opts['no-restart']) {
    console.log('  restart skipped (--no-restart)');
    return;
  }

  const result = await ssmRun({
    instanceId,
    region,
    comment: 'perfumes refresh env',
    timeoutMs: 180 * 1000,
    commands: ['systemctl restart perfumes.service', 'sleep 3', 'curl -fsS http://127.0.0.1/api/auth/me > /dev/null && echo "app healthy"'],
  });
  printCommandResult(result);
  if (!result.ok) fail(`restart failed (status ${result.status})`);
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
