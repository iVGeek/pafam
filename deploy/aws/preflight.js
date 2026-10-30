#!/usr/bin/env node
'use strict';
// Check that this account can actually run the Perfumes stack, before spending
// 15 minutes on a CloudFormation deploy that will fail on a policy.
//
//   npm run check:aws:perms
//   npm run check:aws:perms -- --region us-east-1
//
// Every check uses a dry run or a deliberately non-existent resource, so the
// script creates nothing and costs nothing. A "denied" line means an IAM or
// organization SCP policy is blocking that action; the exact policy ARN is
// printed when AWS tells us which one.

const { TEMPLATE, DEFAULT_REGION, parseArgs, aws, bold, fail } = require('./lib');

const DENY = /explicit deny|not authorized to perform|AccessDenied|UnauthorizedOperation/i;
const INCONCLUSIVE = /ParamValidation|InvalidParameterCombination|MissingParameter|InvalidAction/i;

const CHECKS = [
  { label: 'sts:GetCallerIdentity', args: ['sts', 'get-caller-identity'] },
  {
    label: 'cloudformation:ValidateTemplate',
    args: ['cloudformation', 'validate-template', '--template-body', `file://${TEMPLATE}`],
  },
  { label: 'cloudformation:DescribeStacks', args: ['cloudformation', 'describe-stacks', '--stack-name', 'perfumes'] },
  { label: 'ec2:DescribeVpcs', args: ['ec2', 'describe-vpcs'] },
  {
    label: 'ec2:DescribeManagedPrefixLists',
    args: [
      'ec2',
      'describe-managed-prefix-lists',
      '--filters',
      'Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing',
    ],
  },
  {
    label: 'ec2:RunInstances',
    args: [
      'ec2', 'run-instances', '--dry-run',
      '--image-id', 'ami-00000000000000000',
      '--instance-type', 't3.micro',
      '--min-count', '1', '--max-count', '1',
    ],
  },
  {
    label: 'ec2:CreateVolume',
    args: ['ec2', 'create-volume', '--dry-run', '--availability-zone', 'us-east-1a', '--size', '8', '--volume-type', 'gp3'],
  },
  {
    label: 'ec2:CreateSecurityGroup',
    args: ['ec2', 'create-security-group', '--dry-run', '--group-name', 'ptp-preflight', '--description', 'ptp-preflight', '--vpc-id', 'vpc-00000000'],
  },
  { label: 'iam:CreateRole', args: ['iam', 'delete-role', '--role-name', 'ptp-preflight-does-not-exist'] },
  { label: 's3:CreateBucket', args: ['s3api', 'create-bucket', '--bucket', 'amazon'] },
  { label: 's3:PutObject', args: ['s3', 'cp', 'README.md', 's3://ptp-preflight-does-not-exist/probe.txt', '--only-show-errors'] },
  { label: 'ssm:GetParameter', args: ['ssm', 'get-parameter', '--name', '/perfumes/env'] },
  {
    label: 'ssm:SendCommand',
    args: [
      'ssm', 'send-command',
      '--instance-ids', 'i-00000000000000000',
      '--document-name', 'AWS-RunShellScript',
      '--parameters', 'commands=echo preflight',
    ],
  },
  {
    label: 'cloudfront:CreateInvalidation',
    args: ['cloudfront', 'create-invalidation', '--distribution-id', 'E1PTPPREFLIGHTNONE', '--paths', '/*'],
  },
];

// Actions with no side-effect-free probe. They are exercised by the deploy
// itself, so they are reported separately rather than guessed at.
const MANUAL = [
  'kms:Encrypt / kms:Decrypt on alias/aws/ssm (SecureString parameter)',
  'iam:PassRole to ec2.amazonaws.com (instance profile)',
  's3:PutBucketPolicy / Versioning / Encryption / Lifecycle',
  'cloudfront:CreateDistribution / UpdateDistribution / DeleteDistribution',
  'ssm:StartSession (optional human shell access)',
];

function probe(args, region) {
  const res = aws(args, { region, allowFailure: true });
  const text = `${res.stdout}\n${res.stderr}`;

  if (res.status === 0) return { ok: true, detail: 'allowed' };

  if (INCONCLUSIVE.test(text)) {
    const code = /An error occurred \(([^)]+)\)/.exec(text);
    return { ok: false, detail: `probe inconclusive (${code ? code[1] : 'bad arguments'})` };
  }
  if (DENY.test(text)) {
    const scp = /service control policy:\s*(\S+)/i.exec(text);
    const iam = /with an explicit deny in an identity-based policy/i.test(text);
    return { ok: false, detail: `denied${scp ? ` by SCP ${scp[1]}` : iam ? ' by identity policy' : ''}` };
  }

  // The request reached the service and failed on the fake resource, which
  // means the caller is authorised for the action.
  const code = /An error occurred \(([^)]+)\)/.exec(text);
  return { ok: true, detail: `allowed (${code ? code[1] : 'reached service'})` };
}

function main() {
  const { opts } = parseArgs();
  const region = String(opts.region || DEFAULT_REGION);

  console.log(bold('Perfumes AWS permission preflight'));
  console.log(`  region: ${region}`);
  console.log('  every check is a dry run or a non-existent resource; nothing is created');
  console.log('');

  const failed = [];
  for (const check of CHECKS) {
    const result = probe(check.args, region);
    const mark = result.ok ? 'OK  ' : 'FAIL';
    console.log(`  [${mark}] ${check.label.padEnd(34)} ${result.detail}`);
    if (!result.ok) failed.push({ label: check.label, detail: result.detail });
  }

  console.log('');
  console.log('  Not probeable without creating something (verified during deploy):');
  for (const item of MANUAL) console.log(`    - ${item}`);

  console.log('');
  if (failed.length === 0) {
    console.log(bold('All probeable actions are permitted.'));
    console.log('Next: npm run aws:deploy');
    return;
  }

  console.log(bold(`${failed.length} action(s) blocked in ${region}:`));
  for (const item of failed) console.log(`  - ${item.label}: ${item.detail}`);
  console.log('');
  console.log('Send deploy/aws/SCP-EXCEPTION.md to the organization administrator.');
  console.log('The same block applies in every region, so changing --region will not help.');
  fail('the account cannot create the stack yet', 3);
}

main();
