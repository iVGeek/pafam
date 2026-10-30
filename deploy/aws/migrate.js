#!/usr/bin/env node
'use strict';
// Copy the local SQLite database (and optionally data/uploads) to the instance.
//
//   npm run aws:migrate
//   npm run aws:migrate -- --skip-uploads
//   npm run aws:migrate -- --db data/ptp.db --uploads data/uploads
//
// A consistent snapshot is taken with VACUUM INTO, uploaded to S3, then fetched
// by the instance itself. The previous database is kept on the data volume as
// /var/data/backups/ptp-pre-migrate-<timestamp>.db.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  ROOT,
  DEFAULT_STACK,
  DEFAULT_REGION,
  parseArgs,
  aws,
  requireStack,
  ssmRun,
  printCommandResult,
  waitForSite,
  sh,
  fail,
  bold,
} = require('./lib');

function run(command, args, label) {
  const res = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (res.error) fail(`${label} failed to start: ${res.error.message}`);
  if (res.status !== 0) fail(`${label} failed:\n${(res.stderr || res.stdout || '').trim()}`);
  return res;
}

async function main() {
  const { opts } = parseArgs();
  if (opts.help) {
    console.log(`Usage: npm run aws:migrate -- [options]

  --stack <name>          CloudFormation stack name (default: perfumes)
  --region <region>       AWS region (default: us-east-1)
  --db <path>             Local SQLite file (default: data/ptp.db)
  --uploads <dir>         Local uploads directory (default: data/uploads)
  --skip-db               Do not copy the database
  --skip-uploads          Do not copy uploads
  --timeout-seconds <n>   SSM command timeout (default: 900)`);
    return;
  }
  const stack = String(opts.stack || DEFAULT_STACK);
  const region = String(opts.region || DEFAULT_REGION);
  const dbPath = path.resolve(ROOT, String(opts.db || 'data/ptp.db'));
  const uploadsDir = path.resolve(ROOT, String(opts.uploads || 'data/uploads'));
  const skipDb = Boolean(opts['skip-db']);
  const skipUploads = Boolean(opts['skip-uploads']);

  if (skipDb && skipUploads) fail('nothing to migrate: both --skip-db and --skip-uploads were set');

  const { outputs } = requireStack(stack, region);
  const instanceId = outputs.InstanceId;
  const bucket = outputs.BackupBucketName;
  if (!instanceId || !bucket) fail(`stack ${stack} is missing InstanceId or BackupBucketName outputs`);

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  const dbKey = `migrate/ptp-${stamp}.db`;
  const uploadsKey = `migrate/uploads-${stamp}.tar.gz`;
  const cleanup = [];
  let didUploads = false;

  console.log(bold(`Migrating local data to ${instanceId}`));

  if (!skipDb) {
    if (!fs.existsSync(dbPath)) fail(`database not found: ${dbPath}`);
    const snapshot = path.join(os.tmpdir(), `perfumes-migrate-${stamp}.db`);
    run(process.execPath, ['--no-warnings', 'scripts/backup-db.js', snapshot], 'database snapshot');
    cleanup.push(snapshot);
    const bytes = fs.statSync(snapshot).size;
    console.log(`snapshot: ${dbPath} -> ${(bytes / 1024 / 1024).toFixed(2)} MB`);
    aws(['s3', 'cp', snapshot, `s3://${bucket}/${dbKey}`, '--only-show-errors'], { region });
    console.log(`uploaded: s3://${bucket}/${dbKey}`);
  }

  if (!skipUploads && fs.existsSync(uploadsDir) && fs.readdirSync(uploadsDir).length > 0) {
    const tarball = path.join(os.tmpdir(), `perfumes-uploads-${stamp}.tar.gz`);
    run('tar', ['-czf', tarball, '-C', uploadsDir, '.'], 'uploads archive');
    cleanup.push(tarball);
    aws(['s3', 'cp', tarball, `s3://${bucket}/${uploadsKey}`, '--only-show-errors'], { region });
    console.log(`uploaded: s3://${bucket}/${uploadsKey}`);
    didUploads = true;
  }

  // The instance performs the swap so the database never travels through the
  // local machine twice, and the old file is preserved before replacement.
  const lines = [
    'set -euo pipefail',
    `TS=${sh(stamp)}`,
    'systemctl stop perfumes.service || true',
    'mkdir -p /var/data/backups',
    'if [ -f /var/data/ptp.db ]; then cp -a /var/data/ptp.db "/var/data/backups/ptp-pre-migrate-$TS.db"; fi',
  ];

  if (!skipDb) {
    lines.push(
      'rm -f /var/data/ptp.db-wal /var/data/ptp.db-shm',
      `aws s3 cp ${sh(`s3://${bucket}/${dbKey}`)} /var/data/ptp.db --only-show-errors --region ${sh(region)}`,
      'chown 1000:1000 /var/data/ptp.db',
      'echo "database replaced"',
    );
  }

  if (didUploads) {
    lines.push(
      `aws s3 cp ${sh(`s3://${bucket}/${uploadsKey}`)} /tmp/perfumes-uploads.tar.gz --only-show-errors --region ${sh(region)}`,
      'rm -rf /var/data/uploads',
      'mkdir -p /var/data/uploads',
      'tar -xzf /tmp/perfumes-uploads.tar.gz -C /var/data/uploads',
      'chown -R 1000:1000 /var/data/uploads',
      'rm -f /tmp/perfumes-uploads.tar.gz',
      'echo "uploads restored"',
    );
  }

  lines.push(
    'systemctl start perfumes.service',
    'for i in $(seq 1 45); do',
    '  if curl -fsS --max-time 5 http://127.0.0.1/api/auth/me >/dev/null 2>&1; then',
    '    echo "app healthy"; exit 0',
    '  fi',
    '  sleep 2',
    'done',
    'echo "app did not become healthy" >&2',
    'docker logs --tail 80 perfumes >&2 || true',
    'exit 1',
  );

  const result = await ssmRun({
    instanceId,
    region,
    comment: 'perfumes data migration',
    timeoutMs: Number(opts['timeout-seconds'] || 900) * 1000,
    commands: [lines.join('\n')],
  });
  printCommandResult(result);

  for (const file of cleanup) fs.rmSync(file, { force: true });

  if (!result.ok) fail(`migration failed (status ${result.status}); the pre-migration database is on the volume`);

  const ready = await waitForSite(outputs.SiteUrl, { timeoutMs: 180 * 1000 });
  if (!ready.ok) fail(`app migrated but not answering at ${outputs.SiteUrl} (${ready.last})`);

  console.log('');
  console.log(bold('Migration complete'));
  console.log(`  site:    ${outputs.SiteUrl}`);
  console.log('  sign in with the users from the migrated database (admin/admin123 unless you');
  console.log('  changed it locally). To reset the password:');
  console.log(`    node deploy/aws/exec.js "docker exec perfumes node --no-warnings scripts/set-password.js admin 'NEW-PASSWORD'"`);
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
