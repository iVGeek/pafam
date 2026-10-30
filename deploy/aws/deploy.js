#!/usr/bin/env node
'use strict';
// Create or update the Perfumes stack (EC2 + EBS + CloudFront + S3 + SSM).
//
//   npm run aws:deploy
//   npm run aws:deploy -- --instance-type t3.small --data-size 30
//
// Runtime secrets are read from .env, merged with what is already stored in
// the SSM SecureString, and written there before the instance first boots.
// Nothing sensitive is placed in the CloudFormation template or its parameters.

const fs = require('node:fs');
const path = require('node:path');
const {
  ROOT,
  TEMPLATE,
  DEFAULT_STACK,
  DEFAULT_REGION,
  parseArgs,
  aws,
  awsJson,
  awsStream,
  buildEnv,
  getParameter,
  putParameter,
  cloudFrontPrefixList,
  requireStack,
  waitForSite,
  fail,
  bold,
} = require('./lib');

function existingAmiId(stack, region) {
  const res = aws(['cloudformation', 'describe-stacks', '--stack-name', stack], {
    region,
    allowFailure: true,
  });
  if (res.status !== 0) return null;
  const parsed = JSON.parse(res.stdout);
  const found = parsed.Stacks && parsed.Stacks[0];
  if (!found) return null;
  const param = (found.Parameters || []).find((item) => item.ParameterKey === 'AmiId');
  return param ? param.ParameterValue : null;
}

function latestAmiId(region) {
  return aws(
    [
      'ssm',
      'get-parameter',
      '--name',
      '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64',
      '--query',
      'Parameter.Value',
      '--output',
      'text',
    ],
    { region },
  ).stdout.trim();
}

async function main() {
  const { opts } = parseArgs();

  if (opts.help) {
    console.log(`Usage: npm run aws:deploy -- [options]

  --stack <name>          CloudFormation stack name (default: perfumes)
  --region <region>       AWS region (default: us-east-1)
  --instance-type <type>  t3.micro | t3.small | t3.medium (default: t3.micro)
  --root-size <gb>        Root volume GB (default: 10)
  --data-size <gb>        Data volume GB (default: 20)
  --backup-days <days>    S3 backup retention (default: 30)
  --env-param <name>      SSM SecureString name (default: /perfumes/env)
  --env-file <path>       Local env file to push (default: .env)
  --repo <url>            Git URL cloned on first boot
  --ami <ami-id>          Explicit AMI (replaces the instance)
  --new-ami               Resolve the newest AL2023 AMI (replaces the instance)
  --prefix-list <pl-id>   Override the CloudFront origin-facing prefix list
  --skip-wait             Do not wait for CloudFront to answer
  --wait-seconds <n>      Readiness timeout (default: 1200)`);
    return;
  }

  const stack = String(opts.stack || DEFAULT_STACK);
  const region = String(opts.region || DEFAULT_REGION);
  const envParam = String(opts['env-param'] || '/perfumes/env');
  const repoUrl = String(opts.repo || 'https://github.com/iVGeek/pafam.git');
  const instanceType = String(opts['instance-type'] || 't3.micro');
  const dataSize = String(opts['data-size'] || 20);
  const rootSize = String(opts['root-size'] || 10);
  const retention = String(opts['backup-days'] || 30);

  console.log(bold('Perfumes on AWS'));
  console.log(`  region: ${region}`);
  console.log(`  stack:  ${stack}`);
  console.log(`  type:   ${instanceType}, root ${rootSize} GB + data ${dataSize} GB`);
  console.log('');

  // --- 0. credentials ------------------------------------------------------
  let identity;
  try {
    identity = awsJson(['sts', 'get-caller-identity'], { region });
  } catch (err) {
    if (/NoCredentials|Unable to locate credentials|ExpiredToken/i.test(err.message)) {
      fail(
        `no usable AWS credentials. Run "aws login" in this terminal, then retry.\n${err.message}`,
        2,
      );
    }
    throw err;
  }
  console.log(`account: ${identity.Account}`);
  console.log(`caller:  ${identity.Arn}`);
  console.log('');

  if (!fs.existsSync(path.join(ROOT, TEMPLATE))) fail(`template not found: ${TEMPLATE}`, 2);

  // --- 1. local validation -------------------------------------------------
  process.stdout.write('validating template... ');
  try {
    aws(['cloudformation', 'validate-template', '--template-body', `file://${TEMPLATE}`], { region });
    console.log('ok');
  } catch (err) {
    fail(`template validation failed:\n${err.message}`, 2);
  }

  const prefixList = String(opts['prefix-list'] || cloudFrontPrefixList(region));
  console.log(`CloudFront prefix list: ${prefixList}`);

  // ImageId replacement is the one stack update that would detach the data
  // volume, so the AMI is pinned: reuse the stack value unless asked otherwise.
  const currentAmi = existingAmiId(stack, region);
  let amiId;
  if (opts.ami) {
    amiId = String(opts.ami);
    if (currentAmi && currentAmi !== amiId) {
      console.log('');
      console.log(bold('WARNING: changing AmiId replaces the instance.'));
      console.log('The retained /var/data volume is NOT reattached automatically.');
      console.log('Take a backup (npm run aws:exec -- "systemctl start perfumes-backup") first.');
      console.log('');
    }
  } else if (opts['new-ami']) {
    amiId = latestAmiId(region);
    if (currentAmi && currentAmi !== amiId) {
      console.log('');
      console.log(bold('WARNING: --new-ami replaces the instance.'));
      console.log(`  current: ${currentAmi}`);
      console.log(`  new:     ${amiId}`);
      console.log('The retained /var/data volume is NOT reattached automatically; take a backup first.');
      console.log('');
    }
  } else {
    amiId = currentAmi || latestAmiId(region);
  }
  console.log(`AMI: ${amiId}${currentAmi ? ' (pinned from the stack)' : ' (resolved from the public SSM parameter)'}`);

  // --- 2. runtime env in SSM (SecureString) --------------------------------
  const existingText = getParameter(envParam, region, { withDecryption: true });
  const envFile = opts['env-file'] ? path.resolve(String(opts['env-file'])) : path.join(ROOT, '.env');
  const built = buildEnv({ envFile, existingText });

  putParameter(envParam, built.text, region, 'Perfumes container environment (managed by deploy/aws)');
  console.log(`runtime env: ${envParam} (${Object.keys(built.env).length} keys, SecureString)`);
  if (!built.env.AI_API_KEY) {
    console.log('  note: AI_API_KEY is empty - the assistant will answer without a model.');
  }

  // --- 3. stack ------------------------------------------------------------
  const overrides = [
    `AmiId=${amiId}`,
    `InstanceType=${instanceType}`,
    `RootVolumeSize=${rootSize}`,
    `DataVolumeSize=${dataSize}`,
    `RepoUrl=${repoUrl}`,
    `EnvParameterName=${envParam}`,
    `CloudFrontPrefixListId=${prefixList}`,
    `BackupRetentionDays=${retention}`,
  ];

  console.log('');
  console.log('creating/updating the stack. First deploy takes ~10-15 min because CloudFront');
  console.log('has to roll out; the instance builds its image during the same window.');
  console.log('');

  const code = await awsStream(
    [
      'cloudformation',
      'deploy',
      '--stack-name',
      stack,
      '--template-file',
      TEMPLATE,
      '--capabilities',
      'CAPABILITY_NAMED_IAM',
      '--no-fail-on-empty-changeset',
      '--parameter-overrides',
      ...overrides,
      '--tags',
      'Project=perfumes',
      'ManagedBy=aws-cloudformation',
    ],
    { region },
  );
  if (code !== 0) {
    fail(
      `stack deploy failed (exit ${code}). Inspect events with:\n` +
        `  aws cloudformation describe-stack-events --stack-name ${stack} --region ${region}`,
      1,
    );
  }

  const { stack: described, outputs } = requireStack(stack, region);
  console.log('');
  console.log(bold('Stack ready'));
  console.log(`  status:   ${described.StackStatus}`);
  console.log(`  site:     ${outputs.SiteUrl}`);
  console.log(`  instance: ${outputs.InstanceId}`);
  console.log(`  bucket:   ${outputs.BackupBucketName}`);
  console.log(`  env:      ${outputs.EnvParameterName}`);
  console.log(`  volume:   ${outputs.DataVolumeId}`);
  console.log('');

  if (built.generatedPassword) {
    console.log(bold('Generated bootstrap admin (fresh database)'));
    console.log(`  username: ${built.env.PTP_ADMIN_USER}`);
    console.log(`  password: ${built.env.PTP_ADMIN_PASS}`);
    console.log('  (stored in the SSM parameter, not in CloudFormation)');
    console.log('');
  }

  if (!opts['skip-wait']) {
    process.stdout.write('waiting for the app behind CloudFront');
    const ready = await waitForSite(outputs.SiteUrl, {
      timeoutMs: Number(opts['wait-seconds'] || 1200) * 1000,
    });
    console.log('');
    if (!ready.ok) {
      console.log(`  not ready yet (${ready.last}).`);
      console.log('  Watch the build with:');
      console.log(`    node deploy/aws/exec.js "tail -n 60 /var/log/perfumes-bootstrap.log"`);
      console.log(`    node deploy/aws/exec.js "docker ps -a; systemctl status perfumes --no-pager"`);
      console.log('  Then open the site URL above.');
    } else {
      console.log(`  app is answering: ${outputs.SiteUrl}`);
    }
  }

  console.log('');
  console.log(bold('Next'));
  console.log('  npm run aws:migrate     # copy the local SQLite database + uploads to the instance');
  console.log('  npm run aws:update      # rebuild after pushing to the repo');
  console.log('  node deploy/aws/exec.js "..."  # run a shell command on the instance');
  console.log('');
  console.log('Expected cost: free tier for 12 months (t3.micro 750 h, 30 GB EBS,');
  console.log('CloudFront 1 TB); afterwards roughly $13-15/month.');
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
