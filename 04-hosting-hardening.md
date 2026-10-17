# Hosting & Security Hardening

Operational runbook for putting Perfumes on the public internet and keeping it
there safely. It is **documentation and platform config only** — the application
code is unchanged; where the app already defends a control, this says so and
points at it, so the checklist reflects what is actually deployed.

Read alongside `README.md` (deploy notes) and `render.yaml` (the blueprint).

---

## 1. Topology and assumptions

- A single Node process (`server/index.js`) serving the JSON API under `/api`
  and the static SPA from `/public`.
- One SQLite database on a mounted persistent disk. No external DB, no cache,
  no queue — the process is stateless apart from the disk.
- TLS is terminated in front of the app (Render, or any reverse proxy such as
  nginx / Cloudflare). The app itself never terminates TLS.
- Because TLS terminates upstream, the app trusts the proxy for the client
  protocol and address (`trust proxy` is set in `server/index.js`). **Only run
  behind a proxy you control.**

Threat model in scope: credential stuffing / brute force, session theft,
unauthorised data access between roles, accidental data loss, dependency RCE
(notably the spreadsheet parser). Out of scope: DDoS at scale (handled at the
edge/CDN), and physical host security (the platform's responsibility).

## 2. Transport (TLS)

- Terminate TLS at the platform/proxy. Never expose the Node port directly.
- Force HTTPS: enable **"Always use HTTPS"** on Render (or the equivalent
  redirect at your proxy). Plain HTTP requests should 301 to HTTPS.
- Turn on HSTS at the proxy once the certificate is stable:
  `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
- The session cookie is `HttpOnly; SameSite=Lax` and gains `Secure` when
  `PTP_SECURE_COOKIES=1`, `NODE_ENV=production`, or `RENDER=true` (see
  `server/services/auth.js`). Always run production with the cookie `Secure`.
- Health check: `GET /api/auth/me` returns `200` with `{"user":null}` when the
  process is up, and requires no session. Use it as the platform health probe
  (already set in `render.yaml`).

## 2.1 Security response headers

These are best set at the TLS-terminating proxy / platform edge (the app does
not currently emit them, by design — see §12):

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=()
Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
```

The SPA loads only same-origin assets plus inline styles, so the CSP above fits.
Verify in a browser console after enabling; relax only `style-src` if a report
demands it. Suppress the framework banner with `X-Powered-By` removal (proxy).

---

## 3. Render configuration

`render.yaml` provisions one web service and a 1 GB disk. Tighten it as follows
(the committed blueprint already reflects these):

| Item | Setting | Why |
|------|---------|-----|
| `buildCommand` | `npm ci --omit=dev` | Reproducible install from `package-lock.json`; never `npm install` in prod |
| `startCommand` | `npm start` | Single known entry point |
| `plan` | `starter` or higher | **Persistent disks are not available on the free plan** |
| `disk.mountPath` | `/var/data` | Must match `PTP_DATA_DIR` |
| `healthCheckPath` | `/api/auth/me` | Cheap, auth-free liveness probe |
| `autoDeploy` | your call | Prefer a manual "deploy latest" gate for a trading system |
| `region` | closest to users | Latency + data-residency |
| `maxShutdownDelaySeconds` | e.g. `30` | Lets the process close cleanly on redeploy |

Environment variables:

| Key | Value | Notes |
|-----|-------|-------|
| `NODE_ENV` | `production` | Enables `Secure` cookies |
| `PTP_DATA_DIR` | `/var/data` | SQLite lives on the disk |
| `PTP_SECURE_COOKIES` | `1` | Belt-and-braces on top of `NODE_ENV` |
| `PTP_ADMIN_USER` | `admin` | Bootstrap admin login |
| `PTP_ADMIN_PASS` | **secret** | Set in the dashboard; never in the repo |
| `PTP_AUTO_SEED` | `true` first boot, then `false` | See §6 |
| `NPM_CONFIG_PRODUCTION` | `false` | Overrides the platform's deprecated `production` npm config, silencing the `npm warn config production Use --omit=dev instead` message |

**Optional — AI assistant.** To turn on the in-app assistant, set `AI_BASE_URL`,
`AI_API_KEY` and `AI_MODEL` to any OpenAI-compatible chat endpoint (GitHub
Models, OpenAI, Azure OpenAI, Groq, OpenRouter, or a local vLLM/Ollama). For a
free hosted model use GitHub Models: `AI_BASE_URL=https://models.github.ai/inference`,
`AI_MODEL=openai/gpt-4o-mini`, `AI_API_KEY` = a GitHub PAT with the `models:read`
scope. It is draft-and-confirm: the model reads through fixed tools and can only
*propose* quotes and supplier orders, which a human applies under their own role.
Omit the variables and the panel stays "not configured". No extra port or service
is required. (Locally these can live in a git-ignored `.env` file; the app loads
it on start and real environment variables always win.)

### 3.1 Container / Docker deployments

A `Dockerfile` and `.dockerignore` are included for container platforms
(Render Docker, Railway, Fly.io, Cloud Run, Kubernetes, …). The image:

- is built on `node:24-bookworm-slim` and installs with `npm ci --omit=dev`;
- sets `NODE_ENV=production`, `PORT=8080`, `PTP_DATA_DIR=/var/data` and
  `PTP_SECURE_COOKIES=1`, and **turns off the deprecated npm `production`
  config** so no deprecation warning is printed;
- keeps `samples/` (the two supplier files the first empty boot imports) and
  excludes `node_modules`, `.git`, `data/` and logs via `.dockerignore`;
- exposes `8080` and a `HEALTHCHECK` against `GET /api/auth/me` (40 s start
  period covers the first-run seed). Storage is mounted by the platform, not
  declared in the image — Railway rejects a Dockerfile `VOLUME`;
- runs `node --no-warnings server/index.js` directly (no npm at runtime, so no
  warning and clean signal handling), and drops from root to the unprivileged
  `node` user via `docker-entrypoint.sh`.

Build and run:

```
docker build -t perfumes .
docker run -p 8080:8080 -v perfumes-data:/var/data \
  -e PTP_ADMIN_PASS=<secret> perfumes
```

**Persistent storage is the whole game.** With no volume mounted at
`PTP_DATA_DIR`, the container re-seeds on every start and all edits are lost —
that is exactly the `Empty database detected — seeding sample data…` line in a
fresh log. Mount a volume (Railway: *Volume* on the service, mount `/var/data`;
Render: the blueprint's `disk`; Fly.io: a `[[mounts]]`) and point
`PTP_DATA_DIR` at it.

The image runs **unprivileged**: it starts as root only long enough for
`docker-entrypoint.sh` to `chown` the data directory to the `node` user, then
uses `gosu` to drop privileges before launching the app
(`exec gosu node node …`). This keeps the process non-root while still working
with host/platform-mounted volumes, which are typically owned by root. If the
orchestrator already runs the container as a non-root user, the entrypoint
simply execs the app as-is — so no volume-ownership setup is needed either way.

Platform notes:

- **Railway**: fully configured via `railway.json` — see §3.2 for the complete
  step-by-step setup (volume, variables, domain, backups).
- **Render Docker**: switch the service to *Docker* in the dashboard and mount
  the existing disk at `/var/data`.

### 3.2 Railway, step by step

[`railway.json`](railway.json) is committed as config-as-code. It tells Railway
to build the `Dockerfile` (`build.builder: DOCKERFILE`) and how to deploy
(`deploy`): a healthcheck at `/api/auth/me` with a 100 s timeout (enough for the
first-boot seed) and `restartPolicyType: ON_FAILURE` with 10 retries. Railway
reads it automatically when the service is created from the repo — no dashboard
build settings are needed.

**1. Create the project.**
New Project → *Deploy from GitHub repo* → pick this repository. Railway builds
the `Dockerfile` remotely (`npm ci --omit=dev` runs **inside the image**, nothing
on your machine). The first build takes 2–4 min (apt `gosu` + npm ci).

`railway.json` already pins the deploy shape: single replica, a 30 s graceful
shutdown (`drainingSeconds`) with zero overlap between deploys, and a
`requiredMountPath` of `/var/data` — so the **deploy fails fast if the volume is
missing**, instead of silently re-seeding. Nothing else needs configuring in the
dashboard for build or runtime behaviour.

**2. Attach a volume (required for persistence).**
Service → *Volumes* → **New Volume**, **mount path `/var/data`**. This is the
step that fixes `Empty database detected — seeding sample data…` on every
restart. The mount path must match `PTP_DATA_DIR` (below). A Railway volume is
pinned to one service and one replica, which is exactly the constraint SQLite
needs.

**3. Set service variables.** Service → *Variables* → add:

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | enables `Secure` cookies |
| `PTP_DATA_DIR` | `/var/data` | must equal the volume mount path |
| `PTP_SECURE_COOKIES` | `1` | Railway serves HTTPS, so this is safe |
| `PTP_ADMIN_USER` | `admin` | bootstrap login |
| `PTP_ADMIN_PASS` | *long random secret* | never commit; rotate after go-live |
| `PTP_AUTO_SEED` | `true` | set to `false` after the first successful boot |

`PORT` is injected by Railway — do **not** set it; the image reads `$PORT`.
`PTP_DATA_DIR` and `NODE_ENV` are already baked into the image but setting them
here keeps the volume path and environment explicit and visible.

**4. Generate a domain.** Service → *Settings* → *Networking* → **Generate
Domain**. Railway terminates TLS and forwards to the container's `$PORT`, so the
`Secure` session cookie works with no extra config. (Optionally add a custom
domain under the same panel.)

**5. Watch the first deploy.** The container starts as root, `chown`s
`/var/data` to the `node` user, drops privileges, seeds the sample supplier
files (15–25 s), then answers the healthcheck. Railway marks the deploy live only
once `/api/auth/me` returns 200.

**6. Lock in the seed.** Once you have confirmed the data, set
`PTP_AUTO_SEED=false` and redeploy so a future empty volume cannot silently
re-seed demo data over a live database.

**Replicas and scaling.** `railway.json` pins `numReplicas: 1` — a SQLite
database plus a mounted volume cannot be shared across replicas, and
`overlapSeconds: 0` prevents an old and new container from opening the database
at once during a deploy. Scale *up* (more CPU/RAM) if needed, not out. Give the
service ≥ 512 MB RAM; the seed step is the memory peak.

**Deploys after the first.** Push to the connected branch (or `railway up`) and
Railway rebuilds and rolls out. Because the volume persists, data is untouched;
schema changes are applied automatically on boot (`server/db.js`).

**Backups.** Railway does not back up volumes for you. Snapshot `ptp.db` from
the volume on a schedule — either a small cron service sharing the volume that
runs the `sqlite3 .backup` recipe in §6, or a periodic copy of `PTP_DATA_DIR` to
external storage. Do a restore drill before go-live (§6).

**CLI alternative.** With the [Railway CLI](https://docs.railway.com/guides/cli):
`railway login`, `railway link`, `railway variables --set PTP_ADMIN_PASS=…`,
`railway up`. Volumes are created in the dashboard, not the CLI.

---

## 4. Secrets and credentials

- **Never** commit `PTP_ADMIN_PASS` or any `.env`. `render.yaml` uses
  `sync: false` so the value is entered in the dashboard and stored encrypted.
- Set `PTP_ADMIN_PASS` to a long random value before the first deploy. If it is
  unset the app falls back to `admin123` (`server/services/auth.js →
  ensureBootstrapAdmin`), which is a demo default and must not survive to
  production.
- Rotate the admin password after go-live: Users page (admin) or
  `POST /api/auth/password` (self-service, requires the current password).
- Passwords are hashed with `scrypt` and compared in constant time
  (`crypto.timingSafeEqual`); there is no plaintext anywhere in the database.
- Give each operator their own account and role — do not share the admin login.
- Treat the session token like a password: it is a bearer credential.

---

## 5. Access control and sessions

- Role ladder: `viewer < analyst < buyer < admin`. Mutations are gated in the
  routes (`requireRole('buyer')` for writes, `analyst` for imports/reconciliation,
  `admin` for user management and settings). Only grant the minimum role needed.
- Login does not reveal whether a username exists — a bad user and a bad
  password both return the same `invalid username or password`.
- Session lifetime is the `session_hours` setting (default 168 h = 7 days).
  Shorten it for a shared machine; expired sessions are pruned on login.
- Enable MFA at the platform/dashboard layer if available; the app itself does
  not implement it.
- Disable accounts promptly on offboarding (`POST /api/users/:id` with
  `active:false`); disabled users cannot authenticate and their sessions fail
  `userFromToken`.

---

## 6. Data, backup and restore

The entire business state is the SQLite file (`ptp.db`) plus uploaded files
(`data/`) on the disk.

- **First deploy:** `PTP_AUTO_SEED=true` loads the two sample supplier lists so
  the service is usable immediately.
- **After go-live:** set `PTP_AUTO_SEED=false`. Auto-seeding is a convenience
  for empty demo databases; you never want sample data reappearing on a real
  instance. It only runs when the `users` table is empty, but turn it off
  anyway.
- SQLite runs in WAL mode. A naive copy of `ptp.db` while the process is live
  can miss the write-ahead log. Back up safely by either:
  1. `sqlite3 /var/data/ptp.db ".backup '/var/data/backups/ptp-$(date +%F).db'"`, or
  2. checkpointing then copying all three files:
     ```
     PRAGMA wal_checkpoint(TRUNCATE);
     cp ptp.db ptp.db-wal ptp.db-shm  backups/
     ```
- Schedule daily backups (Render cron job — an example is included, commented,
  in `render.yaml`) and **copy them off the disk** (object storage, another
  host). A backup on the same disk does not survive disk loss.
- Retain at least 14 daily + 12 monthly copies; encrypt at rest if the bucket is
  not private.
- **Test the restore** at least once: stop the service, replace `/var/data/ptp.db`
  with a backup, start, and confirm the dashboard/audit reflect the restored
  point in time. An untested backup is not a backup.
- Before any destructive migration or bulk import, take a fresh backup and note
  the filename in the change ticket.

---

## 7. Monitoring, logging and audit

- Platform health probe on `/api/auth/me`; add an external uptime check to the
  same URL and alert on 2+ minutes of failure.
- Application logs stream to the platform log viewer. The Express error handler
  returns a generic JSON body and logs the stack server-side — check logs after
  any 500s.
- Business-level audit trail: every significant action is written to the `audit`
  table (create/update of users, quotes, deals, placements, PFI reconciliations,
  inventory, …) and surfaced on the **Audit** page (admin). Review it after
  incidents and periodically for unexpected admin-gated actions.
- Watch for repeated `401`s on `/api/auth/login` (credential stuffing). See §8.
- Alert on disk-usage > 80% — WAL growth plus uploads can fill a small disk.

---

## 8. Abuse and rate-limiting

The app has no built-in login throttle. Because this is docs/config-only, place
one at the edge:

- Limit `POST /api/auth/login` to e.g. 10 requests/minute per IP, with a short
  ban on burst abuse (Cloudflare Rate Limiting, Render + a WAF, or nginx
  `limit_req`).
- Cap the request body size at the proxy as well as in the app (Express is set
  to a bounded JSON limit; uploads are size-capped in the importer routes).
- Consider geo/IP allow-listing if the operator base is known.

---

## 9. Dependency and patch management

- Runtime deps are intentionally few: `express`, `multer`, `xlsx`
  (`package-lock.json` pins exact versions).
- Run `npm audit` (and `npm audit fix` where safe) on a schedule; review
  breaking changes before bumping `express` or `xlsx`.
- `xlsx` parses untrusted supplier files — treat it as the highest-risk parser.
  Prefer imports from known suppliers, keep file-size caps, and patch promptly.
- Track Node LTS. The app uses the built-in `node:sqlite`, so the Node version is
  part of the security surface; pin it in `render.yaml`/`package.json` and apply
  security releases.
- Rebuild with `npm ci --omit=dev` on every deploy so the running set matches
  the lockfile.

---

## 10. Pre-launch checklist

- [ ] `PTP_ADMIN_PASS` set to a long random secret in the dashboard (not `admin123`).
- [ ] `NODE_ENV=production` and `PTP_SECURE_COOKIES=1`.
- [ ] TLS active; HTTP redirects to HTTPS; HSTS enabled.
- [ ] Security headers (§2.1) applied at the proxy.
- [ ] Health probe `/api/auth/me` wired to the platform + an external monitor.
- [ ] Persistent volume mounted at `/var/data`; `PTP_DATA_DIR=/var/data`.
- [ ] Build uses `npm ci --omit=dev` (container: the included `Dockerfile`).
- [ ] Container image healthcheck on `/api/auth/me` (baked into the `Dockerfile`).
- [ ] First backup taken and a restore rehearsed.
- [ ] Nightly off-disk backup + retention configured.
- [ ] Login rate-limit in place at the edge.
- [ ] One account per operator, least-privilege roles, sample logins removed.
- [ ] `PTP_AUTO_SEED=false` (after the initial seed).
- [ ] `npm audit` clean or exceptions documented.

---

## 11. Ongoing tasks

| Cadence | Task |
|---------|------|
| Daily | Confirm last night's backup succeeded and exists off-disk. |
| Weekly | Skim the Audit page; check disk usage and error logs. |
| Monthly | Patch Node + dependencies; test a restore; review user list & roles. |
| Quarterly | Rotate admin password and any platform tokens; review rate-limit logs. |
| On change | Fresh backup + rollback note before migrations/bulk imports. |

---

## 12. Why not in code?

The hardening here is deliberately platform/proxy configuration and process:
headers, TLS, rate-limiting and backups live at the edge and in the pipeline,
not in the app, so they are changed without a redeploy and survive code
rewrites. The application already carries its share — scrypt + constant-time
password checks, `HttpOnly`/`SameSite`/`Secure` cookies, role-gated routes,
generic auth errors, bounded request bodies, and a full audit trail. If a future
change moves any of the proxy controls into the app (e.g. an Express rate
limiter), update §2.1/§8 and the pre-launch checklist accordingly.
