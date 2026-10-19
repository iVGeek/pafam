# 06. Client data checklist — detailed requirements for go-live

Everything we need **from you** to run the platform on real data instead of the
demo seed. This is the authoritative onboarding spec: every column, type,
required/optional flag and validation rule below is taken from the running
code. Sections are ordered by priority — the first two are blockers.

**How to read this document**

- **Required** = the system rejects or cannot use the record without it.
- **Recommended** = works without it, but a core feature degrades (noted per field).
- Code references (e.g. `db.js:191`) are for our team during onboarding; you
  can ignore them.
- Anything marked 📋 needs a file **from you**. Anything marked ✅ the system
  generates itself — do not send it.

---

## Delivery summary

| # | Item | Format | Priority | Blocks |
|---|---|---|---|---|
| 1 | Supplier price-list files (per supplier, with history) | `.xls`/`.xlsx` as received | 🔴 Blocker | Everything |
| 2 | Supplier master (terms & landed-cost inputs) | Excel/CSV row per supplier | 🔴 Blocker | Costing, sourcing |
| 3 | Customer list | Excel/CSV | 🟠 High | Quoting, credit |
| 4 | User accounts (name, role) | Excel/CSV | 🟠 High | Go-live access |
| 5 | Business settings decisions | This doc, filled in | 🟠 High | Policy, alerts, cash-flow |
| 6 | FX rates (dated pairs) | Excel/CSV | 🟠 High | All money conversions |
| 7 | PFI samples (1 per supplier) | supplier's own Excel | 🟡 Medium | Order reconciliation |
| 8 | Opening records: stock, demands, historical deals | Excel/CSV per record type | 🟡 Medium | Day-one reports/forecast |
| 9 | Capture webhook (Plaud/reMarkable) | secret + payload config | 🟢 Optional | Capture inbox |
| 10 | AI assistant credentials | API key | 🟢 Optional | Assistant panel |
| — | Product master list | — | ✅ Not needed | — |
| — | Standard template files | — | ✅ System-generated | — |
| — | Report/quote/placement exports | — | ✅ Built-in (Excel + PDF) | — |

---

# 🔴 BLOCKER 1 — Supplier price-list files

The platform's entire product/price universe is built from supplier price
lists. Send them **exactly as your suppliers issue them** — do not reformat,
translate or "clean up" headers; the importer recognises specific native
layouts.

## 1.1 What files to send

- Per supplier: **every price list you have** (`.xls` or `.xlsx`, up to 50 MB
  each), oldest first. Ideally **6–12 months of history** — price trends,
  price-change alerts and supplier performance are empty without history.
- Keep the original filename if possible (it is stored as the audit source).
- Re-sending an identical file later is safe (SHA-256 dedupe); nothing
  duplicates (`server/services/importer.js:37-41`).

## 1.2 Supported native layouts (two exist today)

The importer auto-detects the layout from the **header row** (searched in the
first 80 rows of any sheet) and the supplier from the layout
(`src/importers/profiles.js:76-83`).

### Layout A — "ALCODIS" profile

**Recognised when** the header row has a column starting with `EAN` **and** a
column containing `DUN`.

| Your column (example header) | Maps to | Type | Required | Notes |
|---|---|---|---|---|
| `EAN (Bt` | unit barcode (GTIN) | text | **strongly** | Valid GS1 check digit required to create a product; see §1.5 |
| `DUN (Box)` | case barcode | text | — | Stored separately — case codes are never treated as bottles |
| `Nº` | internal SKU | text | — | |
| `Categoría` | category | enum-ish | — | |
| `Descripción` | description | text | **strongly** | Used for matching, PFI reconciliation, display |
| `Volumen` | size | number | — | Litres; converted to ml |
| `% Alc.` | alcohol % | number | — | |
| `ROSCA/IRRELLENABLE` | cap type / refillable | text | — | |
| `Precio` | **price** | number > 0 | ✅ **Required** | Rows without price → `no_price` exception |
| `TU PEDIDO` | order multiple | number | — | |
| `Foto y Ficha` | image link | text | — | |
| `validez…` / `hasta` | valid-until date | date | — | optional patterns auto-detected |
| `plazo` / `lead time` | lead time (days) | number | — | |
| `origen` | country of origin | text | — | |
| `almacén` / `warehouse` | stock warehouse | text | — | |

Also auto-detected if present: `mínimo` (MOQ), `disponible/entrega` (ready
date), `confirmación` (stock confirmation), `confianza` (stock confidence),
`destino` (permitted destination), `ee.uu/usa/apto` (US suitability),
`propietario` (stock owner).

Full mapping: `src/importers/profiles.js:10-42`.

### Layout B — "IGAN" profile

**Recognised when** the header row contains a `CodigoEAN` column.

| Your column (example header) | Maps to | Type | Required | Notes |
|---|---|---|---|---|
| `CodigoEAN` | unit barcode (GTIN) | text | ✅ effectively | Same GS1 rule as above |
| `Artículo Descripción` | description | text | **strongly** | |
| `Código` | internal SKU | text | — | |
| `SUBCATEGORY` / `categor…` | category | text | — | |
| `Vol. Ltr.` | size | number | — | |
| `Und. Caja` | **units per case** | int | ✅ if case pricing | Used for bottle normalisation |
| `Caja Pallet` | cases per pallet | int | — | |
| `% Vol.` | alcohol % | number | — | |
| `Caducidad` | expiry date | date | — | |
| `Observ.` | notes | text | — | |
| `Stock Pallet` | available quantity | number | — | Blank = unknown, never 0 |
| `PVP` | **retail price (RRP)** | number | ✅ **Required** | Supplier is an RRP list — see discount in §2 |
| `minimo` / `min. pedido` | MOQ | number | — | |
| `multiplo` | order multiple | number | — | |
| `validez…` / `hasta` | valid-until date | date | — | |
| `origen` | country of origin | text | — | |

Full mapping: `src/importers/profiles.js:43-73`.

**Hard-coded facts about these two suppliers** (flag any that are wrong for
your real suppliers — they are editable in Admin after onboarding, but the
codes/profiles are code-level):

| | ALCODIS | IGAN |
|---|---|---|
| Currency assumed from file | **EUR** | **EUR** |
| Price meaning | cost | **RRP** → cost = PVP − trade discount |
| Trade discount | 0% | **40% (placeholder — confirm your real %)** |
| Incoterm | none set | EXW Lleida |
| Stock country | ES | ES |

## 1.3 Supplier files that match neither layout

If a supplier's header row matches neither profile, the import fails with
`No known header row / vendor profile matched`
(`src/importers/genericImporter.js:67`).

**To onboard such a supplier, send us:**

1. Two or three **real sample files** (different months if formats drift).
2. A one-line note per file: **currency**, **is the price cost or retail?**,
   and if retail: **the trade discount %**.
3. Which column is the **barcode**, which is the **description**, which is the
   **price**, which is the **quantity/stock** (a marked-up screenshot is fine).
4. Any case-pack info (`units per case` column or a statement like
   "6 bottles per box").

We then build a vendor profile (small code change) and register the supplier.
This is the single most common onboarding task — **send these files early**.

## 1.4 Prices that are per case, not per bottle

- If a price is **per case/carton**, we must know the **units per case**
  (either a column in the file or told to us). The system never guesses a
  case-to-bottle conversion from a case barcode (`profiles.js` header note).
- If a file mixes unit and case prices, a column telling them apart is
  required (Layout B's `Und. Caja` does this).

## 1.5 Barcode rules (critical — read this)

Products are created **only** from barcodes (`server/services/matcher.js:54-96`).
There is no description-based auto-matching (deliberate: `03-phase0-spec.md:161`).

| Situation | What happens | What you should do |
|---|---|---|
| Valid EAN/UPC (correct GS1 check digit) | Row matches an existing product or creates one; prices, trends, alerts work | ✅ ideal |
| Blank barcode | Row → **exception** queue (`blank_barcode`); no product, never priced | Get barcodes from supplier; or we add an SKU→alias mapping |
| Check digit fails | Row → exception (`invalid_barcode`) | Fix at source; do not pad/retype |
| Duplicate barcode inside one file | First row imports, rest → `duplicate` exception | Usually a supplier file defect — tell us |
| No price | Row → `no_price` exception | |
| Case barcode given as unit barcode | **Data corruption risk** — must be told which is which | Must be flagged per supplier |

- Barcode column must be **text** (Excel: format cells as Text before paste —
  leading zeros are significant).
- Invalid/blank barcode rows are still imported (kept as exceptions for review)
  but **never become products** (`importer.js:91-106,173-182`).
- If your suppliers' barcodes are systematically unreliable, tell us
  **before** onboarding — it changes the matching strategy (SKU aliasing
  becomes mandatory) and needs a plan.

## 1.6 What happens to defective rows (so you know what to expect)

Every file row is imported; defects become review items, never silent drops
(`server/services/importer.js:73-229`). After each import you get counters:
`imported, matched, blankBarcode, invalidBarcode, duplicates` and the
**Exceptions** screen lists each item with its cause for an analyst to resolve.

## 1.7 Alternative: the standard supplier template

If you prefer suppliers send **our** template instead of native files:

- File: `supplier-template.xlsx` (project root). Sheets: `Offers`, `FieldGuide`,
  `Enum`, `Instructions`.
- **49 columns**, exact order (`server/services/template.js:23-36`):

| # | Column | Required | Type | Notes |
|---|---|---|---|---|
| 1 | Supplier ID | Y | TEXT | must exist in supplier master |
| 2 | Supplier name | Y | TEXT | snapshot at list date |
| 3 | Offer ID | Y | TEXT | unique per supplier + list date |
| 4 | List date | Y | DATE | snapshot anchor; immutable |
| 5 | Valid until | N | DATE | ≥ list date if present |
| 6 | Last stock confirmation | N | DATE | freshness source |
| 7 | Source file | Y | TEXT | **system-set** |
| 8 | Source row | Y | INT | **system-set** |
| 9 | Original EAN / UPC | N | TEXT | text; preserve leading zeros |
| 10 | Internal SKU | N | TEXT | must resolve via alias table |
| 11 | Brand | N | TEXT | |
| 12 | Fragrance name | N | TEXT | |
| 13 | Concentration | N | **ENUM** | `EDP, EDT, EDC, Parfum, Other` |
| 14 | Size (ml) | N | INT | > 0 |
| 15 | Gender / category | N | **ENUM** | `Men, Women, Unisex, Other` |
| 16 | Set contents | N | TEXT | |
| 17 | Retail pack or tester | N | **ENUM** | `Retail, Tester, Gift set, Refill` |
| 18 | With / without cap | N | **ENUM** | `Yes, No, Unknown` |
| 19 | With / without box | N | **ENUM** | `Yes, No, Unknown` |
| 20 | Sealed or unboxed | N | **ENUM** | `Sealed, Unboxed` |
| 21 | Damage status | N | **ENUM** | `None, Minor, Major, Unknown` |
| 22 | Batch / lot reference | N | TEXT | |
| 23 | Manufacture date | N | DATE | only if verified |
| 24 | Currency | Y | TEXT | ISO-4217 (`EUR`, `USD`, …) |
| 25 | Price | Y | DEC | > 0 |
| 26 | Price basis | Y | **ENUM** | `Unit` or `Case` |
| 27 | Units per case | **Cond** | INT | required if basis = Case |
| 28 | Available quantity | N | INT | **blank = unknown, never 0** |
| 29 | Quantity unit | N | TEXT | |
| 30 | MOQ | N | INT | |
| 31 | Order multiple | N | INT | |
| 32 | Price tier minimum | N | INT | |
| 33 | Price tier maximum | N | INT | ≥ tier minimum |
| 34 | Stock country | N | TEXT | |
| 35 | Stock warehouse | N | TEXT | |
| 36 | Country of origin | N | TEXT | |
| 37 | Incoterm | N | **ENUM** | `EXW, FOB, CIF, DAP, DDP, FCA, CPT` |
| 38 | Incoterm named place | N | TEXT | required if Incoterm present |
| 39 | Ready date | N | DATE | |
| 40 | Lead time | N | INT | days |
| 41 | Payment terms | N | TEXT | |
| 42 | Freight inclusions | N | TEXT | drives double-count control |
| 43 | Permitted destination | N | TEXT | |
| 44 | Permitted channels | N | TEXT | |
| 45 | US suitability status | N | **ENUM** | `Eligible, Review, Not eligible` |
| 46 | Authenticity documents | N | TEXT | |
| 47 | Stock owner ID | N | TEXT | dedup key |
| 48 | Unique lot reference | N | TEXT | dedup key |
| 49 | Stock confidence | N | **ENUM** | `Firm, Indicative, On request` |

Template rules (from its `Instructions` sheet):

- One row = one offer for a specific SKU, packaging condition, stock lot,
  location and price tier.
- **Blank = unknown. Never use 0 for an unknown value.**
- Keep the supplier's **original** EAN/UPC and description.
- Barcodes stored as **text**; canonical GTIN is padded to 14 digits.
- Never equate a case barcode to a bottle without a verified units-per-case.
- Each list is a dated snapshot; no overwriting history.

> ⚠️ **Status note:** the standard-template *output* exists (every import is
> auto-cleaned into this format, downloadable Excel/PDF), but a *loader* for
> template-format input is **not yet wired into the importer**. If you want
> suppliers to adopt the template, say so in the kickoff — it is a small
> development item, but until then native layout files (§1.2) are the only
> ingesting path.

---

# 🔴 BLOCKER 2 — Supplier master (commercial terms)

There is no "add supplier" screen; suppliers are onboarding data. For **each
supplier** send one Excel row with these columns
(`server/db.js:19-40`, update API `server/routes/meta.js:26-60`):

| Excel header | Type | Required | If missing, the system… | Example |
|---|---|---|---|---|
| `code` | TEXT, unique | ✅ | — | `ALCODIS` |
| `name` | TEXT | ✅ | — | `Alcodis Trading SL` |
| `currency` | ISO-4217 | ✅ | defaults EUR | `EUR` |
| `priceType` | `cost` \| `rrp` | ✅ (confirm) | defaults `cost` | `rrp` |
| `defaultDiscount` | % (number) | if `rrp` | 0% — quotes/margins wrong | `40` |
| `incoterm` | `EXW/FOB/CIF/DAP/DDP/FCA/CPT` | recommended | landed terms unknown | `EXW` |
| `incotermPlace` | TEXT | if incoterm | — | `Lleida` |
| `paymentTerms` | TEXT | recommended | — | `30 days from invoice` |
| `dutyPct` | % | ✅ for costing | 0% duty assumed | `0` |
| `freightPerUnit` | money | ✅ for costing | 0 | `0.35` |
| `insurancePct` | % | ✅ for costing | 0 | `0.5` |
| `brokeragePerUnit` | money | ✅ for costing | 0 | `0.10` |
| `handlingPerUnit` | money | ✅ for costing | 0 | `0.05` |
| `otherTaxPct` | % | if applicable | 0 | `0` |
| `recoverableTaxPct` | % | if applicable | 0 | `18` |
| `stockCountry` | ISO country | recommended | — | `ES` |
| `originCountry` | ISO country | optional | — | `FR` |
| `active` | 1/0 | optional | 1 | `1` |

- Supplier-specific terms **override** the global defaults (§Settings), so
  per-supplier accuracy is what makes landed cost correct.
- **New supplier codes beyond ALCODIS/IGAN** require a code change to register
  (plus a file profile if they must be imported, §1.3). List **all** suppliers
  you will use in year one — even if their files come later.

**Copy-ready header row:**
`code,name,currency,priceType,defaultDiscount,incoterm,incotermPlace,paymentTerms,dutyPct,freightPerUnit,insurancePct,brokeragePerUnit,handlingPerUnit,otherTaxPct,recoverableTaxPct,stockCountry,originCountry,active`

---

# 📋 3 — Customer list

One row per customer (`server/db.js:191-202`; create API requires only
`name` — `server/routes/trading.js:217-227`).

| Excel header | Type | Required | If missing… | Example |
|---|---|---|---|---|
| `name` | TEXT | ✅ **Required** | record rejected | `Acme Distribution LLC` |
| `code` | TEXT, unique | recommended | auto-assigned display only | `CUST-001` |
| `region` | TEXT | recommended | regional reporting empty | `US` |
| `currency` | ISO-4217 | recommended (✅ effectively) | defaults USD — **wrong quotes if customer deals in another currency** | `USD` |
| `paymentTerms` | TEXT | recommended | deal cash-flow uses global default | `Net 45` |
| `creditLimit` | number | optional | credit KPI blank | `50000` |
| `sanctioned` | `0`/`1` | optional | 0 | `0` |
| `active` | `0`/`1` | optional | 1 | `1` |

Validation on our side: `name` non-empty; `currency` must have an FX rate to
base currency (§6) or conversions fall back to 1.0.

**Copy-ready header row:**
`code,name,region,currency,paymentTerms,creditLimit,sanctioned,active`

**Example rows:**

```
CUST-001,Acme Distribution LLC,US,USD,Net 45,50000,0,1
CUST-002,Parfumerie Dubois,EU,EUR,Net 30,25000,0,1
```

---

# 📋 4 — User accounts

One row per real person (`server/db.js:451-461`; create API
`server/routes/auth.js:44-50`).

| Excel header | Type | Required | Notes | Example |
|---|---|---|---|---|
| `username` | TEXT, unique | ✅ | no spaces; this is the login | `m.serra` |
| `password` | TEXT | ✅ | we suggest temporary passwords + force change | `…` |
| `role` | enum | ✅ | `viewer` / `analyst` / `buyer` / `admin` — anything else is rejected | `buyer` |
| `displayName` | TEXT | optional | defaults to username | `Maria Serra` |
| `email` | TEXT | optional | | `maria@…` |
| `active` | `0`/`1` | optional | 1 | `1` |

**Role definitions** (what each person can do — see `05-user-manual.md` §22):

| Role | Rank | Can do |
|---|---|---|
| `viewer` | 1 | Dashboards, offers, products, prices, reports/exports (read-only) |
| `analyst` | 2 | + import cleanup, captures, PFI uploads, resolve exceptions, record shipments |
| `buyer` | 3 | + create/edit offers, deals, quotes, orders, placements, customers, demands, inventory, reservations; approve offers; Apply AI drafts |
| `admin` | 4 | + suppliers, settings, FX, users, merges, audit |

Decide the role per person; you can change roles later in **Admin → Users**.

**Copy-ready header row:**
`username,password,role,displayName,email,active`

**Note:** the four demo accounts are removed/re-passworded for production;
the bootstrap admin comes from deployment environment variables
(`PTP_ADMIN_USER` / `PTP_ADMIN_PASS`), which you must also set
(`04-hosting-hardening.md` §secrets).

---

# ⚙️ 5 — Business settings (one filled-in worksheet)

Every key below exists with a default (`server/db.js:611-639`) but is a
**business decision**. Fill the "Your value" column and send it back; values
stay editable later in **Admin → Settings & FX**.

| # | Setting key | Default | What it drives | Valid values / format | Your value |
|---|---|---|---|---|---|
| 1 | `base_currency` | `USD` | currency everything is measured & reported in | ISO-4217 | |
| 2 | `dest_market` | `US` | destination eligibility, default duty, alerts | country code | |
| 3 | `min_margin_pct` | `15` | quote/deal policy floor, margin on selling price | 0–99 | |
| 4 | `min_markup` | `0.75` | same floor expressed as markup on cost (×1) | 0–99 (0.75 = 75%) | |
| 5 | `capital_limit` | `250000` | working-capital ceiling in KPIs & purchase plan | money, base ccy | |
| 6 | `default_duty_pct` | `0` | default duty when supplier has none | % | |
| 7 | `default_freight_per_unit` | `0` | default freight/bottle | money | |
| 8 | `default_insurance_pct` | `0` | default insurance | % | |
| 9 | `default_brokerage` | `0` | default brokerage/bottle | money | |
| 10 | `default_handling_per_unit` | `0` | default handling/bottle | money | |
| 11 | `default_other_tax_pct` | `0` | default other taxes | % | |
| 12 | `default_recoverable_tax_pct` | `0` | recoverable portion (e.g. VAT) | % | |
| 13 | `default_supplier_advance_pct` | `0` | deal cash-flow: advance paid to supplier | % | |
| 14 | `default_customer_deposit_pct` | `0` | deal cash-flow: deposit taken from customer | % | |
| 15 | `default_supplier_payment_days` | `0` | deal cash-flow timing | days | |
| 16 | `default_customer_payment_days` | `30` | deal cash-flow timing | days | |
| 17 | `default_transit_days` | `0` | deal cash-flow timing | days | |
| 18 | `price_change_alert_pct` | `10` | alert when a supplier price moves ≥ this | % | |
| 19 | `low_stock_threshold` | `10` | alert when on-hand below this (units) | number | |
| 20 | `alert_dedupe_days` | `7` | same alert not repeated within | days | |
| 21 | `require_offer_approval` | `0` | `1` = analyst drafts, buyer/admin signs off | `0`/`1` | |
| 22 | `auto_clean_imports` | `1` | rewrite each import to standard template | `0`/`1` | |
| 23 | `followup_days` | `2` | captured lead → task due date | days | |
| 24 | `session_hours` | `168` | login session length | hours | |
| 25 | `capture_secret` | `change-me-…` | webhook auth — **MUST be replaced** | long random string | |
| 26 | `default_margin_pct` | `30` (fallback) | AI offer-builder default margin | % | |

Questions to answer in the worksheet: *Is 15%/0.75% still your floor? What is
the real capital limit? Do you require offer approvals? Does anyone still use
RRP lists (which trade discount %)?*

---

# 💱 6 — FX rates

Rates are **not** seeded for production. With no rate for a pair the system
silently converts at **1.0** — wrong quotes, wrong margins, no error
(`server/services/fx.js:7-23`).

**Format** (`fx_rates` — `db.js:249-259`, API `POST /api/fx`):

| Excel header | Type | Required | Notes | Example |
|---|---|---|---|---|
| `base` | ISO-4217 | ✅ | the "from" currency | `EUR` |
| `quote` | ISO-4217 | ✅ | the "to" currency | `USD` |
| `rate` | number > 0 | ✅ | **quote units per 1 base unit** | `1.08` |
| `rateDate` | YYYY-MM-DD | ✅ | default today if omitted | `2026-10-19` |
| `source` | TEXT | recommended | audit trail; default `manual` | `ECB` |
| `booked` | 0/1 | optional | 1 = locked/confirmed | `1` |

**Convention:** `rate` = how many `quote` units for 1 `base` unit.
`EUR→USD 1.08` means **1 EUR = 1.08 USD**. The inverse pair is derived
automatically; you never need to send both directions.

**Minimum pairs to send:** every **supplier currency → base currency** and
every **customer currency → base currency**. If base = USD and you buy in
EUR/GBP/TRY and sell in USD/EUR, send those rows.

**Copy-ready header row:**
`base,quote,rate,rateDate,source,booked`

**Example rows:**

```
EUR,USD,1.08,2026-10-19,ECB,1
GBP,USD,1.27,2026-10-19,ECB,1
```

Also confirm your **rate source and refresh cadence** (ECB daily reference?
manual monthly?) — or state that manual updates in Admin → FX are acceptable.

---

# 📋 7 — Supplier proforma invoices (PFI)

Needed for **order-vs-invoice reconciliation** on placements. No fixed
template: the parser scans the first 40 rows of any sheet for a header row
that has **(barcode OR description) AND (price OR quantity)**
(`server/services/pfi.js:16-50`).

Recognised header synonyms (any case, any order, English + Spanish):

| Meaning | Header patterns accepted |
|---|---|
| Barcode | `ean`, `upc`, `gtin`, `barcode`, `codigo barr…`, `codigoean` |
| Description | `descrip…`, `nombre`, `producto`, `articulo`, `name`, `desc…`, `detalle` |
| Unit price | `precio`, `price`, `coste`, `cost`, `pvp`, `tarifa`, `unit price/cost`, `unit` |
| Line total | `importe`, `total`, `amount`, `subtotal`, `line total` |
| Quantity | `cantidad`, `qty`, `quantity`, `uds`, `unidades`, `units`, `stock` |

Rules: matching by canonical GTIN when barcode valid, else normalised
description; if only one of unit price/line total exists the other is derived.
**Send one real PFI Excel per supplier** (plus the PDF if you keep one — PDF
is attachment evidence only; Excel is the source of truth).

If a supplier's PFI uses headers none of the above match, it returns
`400 No barcode/price/quantity header found` — send us the file and we extend
the synonym list.

---

# 📋 8 — Opening business records (recommended for day-one value)

Skip these and the system starts empty: trends, forecast, performance and the
purchase plan need a few months of life **or** historical import.

## 8.1 Historical deals / quotes / orders

Feeds **price history, demand forecast, performance & wins reports** from day
one. Per record send at least:

```
recordType (quote|order),date,customerName,productName,gtin,quantity,
unitPrice,currency,unitCost,supplierCode,status
```

- `customerName` must match §3 exactly (or include `customerCode`).
- `productName`/`gtin`: GTIN strongly preferred — without it no product link,
  so history cannot attach to the product.
- `unitCost` enables margin history; omit only if unavailable (we load price
  history anyway from supplier lists).
- 12+ months if it exists; minimum 3 months for a moving-average forecast to
  say anything (`server/services/forecast.js`).

## 8.2 Opening stock (inventory lots)

Only needed if you go live **with** stock in the system
(`inventory_lots` — `db.js:154-168`, API `POST /api/inventory`):

```
productId|gtin,supplierCode,warehouse,lotReference,onHand,reserved,
inTransit,quarantined,unitCost,currency,expiryDate
```

- `productId`/`gtin` **Required** — the product must exist (i.e. already seen
  in a supplier file, §1.5) or we load products first from lists, stock second.
- `onHand`/`reserved`/`inTransit`/`quarantined`: numbers, **0 only if truly 0**;
  unknown = leave blank (they default 0 anyway — confirm with us).
- `unitCost`+`currency` for stock valuation and margin realism.
- Note: reservations cannot exceed `onHand − quarantined`
  (`server/services/reservations.js:27-45`).

## 8.3 Open customer demands

Feeds the Demand Book, recommendations and purchase plan from day one
(`demands` — `db.js:204-219`, API requires customer + product):

```
customerCode,gtin,quantity,targetPrice,currency,neededBy,status,source,notes
```

- `customerCode` ✅ (must exist in §3); `gtin` ✅ (must exist via §1);
  `quantity` recommended; `status` = `open` unless already `matched|quoted`;
  `neededBy` = YYYY-MM-DD; `source` = `manual|email|note`.

## 8.4 Shipment costs (if you have real freight invoices)

Needed for the allocation feature (`shipments` — `db.js:406-425`):

```
ref,direction (inbound|outbound),supplierCode|customerName,costType
(freight|duty|insurance|brokerage|handling|other),totalCost,currency,
driver (weight|volume|value),totalWeightKg,totalVolumeM3,declaredValue,shippedDate
```

- `totalCost` ✅; `driver` is the documented allocation basis — tell us which
  you actually measure (weight/volume/value); missing `totalWeightKg`/
  `totalVolumeM3` means only `value` driver can be used.

---

# 🟢 9 — Capture devices (only if you use Plaud / reMarkable)

Webhook `POST /api/captures/webhook` (`server/routes/captures.js:24-34`):

- **Auth:** header `X-Capture-Secret: <secret>` (or body field `secret`) =
  the `capture_secret` setting you chose in §5 item 25. You configure the same
  secret on the device/Zapier/IFTTT side.
- **Body:** JSON with text in any of `text`, `transcript`, `content`, `note`
  (✅ **Required**), plus optional `source` (`plaud|remarkable|manual|webhook`)
  and `title`.

Example payload:

```json
{ "source": "plaud", "title": "Call with Acme",
  "transcript": "Acme wants 240 bottles of Bleu de Chanel 100ml, target 42 USD, needed by Nov 15" }
```

No files needed — just confirm devices you use, and we set the shared secret.

# 🟢 10 — AI assistant credentials (optional)

- An **OpenAI-compatible API key** (OpenRouter free tier works — see README
  provider table) as environment variables `AI_BASE_URL`, `AI_API_KEY`,
  `AI_MODEL`.
- A written OK that **product names, prices, supplier and customer names** sent
  to the assistant are transmitted to that provider (data-sharing policy
  confirmation).

---

# Delivery instructions

1. **One package**, ideally a single ZIP or shared folder:
   - `01-supplier-files/` — native price lists, one subfolder per supplier
   - `02-suppliers.xlsx` — §2 header row
   - `03-customers.xlsx` — §3
   - `04-users.xlsx` — §4
   - `05-settings-decisions.xlsx` — §5 table with "Your value" filled
   - `06-fx-rates.xlsx` — §6
   - `07-pfi-samples/` — one per supplier
   - `08-opening-records/` — stock, demands, historical deals (§8)
2. **Do not reformat supplier files.** Send exactly what the supplier sends —
   including merged cells, title rows, Spanish headers. The importer searches
   for the header row itself.
3. Barcodes: keep as text; if you must paste them, paste as text (not
   scientific notation, not stripped leading zeros).
4. Dates: ISO `YYYY-MM-DD` preferred in **our** lists (§3–§8). Dates inside
   supplier files are parsed as-is where supported.
5. Anything you cannot provide — mark it explicitly as "unavailable" in the
   reply so we adjust the plan (e.g. no history = forecast stays off).

# Acceptance checks we run on receipt

- Supplier files: profile detection passes; row counts vs. your spot-check;
  barcode validity rate (report % per file — if < 90% we stop and discuss
  §1.5); currency/price-type assumptions confirmed with you.
- Customers/users/settings/FX: loaded via API; referential checks (customer
  codes exist for demands; FX pairs cover all currencies in play).
- PFI: one dry-run comparison per supplier against a real placement.
- Everything re-exportable as Excel **and** PDF from day one (built in).

# What NOT to send

- ✅ **Product master / SKU list** — products are built from valid GTINs in
  supplier files automatically (`matcher.js:54-96`). A product file would be
  redundant *unless* barcodes are unusable (then tell us — see §1.5).
- ✅ **Standard supplier template files** — the system generates the cleaned
  template after every import (downloadable Excel/PDF per upload).
- ✅ **Report/quote/placement exports** — built in, dual Excel + PDF on every
  screen.
- ✅ **Any file "pre-cleaned" by hand** — raw supplier originals only.

# Open questions (answer with the package)

1. Confirm each supplier's currency, cost-vs-RRP, and real trade discount %.
2. How many suppliers use files outside the two known layouts? (§1.3)
3. Base currency and destination market? (§5 items 1–2)
4. Is 15% margin / 0.75 markup still the policy floor? Capital limit?
5. Approval workflow on or off? (`require_offer_approval`)
6. FX source and refresh cadence? (§6)
7. Day-one scope: do opening stock and open demands go live at launch? (§8)
8. Which roles for which people? (§4)
9. Data-sharing OK for the AI assistant? (§10)
