#!/usr/bin/env node
'use strict';
// Run a shell command on the instance through SSM (no SSH, no Session Manager
// plugin required).
//
//   node deploy/aws/exec.js "docker ps"
//   node deploy/aws/exec.js --timeout-seconds 600 "docker logs --tail 100 perfumes"
//
// The command runs as root in AWS-RunShellScript.

const {
  DEFAULT_STACK,
  DEFAULT_REGION,
  parseArgs,
  requireStack,
  ssmRun,
  printCommandResult,
  bold,
  fail,
} = require('./lib');

async function main() {
  const { opts, rest } = parseArgs();
  const command = rest.join(' ').trim();
  if (!command) fail('usage: node deploy/aws/exec.js "shell command"');

  const stack = String(opts.stack || DEFAULT_STACK);
  const region = String(opts.region || DEFAULT_REGION);
  const { outputs } = requireStack(stack, region);
  const instanceId = outputs.InstanceId;
  if (!instanceId) fail(`stack ${stack} has no InstanceId output`);

  console.log(bold(`$ ${command}`));
  const result = await ssmRun({
    instanceId,
    region,
    comment: 'perfumes exec',
    timeoutMs: Number(opts['timeout-seconds'] || 600) * 1000,
    commands: [command],
  });
  printCommandResult(result);
  if (!result.ok) process.exit(1);
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
