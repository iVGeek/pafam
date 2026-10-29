# Perfumes

A bespoke, standalone wholesale trading platform for fine fragrance: it
ingests messy supplier price lists, resolves products by barcode, normalises
unit vs case vs RRP pricing, compares suppliers, and prices deals to a margin
policy. No Odoo, no external services — one Node process and one SQLite file.

## Quick start

```powershell
npm install          # express, multer, xlsx
npm run seed         # reset DB and import the two sample supplier lists + demo data
npm start            # http://localhost:4173
```

Then open http://localhost:4173

New to the system? The step-by-step, screenshot-illustrated
[**User Manual**](05-user-manual.md) walks through every screen.

Other scripts:

| Command | Purpose |
|---|---|
| `npm run seed` | Wipe `data/ptp.db`, re-import `samples/`, add demo customers/demands/inventory |
| `npm start` | Start the web app (API + UI) on port 4173 (`PORT` env to change) |
| `npm run import` | Headless importer spike / data-quality report (writes `output/`) |
| `npm run gen:samples` | Regenerate the two demo perfume supplier lists under `samples/` (deterministic) |
| `npm test` | Unit tests for the GTIN, pack-size, pricing, reservation, forecast and integrity engines (runs against a throwaway database; the first run seeds it from the sample files and caches a fixture, later runs take ~1s. Set `PTP_TEST_NO_CACHE=1` to force a fresh seed) |

## Deploy on Render

A [`render.yaml`](render.yaml) blueprint is included. Push the repo, then in
Render choose **New → Blueprint** and pick it. For TLS, security headers,
secrets, backups, rate-limiting and the pre-launch checklist, follow
[`04-hosting-hardening.md`](04-hosting-hardening.md).

Important settings for a hosted instance:

| Env var | Value | Why |
|---|---|---|
| `PTP_DATA_DIR` | `/var/data` | Point SQLite at the mounted persistent disk (Render's default filesystem is ephemeral) |
| `PTP_ADMIN_PASS` | *(secret)* | Password for the seeded `admin` account |
| `PTP_SECURE_COOKIES` | `1` | Send the session cookie over HTTPS only |
| `PTP_AUTO_SEED` | `true` | Load supplier lists + demo data on the first (empty) boot |
| `PTP_SEED_DEMO_USERS` | `false` | Optional: skip the demo buyer/analyst/viewer accounts |

Node **24.x** is pinned via `engines` in `package.json` (the app uses the
built-in `node:sqlite`).

Notes:

- **Persistent disk:** the blueprint mounts a 1 GB disk at `/var/data`, which
  requires a paid plan. On the **free** plan there is no disk — leave
  `PTP_DATA_DIR` unset, and the app will simply re-seed on every cold start
  (fine for a demo; edits are not retained).
- First boot imports the two sample files, which takes ~10–15 s. The service
  reports healthy at `/api/auth/me` once it starts listening.
- Set `PTP_ADMIN_PASS` before the first deploy (or change it in the UI right
  after). If unset, the seeded/admin password falls back to `admin123`.

## Deploy with Docker

A [`Dockerfile`](Dockerfile) and [`.dockerignore`](.dockerignore) are included
for any container platform (Railway, Fly.io, Cloud Run, Kubernetes, Render
Docker). The image installs with `npm ci --omit=dev`, runs as a container, and
serves on `$PORT` (default `8080`):

```sh
docker build -t perfumes .
docker run -p 8080:8080 -v perfumes-data:/var/data -e PTP_ADMIN_PASS=changeme perfumes
```

Mount a volume at `PTP_DATA_DIR` (`/var/data`) so the SQLite database and
uploads survive restarts — without it the container re-seeds on every start and
edits are lost. See
[`04-hosting-hardening.md`](04-hosting-hardening.md) §3.1 for platform notes
(Railway, Render Docker) and the volume/ownership details.

## Deploy on Railway

A [`railway.json`](railway.json) config-as-code file is included; it builds the
[`Dockerfile`](Dockerfile) and deploys it with a healthcheck. Full step-by-step
setup (volume, variables, domain, backups) is in
[`04-hosting-hardening.md`](04-hosting-hardening.md) §3.2.

Quick path:

1. **New Project → Deploy from GitHub repo**, pick this repository. Railway
   reads `railway.json` and builds the image.
2. **Add a Volume** to the service, mounted at **`/var/data`**.
3. **Variables** (service → Variables):

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `PTP_DATA_DIR` | `/var/data` |
   | `PTP_SECURE_COOKIES` | `1` |
   | `PTP_ADMIN_USER` | `admin` |
   | `PTP_ADMIN_PASS` | *a long random secret* |
   | `PTP_AUTO_SEED` | `true` (first boot), then `false` |

4. **Settings → Networking → Generate Domain.** Railway serves HTTPS, so the
   `Secure` cookie and TLS work out of the box.
5. First deploy seeds the sample data (15–25 s); the healthcheck at
   `/api/auth/me` gates the release.

Optional: add `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` to enable the AI
assistant (any OpenAI-compatible endpoint).

The container listens on Railway's injected `$PORT` and starts unprivileged
(the entrypoint chowns `/var/data` to the `node` user). Railway runs a single
replica, which is what a SQLite volume requires.

## Search and the AI assistant

- **In-window search.** One box in the top bar filters whatever screen is open
  (table rows and cards, matched on any text), with a shown/total count; the
  large tables also get their own filter row. No configuration needed.
- **AI assistant.** A chat panel (bottom-right) answers questions over live data
  and *prepares* quotes, supplier orders, customer demands, customer orders and
  follow-up tasks as drafts you confirm with **Apply**. Replies stream in token
  by token (SSE) with a typing indicator, rendered markdown, a live line naming
  the tool being used, and a transcript kept in localStorage. It is
  **draft-and-confirm**: the model never writes to the database, and Apply runs
  the normal, role-checked API as you (so saving still needs the *buyer* role
  and is audited). Beyond the catalogue it reads the dashboard, alerts,
  exceptions, captures, tasks, inventory, orders, the purchase plan, price
  trends, forecasts and quote comparisons — and it can tell you where to
  download any report or document as **Excel or PDF**. It talks to any
  OpenAI-compatible endpoint (OpenAI, Azure OpenAI, Groq, OpenRouter, or a
  local vLLM/Ollama):

| Env var | Meaning | Default |
|---|---|---|
| `AI_BASE_URL` | API base URL | `https://api.openai.com/v1` |
| `AI_API_KEY` | Provider key (leave empty for a local server) | — |
| `AI_MODEL` | Primary model name | `gpt-4o-mini` |
| `AI_MODELS` | Ordered fallback chain (comma separated); wins over `AI_MODEL` | — |
| `AI_AUTO_DISCOVER` | If every configured model is retired/paid/throttled, pick a free tool-capable model from the provider catalogue automatically (`0` disables) | `1` |
| `AI_AUTO_DISCOVER_MAX` | How many catalogue models to try when self-healing | `2` |
| `AI_MAX_STEPS` | Max tool rounds per turn (raise for wide multi-line drafts) | `12` |
| `AI_TIMEOUT_MS` | Per-attempt timeout | `45000` |

When the primary model is retired, turned paid or throttled, the assistant
silently moves to the next model in `AI_MODELS` and the chat header shows which
one answered (`+N fallback`). If **every** configured model is stale, it asks
the provider for the current catalogue, switches to a working free model that
supports tool calls, and keeps using it until the process restarts — so a
retired free model no longer breaks the assistant. If nothing works, the error
says exactly why (retired / paid-only / rate-limited / bad key) instead of a
generic provider error. **Free catalogues churn** — run `npm run check:ai` any
time the assistant stops working; `npm run check:ai -- --write` repairs `.env`
with a working free model. `GET /api/ai/diagnose` returns the same report as
JSON (signed-in users only, no key material).

Provider examples:

| Provider | `AI_BASE_URL` | `AI_MODEL` | Key |
|---|---|---|---|
| **GitHub Models** (free) | `https://models.github.ai/inference` | `openai/gpt-4o-mini` | GitHub PAT with the `models:read` scope |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | OpenAI key |
| Groq (free tier) | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | Groq key |
| OpenRouter (cheap paid) | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` | OpenRouter key |
| OpenRouter (free) | `https://openrouter.ai/api/v1` | `nvidia/nemotron-3.5-lightning:free` | OpenRouter key |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-1.5-flash` | Google key |
| Ollama (local) | `http://localhost:11434/v1` | `llama3.1` | *(none)* |

A small paid model such as `openai/gpt-4o-mini` costs well under a cent per
question and does not hit the free-tier daily limit; keep free `:free` models
later in `AI_MODELS` as fallbacks. Locally, put these in a `.env` file at the
project root (it is git-ignored and loaded on start); on Railway/Render set them
as dashboard variables. Free model lists rotate — `npm run check:ai` lists
current free models that support tool/function calling (that capability is
mandatory; without it the assistant cannot read the business).

Until `AI_BASE_URL` or `AI_API_KEY` is set, the panel opens but reports **not
configured**. See the [User Manual](05-user-manual.md) §§24–25.

## What it does

- **Import** supplier `.xls`/`.xlsx` price lists with auto header-row detection
  and per-vendor profiles (`src/importers/profiles.js`). Re-importing an
  identical file is ignored (SHA-256 dedupe).
- **Auto-clean every import to the standard template.** On import (auto-pilot)
  each upload is rewritten onto the standard supplier template — the column set,
  enums and field guide in `supplier-template.xlsx` — into
  `data/cleaned/<supplier>-upload-<id>.xlsx`, with brand, fragrance,
  concentration, size, gender, retail-pack/tester and enum values normalised.
  Download it from the import list ("Template") or
  `GET /api/export/cleaned/:uploadId.xlsx`. Toggle with the `auto_clean_imports`
  setting. See `server/services/template.js`.
- **Validate** every barcode with the GS1 check digit and canonicalise to
  GTIN-14; blanks and failures go to an **exception queue**.
- **Match** offers onto a shared **product master** by canonical GTIN, so the
  same bottle from two suppliers becomes one product.
- **Normalise** pricing: unit vs case (divided by units-per-case, parsed from
  the description when needed) and RRP → cost via a supplier trade discount.
- **Compare** offers per product with explicit comparability flags, and flag
  implausible spreads (likely price-basis mismatches) for review instead of
  reporting fantasy savings.
- **Price deals**: landed cost build-up (Incoterm-aware), margin/markup, ROI &
  annualised ROI, enforced against a configurable margin/markup policy. Deal
  contribution subtracts deal costs (outbound delivery, commission, fees,
  storage, financing, expected credit loss) and reports return on deployed
  capital — the §9 worked example reconciles to the cent (see tests).
- **Source cheapest**: lowest *executable* landed cost per product & quantity,
  with MOQ/stock/expiry/eligibility checks and missing-input flags.
- **Model the money**: dated cash-flow schedule, peak capital and capital days,
  contribution, plus conservative/base/upside scenarios and price-drop and
  customer-default stress cases (never presented as forecasts).
- **Trade**: inventory lots, customers, a demand book and quotes.
- **Hold stock**: **reservations** tie stock in a lot to a demand or order so
  two traders cannot sell the same bottle. Active reservations can never exceed
  usable stock (`on hand − quarantined`); in-transit stock is not sellable
  until received. Reservations can be released or fulfilled, and every change
  is audited.
- **Never lose the thread**: a demand is **revised by superseding it**, not by
  editing it. The previous version is retained and linked, so you can always see
  what was believed and when. Once a demand is on an order it is **locked** and
  cannot be rewritten — raise a new demand instead.
- **Staff sign-off**: offers carry an approval state (`review` / `approved` /
  `rejected`) with who signed off and when, separate from the matching outcome.
  Turn on `require_offer_approval` and an unapproved offer can no longer win a
  sourcing comparison or drive a buying recommendation. An offer with no price
  or no valid barcode can never be approved.
- **Track prices**: an immutable `price_history` records every observed price;
  **alerts** flag price movements, expiries and low stock, and the **price
  trends** view shows 7/30/90/180-day movement with real date gaps (no invented
  points).
- **Close the loop**: **orders** with payments booked in/out, comparing
  *forecast* to *realised* margin from cash actually moved. Where the dated
  payments support it, each settled order also reports a money-weighted **XIRR**
  and how many days capital was actually funded; where they do not (same-day
  movements, missing dates, still-open orders) it reports *why* instead of a
  misleading number.
- **Decide what to buy**: **buying recommendations** match each demand to the
  cheapest *executable* supplier, rounding up to MOQ/order multiples, selling
  against the customer target or a policy floor, and flagging anything that
  breaches margin policy or the capital limit. The **purchase plan** consolidates
  all demand into one buying list with shortfalls, cash requirement and totals.
- **Allocate shipment costs** (§8.2): a shipment's freight, duty, insurance,
  brokerage or handling is split across the lines it carries by **one documented
  driver** — chargeable weight, volume or declared value. Allocations always
  reconcile back to the shipment total (rounding remainder lands on the largest
  line); anything that does not tie is reported, never hidden.
- **Measure**: a **KPI suite** (profitability, cash & capital, stock, buying &
  quality) and a deliberately conservative **demand forecast** — a moving
  average of delivered quantity that refuses to extrapolate when there are not
  enough delivery months, saying so instead of inventing a number.
- **Report & export**: every report and document downloads as **both Excel
  (`.xlsx`) and PDF** — opportunities, lowest landed cost, deals, orders, alerts,
  the **cost-masked customer quotation** (which never reveals supplier names or
  buying costs), supplier placements and cleaned supplier imports. Any screen's
  current table (with the live search applied) can be exported the same way via
  `POST /api/export/table?format=xlsx|pdf`, and the UI's **Excel / PDF** bar does
  it in one click.
- **Integrate**: a cash-basis **GL journal** export (double-entry from payments)
  and a **stock snapshot** export for a WMS/stocktake, and a machine-readable
  `/api/integrations` contract covering every export and the inbound **capture
  webhook**. Honest endpoints, no pretend connectors.
- **Capture notes** (Plaud / reMarkable / manual / webhook) and turn them into
  demand signals via a heuristic parser (`src/lib/notes.js`) — quantity, price,
  barcode, customer and product hints for a human to confirm. A captured note
  that looks like a lead automatically opens a **follow-up task** with a due
  date, and promoting the note to a demand closes the task, so nothing rots in
  the inbox. Overdue tasks are flagged, never dropped.
- **Find it fast**: an **in-window search** box in the top bar filters whatever
  screen is open (tables and cards), and the big tables carry their own filter.
- **Ask for it**: an optional **AI assistant** (any OpenAI-compatible endpoint)
  answers questions over live data with a **streaming chat** (typing indicator,
  rendered markdown, per-tool activity, transcript kept in the browser) and
  prepares quotes, supplier orders, demands, customer orders and follow-up
  tasks as **drafts a human applies** — it reads through fixed tools and never
  writes.
- **Access control**: session login with roles (`viewer < analyst < buyer <
  admin`); sensitive write endpoints are rank-guarded.

## Sign in

After `npm run seed` (or a first hosted boot) the demo accounts are:

| User | Password | Role |
|---|---|---|
| `admin` | `admin123` | admin |
| `buyer` | `buyer123` | buyer |
| `analyst` | `analyst123` | analyst |
| `viewer` | `viewer123` | viewer |

Change these for any public deployment (see *Deploy on Render*).

## Architecture

```
server/
  db.js                 SQLite (node:sqlite) schema + settings + audit
  index.js              Express app + static UI + SPA fallback
  seed.js               reset + import + demo data (thin wrapper)
  seedData.js           reusable seed routine (used by seed + auto-seed on boot)
  routes/               meta, imports, offers, products, trading, reservations, tasks, shipments, auth, captures, sourcing, alerts, orders, recommend, purchase-plan, kpis, forecast, export, ai
  services/
    importer.js         import pipeline (GTIN, packs, snapshots, exceptions, price_history)
    template.js         auto-clean to the standard supplier template (after every import)
    matcher.js          GTIN/alias -> product master
    comparison.js       per-bottle normalisation + ranking + flags
    pricing.js          pure pricing/landed-cost/cashflow/scenario/XIRR engine
    landing.js          Incoterm-aware landed-cost components
    sourcing.js         lowest executable landed cost
    deal.js             buy-side offer + sell-side customer -> full deal
    orders.js           orders, payments and realised vs forecast margin
    reservations.js     stock holds + the no-oversell guard (section 11/20)
    tasks.js             follow-up tasks from captured leads (section 15)
    demands.js           demand version history — supersede, never overwrite
    approvals.js         staff sign-off on offers (section 3/16)
    shipments.js         allocate shipment cost by a documented driver (section 8.2)
    recommend.js        demand -> cheapest executable supplier, MOQ/policy aware
    purchasePlan.js     consolidated buying list across all open demand
    forecast.js         moving-average demand baseline (refuses thin history)
    trends.js           price trends and windowed movement
    alerts.js           alert generation, dedupe and read state
    reporting.js        SheetJS workbooks (incl. cost-masked quote, GL, stock)
    pdf.js              pdf-lib renderer for every report and document (grid + sheet)
    analytics.js        dashboard, opportunities, wins, KPI suite
    suppliers.js        per-supplier commercial defaults
    fx.js               currency conversion
    ai.js               AI assistant: OpenAI-compatible tool-calling loop, SSE streaming, reads + draft proposals only
    aiKnowledge.js      the assistant's system prompt (the whole system in words)
    auth.js             scrypt password hashing, sessions, role middleware
src/
  lib/gtin.js           GS1 validation & canonicalisation
  lib/pack.js           pack-size parser ("4*6", "6 Pack", ...)
  lib/template.js       standard template field groups
  lib/notes.js          Plaud/reMarkable note parser (intents, qty, price, barcode)
  importers/            vendor profiles + generic extractor
public/
  index.html app.js styles.css   dependency-free SPA
data/ptp.db             the database (created on first run)
samples/                demo perfume price lists (generated; scripts/generate-samples.js)
```

## Data model (highlights)

`suppliers · uploads · offers · products · product_aliases · exceptions ·
inventory_lots · reservations · shipments · shipment_allocations · customers · demands · quotes · orders · payments · price_history ·
fx_rates · alerts · tasks · settings · audit_log · users · sessions · captures`

Every offer stores its source file, row, list date and raw values, so imports
are auditable snapshots rather than destructive overwrites.

## Pricing rules

- `margin = (sell − cost) / sell`
- `markup = sell − cost`
- Policy defaults: min margin **15%**, min markup **0.75**; ROI and annualised
  ROI are shown per deal. Landed cost = purchase + duty + freight + insurance +
  brokerage + handling + other non-recoverable taxes.

## Notes / assumptions

- Igan publishes **PVP (retail)**; a demo trade discount of **40%** (editable in
  *Suppliers & Terms*) converts it to an acquisition cost.
- Alcodis quotes some lines **per case**; pack size is parsed from the
  description where present. Rows where the basis is ambiguous surface under
  *Needs review* rather than being trusted.
- Bordered-file corruption from `node:sqlite` is not relevant here; the DB is a
  single WAL-mode SQLite file.
