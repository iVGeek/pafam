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
| `npm test` | Unit tests for the GTIN, pack-size and pricing engines |

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
- **Price deals**: landed cost build-up, margin/markup, ROI & annualised ROI,
  enforced against a configurable margin/markup policy.
- **Trade**: inventory lots, customers, a demand book and quotes.

## Architecture

```
server/
  db.js                 SQLite (node:sqlite) schema + settings + audit
  index.js              Express app + static UI + SPA fallback
  seed.js               reset + import + demo data
  routes/               meta, imports, offers, products, trading
  services/
    importer.js         import pipeline (GTIN, packs, snapshots, exceptions)
    matcher.js          GTIN/alias -> product master
    comparison.js       per-bottle normalisation + ranking + flags
    pricing.js          pure pricing/landed-cost engine
    analytics.js        dashboard, opportunities, wins
    suppliers.js        per-supplier commercial defaults
    fx.js               currency conversion
src/
  lib/gtin.js           GS1 validation & canonicalisation
  lib/pack.js           pack-size parser ("4*6", "6 Pack", ...)
  lib/template.js       standard template field groups
  importers/            vendor profiles + generic extractor
public/
  index.html app.js styles.css   dependency-free SPA
data/ptp.db             the database (created on first run)
samples/                real supplier files used for the demo
```

## Data model (highlights)

`suppliers · uploads · offers · products · product_aliases · exceptions ·
inventory_lots · customers · demands · quotes · fx_rates · alerts · settings ·
audit_log`

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
