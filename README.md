# Perfume Trading Platform

A bespoke, standalone wholesale trading platform for perfume & spirits: it
ingests messy supplier price lists, resolves products by barcode, normalises
unit vs case vs RRP pricing, compares suppliers, and prices deals to a margin
policy. No Odoo, no external services — one Node process and one SQLite file.

## Quick start

```powershell
npm install          # express, multer, xlsx
npm run seed         # reset DB and import the two real samples + demo data
npm start            # http://localhost:4173
```

Then open http://localhost:4173

Other scripts:

| Command | Purpose |
|---|---|
| `npm run seed` | Wipe `data/ptp.db`, re-import `samples/`, add demo customers/demands/inventory |
| `npm start` | Start the web app (API + UI) on port 4173 (`PORT` env to change) |
| `npm run import` | Headless importer spike / data-quality report (writes `output/`) |
| `npm test` | Unit tests for the GTIN, pack-size, pricing, reservation and forecast engines (runs against a throwaway database) |

## Deploy on Render

A [`render.yaml`](render.yaml) blueprint is included. Push the repo, then in
Render choose **New → Blueprint** and pick it.

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

## What it does

- **Import** supplier `.xls`/`.xlsx` price lists with auto header-row detection
  and per-vendor profiles (`src/importers/profiles.js`). Re-importing an
  identical file is ignored (SHA-256 dedupe).
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
- **Report & export**: one-click `.xlsx` for opportunities, lowest landed cost,
  deals, orders and alerts, plus a **cost-masked customer quotation** that never
  reveals supplier names or buying costs.
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
  routes/               meta, imports, offers, products, trading, reservations, tasks, shipments, auth, captures, sourcing, alerts, orders, recommend, purchase-plan, kpis, forecast, export
  services/
    importer.js         import pipeline (GTIN, packs, snapshots, exceptions, price_history)
    matcher.js          GTIN/alias -> product master
    comparison.js       per-bottle normalisation + ranking + flags
    pricing.js          pure pricing/landed-cost/cashflow/scenario/XIRR engine
    landing.js          Incoterm-aware landed-cost components
    sourcing.js         lowest executable landed cost
    deal.js             buy-side offer + sell-side customer -> full deal
    orders.js           orders, payments and realised vs forecast margin
    reservations.js     stock holds + the no-oversell guard (section 11/20)
    tasks.js             follow-up tasks from captured leads (section 15)
    shipments.js         allocate shipment cost by a documented driver (section 8.2)
    recommend.js        demand -> cheapest executable supplier, MOQ/policy aware
    purchasePlan.js     consolidated buying list across all open demand
    forecast.js         moving-average demand baseline (refuses thin history)
    trends.js           price trends and windowed movement
    alerts.js           alert generation, dedupe and read state
    reporting.js        SheetJS workbooks (incl. cost-masked quote, GL, stock)
    analytics.js        dashboard, opportunities, wins, KPI suite
    suppliers.js        per-supplier commercial defaults
    fx.js               currency conversion
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
samples/                real supplier files used for the demo
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
