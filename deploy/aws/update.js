#!/usr/bin/env node
'use strict';
// Rebuild and restart the app on the instance from the current branch.
//
//   npm run aws:update
//   npm run aws:update -- --branch main
//
// The instance runs /usr/local/bin/perfumes-deploy.sh, which fetches the branch,
// installs the host scripts, refreshes the env from SSM, rebuilds the image and
// restarts the systemd unit. No SSH and no inbound admin port are involved.

const {
  DEFAULT_STACK,
  DEFAULT_REGION,
  parseArgs,
  requireStack,
  ssmRun,
  printCommandResult,
  waitForSite,
  sh,
  fail,
  bold,
} = require('./lib');

async function main() {
  const { opts } = parseArgs();
  if (opts.help) {
    console.log(`Usage: npm run aws:update -- [options]

  --stack <name>          CloudFormation stack name (default: perfumes)
  --region <region>       AWS region (default: us-east-1)
  --branch <name>         Git branch to deploy (default: main)
  --skip-wait             Do not wait for the health check
  --timeout-seconds <n>   SSM command timeout (default: 1500)`);
    return;
  }
  const stack = String(opts.stack || DEFAULT_STACK);
  const region = String(opts.region || DEFAULT_REGION);
  const branch = String(opts.branch || 'main');

  const { outputs } = requireStack(stack, region);
  const instanceId = outputs.InstanceId;
  if (!instanceId) fail(`stack ${stack} has no InstanceId output`);

  console.log(bold(`Deploying ${branch} to ${instanceId}`));
  const result = await ssmRun({
    instanceId,
    region,
    comment: `perfumes deploy ${branch}`,
    timeoutMs: Number(opts['timeout-seconds'] || 1500) * 1000,
    commands: [`/usr/local/bin/perfumes-deploy.sh ${sh(branch)}`],
  });
  printCommandResult(result);
  if (!result.ok) fail(`deploy failed (status ${result.status})`);

  if (!opts['skip-wait']) {
    const ready = await waitForSite(outputs.SiteUrl, { timeoutMs: 180 * 1000 });
    if (!ready.ok) fail(`the app did not answer at ${outputs.SiteUrl} (${ready.last})`);
    console.log(`app is answering: ${outputs.SiteUrl}`);
  }
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
