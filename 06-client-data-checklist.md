# 06. Client data checklist — what we need to go live

Everything the platform needs from you to run on **real data** instead of the
demo seed. Ordered by priority. Column counts and formats below are read
straight from the code, so use them as the authoritative spec when preparing
files. Code references are for our own use during onboarding.

---

## ⛔ Blockers — decide these first

These two items gate everything else. Without them the system cannot ingest
your real supplier data.

### 1. Supplier price-list files (one per supplier)

The importer recognises **exactly two file layouts** today:

| Profile | Detected by header | Real columns (as seen in sample files) |
|---|---|---|
| **ALCODIS** | an `EAN…` column **and** a `DUN…` column | `EAN (Bt`, `DUN (Box)`, `Nº`, `Categoría`, `Descripción`, `Volumen`, `% Alc.`, `ROSCA/IRRELLENABLE`, `Precio`, `TU PEDIDO`, `Foto y Ficha` (header on row 7) |
| **IGAN** | a `CodigoEAN` column | `SUBCATEGORY`, `Artículo Descripción`, `Código`, `Link image`, `CodigoEAN`, `Vol. Ltr.`, `Und. Caja`, `Caja Pallet`, `% Vol.`, `Caducidad`, `Observ.`, `Stock Pallet`, `PVP` (header on row 29) |

(`src/importers/profiles.js:9-74`)

**We need from you:**
- The **actual price-list files as your suppliers send them** (`.xls`/`.xlsx`,
  up to 50 MB), ideally several months' worth of history — one file per
  supplier, per list date.
- Confirmation of each supplier's **currency as sent in the file** (the two
  profiles currently assume **EUR**; other currencies need a code change).
- For every supplier whose file does **not** match the two layouts above: a
  representative sample file + header row + which columns mean what. **Any new
  layout requires a small code change on our side** (a new vendor profile) —
  send us the files early so we can build them.

Barcodes matter more than anything else: rows are only matched into products
when they carry a **valid EAN/UPC (correct GS1 check digit)**. Blank or broken
barcodes go to the exception queue and never become products, prices or
trends (`server/services/importer.js:91-106,173-182`). If your suppliers'
barcodes are unreliable, tell us — that changes the plan.

> Alternative: if a supplier can send the **standard template** instead, the
> spec is the 49 columns of `supplier-template.xlsx` (root of the repo; full
> dictionary in `03-phase0-spec.md` §columns). Required columns are only:
> `Supplier ID`, `Supplier name`, `Offer ID`, `List date`, `Currency`,
> `Price`, `Price basis` (+ `Units per case` when basis = Case). Note: a
> standard-template loader is not yet wired into the importer — flag this if
> you want suppliers to adopt the template, and we will add it.

### 2. Supplier master (list of suppliers + commercial terms)

No "create supplier" screen exists; supplier codes and terms are onboarding
data (`server/services/suppliers.js:7-28`, `server/db.js:19-40`).
For **each supplier**, please provide:

| Field | Required | Notes |
|---|---|---|
| Code | ✅ | short unique code, e.g. `ALCODIS`, `IGAN` |
| Name | ✅ | |
| Currency | ✅ | ISO-4217, e.g. `EUR`, `USD` |
| Price type | ✅ | `cost` or `rrp` (retail price list) |
| Trade discount % | if RRP | applied to reach wholesale cost (IGAN's demo 40% is a placeholder to confirm) |
| Incoterm + named place | recommended | EXW / FOB / CIF / DAP / DDP / FCA / CPT |
| Payment terms | recommended | free text, e.g. `30 days from B/L` |
| **Landed-cost inputs** | ✅ for accurate costing | duty %, freight per unit, insurance %, brokerage per unit, handling per unit, other tax %, recoverable tax % |
| Stock country / origin country | optional | destination market is a setting (see §5) |

---

## 📋 Lists we need (can be sent as Excel/CSV)

### 3. Customer list

Only `name` is technically required; the rest make quoting, credit and
reporting work properly (`server/db.js:191-202`, `POST /api/customers`
requires just `name`).

| Field | Required | Notes |
|---|---|---|
| Name | ✅ | |
| Code | recommended | e.g. `CUST-001`, unique |
| Region | recommended | e.g. US / EU / ME |
| Currency | recommended | ISO code; must have an FX rate to base currency (§6) |
| Payment terms | recommended | e.g. `Net 30`, `Net 45` |
| Credit limit | optional | number |
| Sanctioned / active status | optional | flags for screening |

### 4. User accounts

For each real user (`server/services/auth.js:31-41`):

| Field | Required | Notes |
|---|---|---|
| Username | ✅ | unique, no spaces |
| Password | ✅ | we suggest issuing temporary passwords and forcing change |
| Role | ✅ | one of `viewer` / `analyst` / `buyer` / `admin` (definitions in `05-user-manual.md` §22) |
| Display name | optional | |
| Email | optional | |

The four demo accounts (`admin/buyer/analyst/viewer`) are removed or
re-passworded for production.

---

## ⚙️ Decisions & settings (one worksheet or a call)

Every value below is a setting the system ships with a default for but that
**your business must confirm** (`server/db.js:611-639`). Send us your answers
and we load them; they remain editable in **Admin → Settings & FX**.

| Setting | Default | We need your value |
|---|---|---|
| Base currency | `USD` | the currency everything is measured in |
| Destination market | `US` | drives eligibility, duty assumptions, alerts |
| Minimum margin % | `15` | policy floor (margin on selling price) |
| Minimum markup | `0.75` | policy floor (markup on cost) |
| Capital limit | `250000` | working-capital ceiling used by KPIs / plans |
| Default duty % | `0` | per destination market |
| Default freight / handling (per unit) | `0` | or rely on per-supplier values (§2) |
| Default insurance % / brokerage / other tax % / recoverable tax % | `0` | same |
| Supplier advance % / customer deposit % | `0` / `0` | deal cash-flow model |
| Supplier payment days / customer payment days / transit days | `0` / `30` / `0` | cash-flow model |
| Price-change alert threshold | `10` (%) | alert sensitivity |
| Low-stock threshold | `10` | units on hand |
| Alert de-dupe window | `7` (days) | |
| Require offer approval? | `0` (no) | on = analyst drafts, buyer/admin signs off |
| Auto-clean imports to standard template | `1` (yes) | |
| Follow-up task window | `2` (days) | from captured note to due date |
| Session length | `168` (hours) | |
| Capture webhook secret | `change-me-capture-secret` | **must be replaced** (see §8) |
| Default margin % (AI offer builder) | `30` | if the AI assistant will price offers |

---

## 💱 FX rates

Rates are **not** seeded for production — with no rate the system silently
treats conversion as 1.0 (`server/services/fx.js:7-23`).

Provide dated rates for every pair you operate, format
(**base currency, quote currency, rate = quote units per 1 base unit, date**):

- Example with USD base: `EUR → USD 1.08`, `GBP → USD 1.27` means 1 EUR buys 1.08 USD.
- At minimum: **each supplier currency → base**, and **base → each customer currency**.
- Tell us your **rate source** (ECB, Reuters, manual) and refresh cadence, or
  confirm manual updates via **Admin → Settings & FX** are enough.

---

## 📄 One-off documents

### 9. Supplier proforma invoices (PFI)

Excel only (PDF is attachment evidence). No fixed template: any header row
within the first 40 rows with a **barcode or description column** *and* a
**price and/or quantity column** is accepted; common names in English/Spanish
are auto-detected (`server/services/pfi.js:16-20`). Send one real PFI per
supplier so we can verify parsing before go-live.

### 10. Historical business records (optional but valuable)

- **Completed historical deals / quotes / orders** — feeds the demand
  forecast, price trends and performance reports from day one instead of
  after a few months of live use (`02-pilot-sow.md` client responsibilities).
- **Current stock on hand** (product, quantity, cost, expiry, warehouse) —
  needed if inventory/reservations go live at launch rather than gradually.
- **Open customer demands** (customer, product, quantity, target price,
  needed-by date) — the Demand Book and purchase plan start empty otherwise.
- **Shipment invoices** (freight/duty/insurance/brokerage/handling totals per
  shipment) — shipment-cost allocation needs `totalCost` + allocation driver
  (weight / volume / declared value) per `server/services/shipments.js`.

### 11. Capture devices (only if you use Plaud / reMarkable)

The webhook `POST /api/captures/webhook` needs: the shared secret (we set the
`capture_secret` setting; you configure it in the device/Zapier/IFTTT side) and
a `text` (or `transcript` / `content` / `note`) field per payload
(`server/routes/captures.js:24-34`). Manual entry needs nothing.

### 12. AI assistant (optional)

If you want the assistant enabled: an **OpenAI-compatible API key**
(OpenRouter free models work; `README.md` provider table), plus confirmation
that sending product names/prices/supplier names to that provider is
acceptable under your data policy. No data files needed.

---

## Delivery format

- Lists (§2 customers, §3 suppliers, §4 users, §5 settings, §6 FX, §10
  historical data) — **one Excel workbook or CSVs** is fine; we will import
  them via the API during onboarding.
- Supplier price lists (§1) — **raw files exactly as received**, plus a
  short note per supplier: currency, whether prices are cost or RRP, and
  (if RRP) the trade discount.
- Everything can be sent as-is; do not reformat supplier files to "help" —
  the importer expects the supplier's own layout.

## Already handled by the system (do NOT send)

- ✅ Product master list — derived automatically from valid GTINs in
  supplier files (no separate product file needed).
- ✅ Standard supplier template — generated by the system after every import
  (`data/cleaned/…`, downloadable as Excel/PDF).
- ✅ Report/quote/placement exports — built in, Excel + PDF on every screen.
