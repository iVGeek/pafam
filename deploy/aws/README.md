# Perfumes on AWS (free tier)

One CloudFormation stack hosts the whole platform in **us-east-1**, without a
domain:

```
browser ──HTTPS──> CloudFront (dxxxx.cloudfront.net, AWS certificate)
                        │  HTTP, origin port 80 open only to CloudFront's
                        │  managed prefix list (no 0.0.0.0/0, no SSH)
                        ▼
                 EC2 t3.micro (Amazon Linux 2023)
                   └── docker: node:24 image, port 8080
                         └── /var/data  <- 20 GB gp3 EBS (retained)
                               ptp.db, uploads/, backups/

                 S3  <── daily 03:15 UTC backup (db + uploads)
                 SSM <── /perfumes/env SecureString (secrets)
                 SSM <── shell access, deploy, migrate (no inbound admin port)
```

Everything in `deploy/aws/` is plain Node + the AWS CLI. There is no Terraform,
CDK, Docker or SSH requirement on your machine.

## Cost

| Resource | Free tier | After 12 months |
| --- | --- | --- |
| EC2 t3.micro | 750 h/month | ~$7.59/month |
| EBS gp3 30 GB (10 root + 20 data) | 30 GB | ~$2.40/month |
| Public IPv4 (Elastic IP) | 750 h/month | ~$3.65/month |
| CloudFront (PriceClass_100) | 1 TB out + 10M requests/month | usage-based, usually cents |
| S3 backups | 5 GB | cents (a 2.5 MB DB/day) |
| SSM, CloudWatch metrics | free | free |

First 12 months: **$0**. Afterwards: roughly **$13–15/month**. No NAT gateway,
ALB or managed database is created.

## Prerequisites

1. **AWS CLI 2.32+** — the installed `aws` is 2.39.
2. **Credentials** — `aws login` (interactive, valid up to 12 hours):
   ```bash
   aws login
   aws sts get-caller-identity
   ```
3. **Permissions** — the identity must be allowed to manage CloudFormation,
   EC2/VPC, EBS, IAM roles/instance profiles, S3, CloudFront and SSM. An
   administrator or `PowerUserAccess` + IAM role creation is enough.
4. **Node 24** — already required by the app.
5. Nothing else: the instance clones the public repo from GitHub, builds the
   existing `Dockerfile`, and reads its secrets from SSM.

## First deploy

```bash
npm run aws:deploy
```

What it does:

1. validates `deploy/aws/perfumes.yaml` with `aws cloudformation validate-template`;
2. resolves the CloudFront origin-facing prefix list for the region;
3. merges `.env` with the existing SSM value and writes `/perfumes/env` as an
   **SSM SecureString** (secrets never enter the template or its parameters);
4. creates/updates the stack (`CAPABILITY_NAMED_IAM`);
5. prints the CloudFront URL and waits until `/api/auth/me` answers.

Options:

```bash
npm run aws:deploy -- --instance-type t3.small     # more RAM, still cheap
npm run aws:deploy -- --data-size 30               # bigger data volume
npm run aws:deploy -- --backup-days 60             # S3 retention
npm run aws:deploy -- --region us-east-1 --stack perfumes
npm run aws:deploy -- --skip-wait                  # do not wait for CloudFront
```

The first run takes **10–15 minutes**: CloudFront rolls out while the instance
installs Docker, mounts the data volume, builds the image and starts the app.

If no `PTP_ADMIN_PASS` exists in `.env` or in SSM, a strong one is generated and
printed once. It only matters if the database is empty; migrating the local
database keeps its existing users.

## Migrate the local data

```bash
npm run aws:migrate
```

This:

1. takes a consistent SQLite snapshot with `VACUUM INTO` (safe while the local
   server is running);
2. uploads it and `data/uploads` to `s3://<bucket>/migrate/`;
3. stops the container on the instance, keeps the current database as
   `/var/data/backups/ptp-pre-migrate-<timestamp>.db`, swaps in the snapshot,
   restores uploads, and starts the container;
4. waits until the app answers through CloudFront.

Credentials are the ones from the migrated database (`admin` / `admin123` unless
changed). To reset without SSH:

```bash
node deploy/aws/exec.js "docker exec perfumes node --no-warnings scripts/set-password.js admin 'NEW-PASSWORD'"
```

Useful flags: `--skip-uploads`, `--skip-db`, `--db <path>`, `--uploads <dir>`.

## Day 2

### Deploy a new version

```bash
git push origin main
npm run aws:update
```

`update.js` runs `/usr/local/bin/perfumes-deploy.sh` over SSM: `git fetch` +
`reset --hard`, reinstall host scripts, refresh env from SSM, `docker build`,
`systemctl restart perfumes`, health check. No inbound port is opened.

### Change secrets or AI settings

```bash
# edit .env, then push it to SSM and restart
npm run aws:env
```

Or, without restarting: `npm run aws:env -- --no-restart` and restart later with
`node deploy/aws/exec.js "systemctl restart perfumes"`.

### Logs and diagnostics

```bash
node deploy/aws/exec.js "docker ps -a; systemctl status perfumes --no-pager"
node deploy/aws/exec.js "docker logs --tail 200 perfumes"
node deploy/aws/exec.js "tail -n 100 /var/log/perfumes-bootstrap.log"
node deploy/aws/exec.js "systemctl list-timers --all | grep perfumes"
node deploy/aws/exec.js "df -h /var/data; free -m"
```

`npm run aws:exec -- "..."` is equivalent.

### Backups

A systemd timer runs `perfumes-backup.sh` daily at **03:15 UTC** (persistent, so
it catches up after downtime). It writes:

- `s3://<bucket>/backups/ptp-<timestamp>.db` — consistent database snapshot
- `s3://<bucket>/backups/uploads-<timestamp>.tar.gz` — uploaded files, when any

The bucket is versioned, TLS-only, private, and expires objects after
`BackupRetentionDays` (default 30). The instance keeps the last 7 days locally in
`/var/data/backups`. Run one now:

```bash
node deploy/aws/exec.js "systemctl start perfumes-backup"
```

List backups:

```bash
node deploy/aws/exec.js "aws s3 ls s3://<bucket>/backups/ --region us-east-1"
```

Restore a database (replace `<timestamp>`):

```bash
node deploy/aws/exec.js "systemctl stop perfumes && cp -a /var/data/ptp.db /var/data/backups/ptp-pre-restore.db && aws s3 cp s3://<bucket>/backups/ptp-<timestamp>.db /var/data/ptp.db --region us-east-1 && rm -f /var/data/ptp.db-wal /var/data/ptp.db-shm && chown 1000:1000 /var/data/ptp.db && systemctl start perfumes"
```

Restore uploads:

```bash
node deploy/aws/exec.js "aws s3 cp s3://<bucket>/backups/uploads-<timestamp>.tar.gz /tmp/u.tar.gz --region us-east-1 && rm -rf /var/data/uploads && mkdir -p /var/data/uploads && tar -xzf /tmp/u.tar.gz -C /var/data/uploads && chown -R 1000:1000 /var/data/uploads && rm -f /tmp/u.tar.gz"
```

### Server access

Use SSM `send-command` (already wrapped by `exec.js`). `aws ssm start-session`
also works if you install the Session Manager plugin locally. SSH is never
opened, and the instance has no key pair.

## Data safety rules

- **The EBS data volume is retained** when the stack is deleted or the instance
  is replaced (`DeletionPolicy: Retain`). That protects the bytes, but
  CloudFormation does **not** reattach a retained volume to a replacement
  instance automatically.
- **The AMI is pinned.** `deploy.js` reuses the `AmiId` already stored in the
  stack, because changing it replaces the instance. Only pass `--new-ami` (OS
  upgrade) when you are ready to reattach the volume by hand.
- Changing `RepoUrl`, instance type, env parameter name or tags does **not**
  replace the instance. Changing `RepoUrl` only affects the first boot of a
  replacement instance.
- If a replacement ever happens: stop the new instance, detach its fresh volume,
  attach the retained `perfumes-data` volume as `/dev/sdf`, start it, and the
  bootstrap label mount picks it up on the next boot (or mount it manually).
- Take a backup before every stack change that touches compute.

## Tear down

```bash
aws cloudformation delete-stack --stack-name perfumes --region us-east-1
aws cloudformation wait stack-delete-complete --stack-name perfumes --region us-east-1
```

This deletes the instance, CloudFront distribution, VPC and Elastic IP. The data
volume and S3 bucket are **retained** (and still cost money). Delete them
manually only after downloading a final backup:

```bash
aws ec2 describe-volumes --filters Name=tag:Name,Values=perfumes-data --region us-east-1
aws s3 rm s3://<bucket> --recursive
aws s3 rb s3://<bucket>
```

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `NoCredentials` | Run `aws login`, then `aws sts get-caller-identity`. |
| Stack stuck in `CREATE_IN_PROGRESS` for 10+ min | Normal for CloudFront. `aws cloudformation describe-stack-events --stack-name perfumes`. |
| Stack `ROLLBACK_COMPLETE` | Read the first `*_FAILED` event. A failed stack must be deleted before re-creating. |
| Site shows 502/503 from CloudFront | Origin not up yet or security group wrong. `node deploy/aws/exec.js "systemctl status perfumes; tail -n 80 /var/log/perfumes-bootstrap.log"`. |
| 403 from CloudFront | The request is hitting a port/prefix-list mismatch, or CloudFront's origin DNS still points at the pre-EIP address. Re-run `npm run aws:deploy` after the EIP is associated. |
| Login redirects but no session | CloudFront must redirect HTTP→HTTPS; the app sets `PTP_SECURE_COOKIES=1`. Always use the `https://*.cloudfront.net` URL. |
| App answers locally but CloudFront 502 | `curl -I http://127.0.0.1` on the instance; check `docker ps` and `iptables`/SG. |
| `docker build` killed | Swap missing: `free -m`, re-run `bash deploy/aws/instance/bootstrap.sh`. |
| Uploads fail | CloudFront accepts request bodies up to 64 GB; the app's JSON limit is 5 MB and multer handles Excel uploads. Check `docker logs`. |
| Migration says app unhealthy | `docker logs --tail 100 perfumes`; the pre-migration DB is in `/var/data/backups/`. |

## Security posture

- No inbound SSH, no key pair, no `0.0.0.0/0` ingress. Port 80 accepts only the
  CloudFront origin-facing prefix list.
- The EC2 hop is HTTP inside the VPC; viewers always use TLS at CloudFront.
- Secrets live in one SSM SecureString (`/perfumes/env`), readable only by the
  instance role via `ssm:GetParameter` + KMS `ViaService=ssm`.
- IMDSv2 is required with hop limit 1, so containers cannot fetch instance
  credentials.
- S3: public access blocked, SSE, versioning, TLS-only bucket policy, lifecycle
  expiration; retained on stack delete.
- The instance is patched by rolling a new AMI deliberately (`--new-ami`) or by
  `dnf update` over SSM; routine app deploys rebuild the container.
- Single instance, single writer: plan a short maintenance window for updates.
  SQLite is fine for this workload, but there is no multi-AZ failover.

## Files

| File | Purpose |
| --- | --- |
| `perfumes.yaml` | VPC, EC2, EBS, EIP, CloudFront, S3, IAM, SSM outputs |
| `deploy.js` | create/update the stack, push runtime env, wait for the site |
| `update.js` | rebuild/restart the app from a branch over SSM |
| `env.js` | push `.env` to SSM and restart |
| `migrate.js` | snapshot local DB + uploads, restore on the instance |
| `exec.js` | run any shell command on the instance over SSM |
| `lib.js` | AWS CLI, SSM, env and stack helpers |
| `instance/bootstrap.sh` | first-boot host setup (swap, volume, systemd, image) |
| `instance/perfumes-deploy.sh` | on-instance rebuild script |
| `instance/perfumes-refresh-env.sh` | SSM SecureString → `/opt/perfumes/.env` |
| `instance/perfumes-backup.sh` | DB snapshot + uploads → S3 |
| `instance/*.service`, `*.timer` | systemd units for the app and backups |
