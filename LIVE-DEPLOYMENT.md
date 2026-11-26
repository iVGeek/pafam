# Live deployment — current running instance

This documents the **actual** live hosting path as of this writing. It differs
from the aspirational CloudFormation stack in `deploy/aws/README.md` (which is
not deployed) and from `render.yaml` / `railway.json` (kept as alternative
blueprints only).

> The database currently on this instance contains **synthetic demo data** used
> to exercise features. It is **not** pilot evidence. The real L'Oréal pre-flood
> snapshot is kept separately (see *Backups*).

## Instance

| Item | Value |
|---|---|
| AWS account | `975779326611` (old accounts `856324327908` / `909421214276` abandoned — SCP `p-pzq2xcu4`) |
| Region | `eu-north-1` |
| Instance | `i-0717b140023060555` (name `pafam`) |
| AMI | Amazon Linux 2023 |
| Public IP | `13.60.208.92` |
| Private IP | `172.31.34.178` |
| IAM role | none (IMDSv2 required) |
| Security group | port 22 only — **no** public HTTP port |
| Public URL | `https://soa-land-sarah-sega.trycloudflare.com` (temporary Cloudflare quick tunnel) |
| Login | rotated random passwords — see *Credentials* below; the demo passwords in `05-user-manual.md` no longer work |

The Cloudflare quick-tunnel URL is **ephemeral**: it changes when the tunnel or
instance restarts. A stable hostname needs a Cloudflare account and a named
tunnel; that is not yet configured.

## Host layout

- Docker and Git installed on the host.
- Repo at `/opt/perfumes`; Docker image and container both named `perfumes`.
- Container runs `node --no-warnings server/index.js` from `/app`, port `8080`.
- Host `/var/data` is mounted to container `/var/data` (persistent disk).
- Runtime secrets and AI config live in `/opt/perfumes/.env` (never committed).
- Production AI chain: `AI_BASE_URL=https://openrouter.ai/api/v1`,
  `AI_MODEL=upstage/solar-mini-4-5`,
  `AI_MODELS=upstage/solar-mini-4-5,mistralai/mistral-nemo,mistralai/mistral-small-3.2-24b-instruct,openai/gpt-6-luna,anthropic/claude-haiku-5.5`,
  `AI_MAX_TOKENS=2048`. ZDR stays enabled in the OpenRouter account.
  `4096` was rejected with `weight_exceeds_budget` even with $99.82 credit
  remaining. The premium models were also rejected on request cost, so an
  ultra-cheap tool-capable model is primary (~$0.0001 per full turn); no top-up
  is needed. The earlier chain is retained as last-resort fallbacks.

## Credentials

The demo passwords documented in `05-user-manual.md` were **rotated** on this
instance before any client data was loaded. Each of the four accounts
(`admin`, `buyer`, `analyst`, `viewer`) now has an independent random
48-hex-character password. The secrets are stored **only** in the root-owned,
mode-600 file `/root/.ptp-credentials` on the EC2 host; they are deliberately
not in this repo, in `.env`, or in source code. `PTP_ADMIN_PASS` was removed
from `.env` so a fresh bootstrap generates its own random password and forces a
change at first login.

Retrieve them with (you need SSH access to the instance):

```bash
sudo cat /root/.ptp-credentials
```

The deploy helper sources this file for its login smoke check, so deploys keep
working after the rotation. If the instance is replaced, generate new secrets
and rotate the database users again — do not reuse these values.

## SSH access

From Windows (PowerShell):

```powershell
$key = "$env:USERPROFILE\Downloads\pafam.pem"
ssh -i $key ec2-user@13.60.208.92
```

Use `sudo` for host-level commands. Git operations under `/opt/perfumes` need
`sudo git` (the directory is root-owned) or add a safe.directory exception.

## Deploy a new version

The helper script lives on the host at `/tmp/deploy-update.sh`. It pulls the
repo, rebuilds the image, recreates the container, and runs smoke checks.

```powershell
$key = "$env:USERPROFILE\Downloads\pafam.pem"
ssh -o BatchMode=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=15 `
    -i $key ec2-user@13.60.208.92 'sudo bash /tmp/deploy-update.sh'
```

A successful deploy ends with `login HTTP 200`, the AI status showing the pinned
model chain, and three correct live counting answers (`35` on the current demo
dataset). Keep the SSH keepalive flags — the rebuild can be quiet for a while.

Manual container recreate (if the script is unavailable):

```bash
docker rm -f perfumes >/dev/null
docker run -d --name perfumes --restart unless-stopped \
  -p 8080:8080 -v /var/data:/var/data --env-file /opt/perfumes/.env perfumes
```

## Recover the public URL

`cloudflared` logs the quick-tunnel URL at startup:

```bash
sudo journalctl -u ptp-tunnel -n 300 --no-pager \
  | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
```

## Backups

- `ptp-backup.service` + `ptp-backup.timer` run daily at **23:00 UTC** with a
  14-day retention. The script is `/tmp/ptp-ec2-backup.sh`; the systemd units
  are in `/etc/systemd/system/` and survive reboots.
- Backups use `VACUUM INTO` via `docker exec perfumes node /app/scripts/backup-db.js`,
  producing consistent snapshots in `/var/data/backups/`.
- The real L'Oréal pre-flood snapshot is at
  `/var/data/pre-flood-archive/ptp-real-loreal-20261120-145423.db` **together
  with its `.db-wal` and `.db-shm` files** — keep all three together or the
  snapshot is incomplete.
- Check health: `systemctl is-active ptp-tunnel ptp-backup.timer`,
  `docker ps --filter name=perfumes`.

Useful live checks after every deploy (from the host; it has `python3` and
`curl`, but no standalone `node`):

- `GET /api/settings` as admin shows the real generated `capture_secret` (48
  hex chars); as viewer it shows `[redacted]`. The placeholder
  `change-me-capture-secret` is migrated to a random value on first boot.
- `GET /api/orders?limit=1000000` returns at most 500 rows.
- 11 rapid public registration attempts return ten `400`s then `429`.
- `/api/health` returns `401` without a session by design — use the login
  endpoint or `/api/auth/me` for an unauthenticated probe.

## Known blockers

- No AWS CLI credentials for account `975779326611`; the CLI default account is
  `856324327908` and profile `inferaa` is expired. Infrastructure changes must
  be done in the console or via SSH for now.
- Permanent CloudFront/S3 backup stack cannot be created until IAM access keys
  are provided. Local snapshots are the only off-instance-safe copy today
  (and even they are on the same host).
- Client real-data acceptance cannot start until the PO, base currency, FX
  rates, real transactions, supplier master, ≥5 months delivered history and
  acceptance thresholds arrive — see `CLIENT-DECISIONS-NEEDED.md` and
  `CLIENT-DATA-REQUEST-EMAIL.md`.
