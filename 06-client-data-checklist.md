# 06. Client data checklist — what we need from you

This is the definitive list of data we need **from you** to run the platform on
real data. It has **9 items**. Each item names an Excel template from the
**template pack** (`client-templates/`) — fill those files and return them with
your data. Everything here is taken from the running code, so use it as the
authoritative onboarding spec.

**How to read this document**

- 🔴 **Blocker** = nothing real can run without it. 🟠 High = needed for
  go-live. 🟡 Medium / 🟢 Optional = improves specific modules.
- **Required** = the system rejects or cannot use the record without it.
- **Recommended** = works without it, but a feature degrades (noted per field).
- Template files carry a `Guide` sheet with the same field dictionary plus a
  `ReadMe` sheet with filling instructions — the tables here mirror them.
- Code references (e.g. `db.js:191`) are for our team; you can ignore them.

## The 9 items at a glance

| # | What we need | Template file | Priority |
|---|---|---|---|
| 1 | Supplier master | `01-supplier-master.xlsx` | 🔴 Blocker |
| 2 | Customer master | `02-customer-master.xlsx` | 🟠 High |
| 3a | Raw price list per supplier, **as received** (+ log) | `03-raw-price-list-log.xlsx` | 🔴 Blocker |
| 3b | Prepared price list per supplier (the one you send customers) | `04-prepared-price-list.xlsx` | 🔴 Blocker |
| 4 | Customer offer: **company copy** + **customer copy** | `05-offer-company-copy.xlsx`, `06-offer-customer-copy.xlsx` | 🟠 High |
| 5 | Naming format for every document (supplier & customer side) | `07-document-naming.xlsx` | 🟠 High |
| 6 | Base currency per supplier and per customer (+ FX rates) | columns in `01`/`02` | 🟠 High |
| 7 | Process captures: screenshots / screen-video per process | `08-process-capture-checklist.xlsx` | 🟠 High |
| 8 | VLOOKUP formulas currently in use | `09-vlookup-formulas.xlsx` | 🟠 High |
| 9 | Excel templates for every file | the whole pack (`00-readme-index.xlsx` is the map) | ✅ **Provided by us** |

---

# 1. Supplier master 🔴

One row per supplier you will use in year one — even suppliers whose files
come later. **Template: `01-supplier-master.xlsx`** (sheets `Suppliers`,
`Guide`, `ReadMe`).

| Excel header | Required | Type | If missing, the system… | Example |
|---|---|---|---|---|
| `code` | ✅ | TEXT, unique | — | `ALCODIS` |
| `name` | ✅ | TEXT | — | `Alcodis Trading SL` |
| `baseCurrency` | ✅ | ISO-4217 | — (see item 6) | `EUR` |
| `priceType` | ✅ | `cost` \| `rrp` | defaults `cost` → wrong if it's really an RRP list | `rrp` |
| `tradeDiscountPct` | if `rrp` | % | 0% → cost/margins wrong | `40` |
| `incoterm` | recommended | `EXW/FOB/CIF/DAP/DDP/FCA/CPT` | landed terms unknown | `EXW` |
| `incotermPlace` | if incoterm | TEXT | — | `Lleida` |
| `paymentTerms` | recommended | TEXT | — | `30 days from invoice` |
| `dutyPct` | ✅ for costing | % | 0% duty assumed | `0` |
| `freightPerUnit` | ✅ for costing | money | 0 | `0.35` |
| `insurancePct` | ✅ for costing | % | 0 | `0.5` |
| `brokeragePerUnit` | ✅ for costing | money | 0 | `0.10` |
| `handlingPerUnit` | ✅ for costing | money | 0 | `0.05` |
| `otherTaxPct` | if applicable | % | 0 | `0` |
| `recoverableTaxPct` | if applicable | % | 0 | `18` |
| `stockCountry` | recommended | ISO country | — | `ES` |
| `originCountry` | optional | ISO country | — | `FR` |
| `priceListFormat` | ✅ (us) | `ALCODIS` \| `IGAN` \| `OTHER` | we cannot import their files without knowing | `ALCODIS` |
| `contactName` / `contactEmail` / `contactPhone` | optional | TEXT | — | |
| `active` | optional | `1`/`0` | 1 | `1` |
| `notes` | optional | TEXT | — | |

Notes:

- Supplier-specific terms **override** the global defaults — per-supplier
  accuracy is what makes landed cost correct (`db.js:19-40`).
- `ALCODIS` and `IGAN` already exist as codes (`server/services/suppliers.js:6-23`);
  keep those codes exactly. **New supplier codes need a small code change** —
  list every supplier you plan to use.
- `priceListFormat = OTHER` tells us to expect samples so we can build a new
  import profile (see item 3a).

---

# 2. Customer master 🟠

One row per customer you trade with or will quote. **Template:
`02-customer-master.xlsx`** (sheets `Customers`, `Guide`, `ReadMe`).

| Excel header | Required | Type | If missing, the system… | Example |
|---|---|---|---|---|
| `code` | recommended | TEXT, unique | auto-assigned only — but it is the naming key (item 5) | `CUST-001` |
| `name` | ✅ **Required** | TEXT | record rejected | `Acme Distribution LLC` |
| `baseCurrency` | ✅ | ISO-4217 | defaults USD → wrong quotes in another currency | `USD` |
| `region` | recommended | TEXT | regional reporting empty | `US` |
| `paymentTerms` | recommended | TEXT | deal cash-flow uses global default | `Net 45` |
| `creditLimit` | optional | money | credit KPI blank | `50000` |
| `contactName` / `contactEmail` / `contactPhone` | optional | TEXT | — | |
| `address` / `taxId` | optional | TEXT | invoice details missing | |
| `sanctioned` | optional | `0`/`1` | 0 | `0` |
| `active` | optional | `0`/`1` | 1 | `1` |
| `notes` | optional | TEXT | — | |

Validation on our side: `name` non-empty; `baseCurrency` must have an FX rate
to your base currency (item 6) or conversions silently fall back to 1.0
(`server/services/fx.js:7-23`).

---

# 3. Per supplier: raw price list + prepared price list 🔴

For **each supplier** you send us **two files**:

1. **(3a) The RAW price list exactly as received from the supplier** — never
   renamed, reformatted or translated.
2. **(3b) The PREPARED price list** you build from it — the one you actually
   send to customers.

## 3a. Raw price lists (as received)

**Template: `03-raw-price-list-log.xlsx`** — one log row per raw file you send.
The file itself is sent untouched; the log tells us its currency, price basis,
discount and case pack.

Also send **6–12 months of history** if you have it: price trends,
price-change alerts and supplier performance are built from it
(`server/services/importer.js:37-41`; re-sending an identical file is
deduplicated by hash — nothing imports twice).

### Supported native layouts (two exist today)

The importer auto-detects the layout from the header row (first 80 rows of any
sheet) and the supplier from the layout (`src/importers/profiles.js:76-83`).

**Layout A — "ALCODIS"**: recognised when the header row has a column starting
with `EAN` **and** a column containing `DUN`.

| Your column (example) | Maps to | Required |
|---|---|---|
| `EAN (Bt` | unit barcode (GTIN) | strongly — see barcode rules below |
| `DUN (Box)` | case barcode (stored separately) | — |
| `Nº` | internal SKU | — |
| `Descripción` | description | strongly — matching & display |
| `Volumen` | size (litres → ml) | — |
| `% Alc.` | alcohol % | — |
| `Precio` | **price** | ✅ — rows without price → `no_price` exception |
| `TU PEDIDO` | order multiple | — |
| auto-detected if present: `mínimo` (MOQ), `validez/hasta` (valid until), `plazo` (lead time), `origen`, `almacén`, `confianza` (stock confidence), `destino`, `ee.uu/usa/apto` (US suitability), `propietario` (stock owner), `foto` | | |

**Layout B — "IGAN"**: recognised when the header row contains `CodigoEAN`.

| Your column (example) | Maps to | Required |
|---|---|---|
| `CodigoEAN` | unit barcode (GTIN) | effectively yes (barcode rules below) |
| `Artículo Descripción` | description | strongly |
| `Código` | internal SKU | — |
| `Vol. Ltr.` | size | — |
| `Und. Caja` | **units per case** | ✅ if priced per case |
| `Stock Pallet` | available quantity (blank = unknown) | — |
| `PVP` | **retail price (RRP)** | ✅ — see priceBasis in the log |
| `min. pedido` (MOQ), `multiplo`, `validez`, `Caducidad`, `Observ.`, `Caja Pallet`, `% Vol.`, `origen`, `destino`, `ee.uu` | | |

Full mapping: `src/importers/profiles.js:10-73`.

### Hard-coded facts about these two suppliers

Flag anything wrong — editable in Admin after onboarding, but the
codes/profiles are code-level:

| | ALCODIS | IGAN |
|---|---|---|
| Currency assumed from file | **EUR** | **EUR** |
| Price meaning | cost | **RRP** → cost = PVP − trade discount |
| Trade discount | 0% | **40% (placeholder — confirm your real %)** |
| Incoterm / place | none | EXW Lleida |
| Stock country | ES | ES |

### Files that match neither layout

Import fails with `No known header row / vendor profile matched`
(`src/importers/genericImporter.js:67`). For each such supplier send: 2–3 real
sample files, their **currency**, **cost vs RRP** (+ discount %), the exact
barcode/price/quantity column headers (marked screenshot is fine), and any
case-pack info. We then build a vendor profile — the most common onboarding
task, so **send these early** (this is what `priceListFormat = OTHER` means).

### Barcode rules (critical)

Products are created **only** from valid barcodes (`server/services/matcher.js:54-96`).

| Situation | What happens |
|---|---|
| Valid EAN/UPC (correct GS1 check digit) | Product matched or created; prices/trends/alerts work |
| Blank barcode | Row → `blank_barcode` exception; never a product |
| Check digit fails | Row → `invalid_barcode` exception |
| Duplicate barcode in one file | First row imports, rest → `duplicate` exception |
| No price | Row → `no_price` exception |
| Case barcode given as unit barcode | **Data corruption** — tell us which is which per supplier |

Keep barcode columns as **text** (leading zeros are significant). Defective
rows are never silently dropped: every row lands somewhere, defects go to the
**Exceptions** screen with counters `imported, matched, blankBarcode,
invalidBarcode, duplicates` (`server/services/importer.js:73-229`).

### Per-case prices

If a price is **per case**, we must know the **units per case** — a column in
the file, `defaultUnitsPerCase` in the log, or a statement ("6 per box"). The
system never infers a bottle from a case barcode.

## 3b. Prepared price list (yours, sent to customers) 🔴

**Template: `04-prepared-price-list.xlsx`** (sheets `PreparedPriceList`,
`VLOOKUP-examples`, `Guide`, `ReadMe`).

**Send two things:**

1. Your **existing** prepared list for a supplier, even if its columns differ
   from our template — we need to see your current transformation, not a
   cleaned-up copy.
2. The same list **in our template structure** (`PreparedPriceList` sheet,
   example rows included) as many columns as you have.

Key columns and rules (full dictionary on the `Guide` sheet):

| Group | Columns | Rule |
|---|---|---|
| Identity | `ean` (text!), `brand`, `product`, `concentration`, `sizeMl`, `gender`, `casePack` | EAN drives everything; `casePack` whenever price relates to a case |
| Traceability | `supplierCode`, `supplierListDate` | which raw list + date this came from |
| Cost side | `costPerUnit`, `costCurrency`, `fxRateToSell`, `landedCost` | **cost must be per BOTTLE**; landed = cost + freight + duty + handling |
| Sell side | `sellPrice`, `sellCurrency`, `markupPct`, `rrp` | your pricing rule made auditable |
| Commercial | `availability`, `validUntil`, `incoterm`, `leadTimeDays`, `notes` | what the customer is told |

If the prepared list is produced by formulas from the raw file, those formulas
belong in item 8 (`09-vlookup-formulas.xlsx`) — together they are the
specification of your pricing process.

---

# 4. Customer offer: company copy + customer copy 🟠

The offer exists in **two copies** and the difference between them defines
exactly what the platform must mask.

| | **Company copy** (internal) | **Customer copy** (sent) |
|---|---|---|
| Template | `05-offer-company-copy.xlsx` | `06-offer-customer-copy.xlsx` |
| Contains | ✅ supplier code, `unitCost`, `landedUnitCost`, `marginPct`, `markupPct`, floor-price notes, approver | ❌ **none of these** — only brand/product/qty/price/total/terms |
| Header block | Offer ref `Q-####`, date, valid until, customer, currency, **prepared by, approved by, status, price-list basis** | Offer ref, date, valid until, customer, prepared by, currency |
| Line items | `line, sku, ean, brand, product, concentration, sizeMl, qty, unitPriceSell, lineTotal, supplierCode, unitCost, landedUnitCost, marginPct, markupPct, incoterm, leadTimeDays, notes` | `line, brand, product, concentration, sizeMl, qty, unitPrice, lineTotal, availability, leadTimeDays, notes` |
| Totals | subtotal, charges, **TOTAL, blended margin %** | subtotal, charges, TOTAL |
| Footer | payment terms + internal notes | Incoterm, payment terms, lead time, validity, standard small print |
| Audience | never leaves the company | goes to the customer |

**Send us 1–3 REAL examples of each** (save the real content over the example
rows; if you only have PDFs, paste the content or attach them and note the
file name in item 5). If your copies are formula-driven spreadsheets, attach
the workbooks and log the formulas in item 8.

Platform note: the built-in export already produces both forms —
`ptp-quote-{id}.xlsx` / `.pdf` masks cost (`server/routes/export.js:132`,
`server/services/reporting.js:319`) — your examples let us match your layout,
terms wording and branding.

---

# 5. Naming format for every document 🟠

**Template: `07-document-naming.xlsx`** (sheets `Naming`, `Rules`, `ReadMe`).
The `pattern` column is the convention we propose; **fill
`yourCurrentNamePattern` with the naming you use today** so both reconcile.

| Document | Audience | Pattern | Example |
|---|---|---|---|
| Supplier raw price list | supplier → us | **keep original filename** (never rename) | `LISTA OCTUBRE ALCODIS(v.2).xls` |
| Supplier raw list (internal archive) | internal | `SUP-{supplierCode}_RAW_{YYYYMMDD}_{seq}` | `SUP-ALCODIS_RAW_20261019_01.xlsx` |
| Quotation request to supplier | us → supplier | `RFQ-{supplierCode}_{YYYYMMDD}_{seq}` | `RFQ-IGAN_20261019_02.xlsx` |
| Supplier proforma invoice | supplier → us | `{supplierCode}_PFI_{YYYYMMDD}_{seq}` | `IGAN_PFI_20261105_01.xlsx` |
| Prepared price list | us → customer | `PL-{customerCode}_{YYYYMMDD}_R{rev}` | `PL-CUST-001_20261019_R1.xlsx` |
| Offer — company copy | internal | `OFFER-{quoteRef}_INTERNAL_{YYYYMMDD}` | `OFFER-Q-0042_INTERNAL_20261019.xlsx` |
| Offer — customer copy | us → customer | `OFFER-{quoteRef}_{customerCode}_{YYYYMMDD}` | `OFFER-Q-0042_CUST-001_20261019.pdf` |
| Customer PO received | customer → us | `{customerCode}_PO_{YYYYMMDD}_{seq}` | `CUST-001_PO_20261020_01.xlsx` |
| Supplier order placement | us → supplier | `placement-{PO-ref}` (system) | `placement-PO-0007.xlsx` |
| Cleaned import | internal | `{supplierCode}-upload-{n}` (system) | `ALCODIS-upload-1.xlsx` |
| Process capture media | client → us | `PROC-{processId}_{step}_{YYYYMMDD}` | `PROC-P03_step1_20261019.mp4` |

Rules (full list on the `Rules` sheet): dates `YYYYMMDD` in names,
`YYYY-MM-DD` in cells; `_` between blocks, `-` inside; two-digit sequence per
day; revisions `R1`, `R2`; **every customer-facing document with an internal
twin ends either `_INTERNAL` (never sent) or the customer code (safe to
send)**; system-generated names are noted as-is.

---

# 6. Base currency per supplier and per customer 🟠

- **Supplier base currency** = column `baseCurrency` in `01-supplier-master.xlsx`
  — the currency its price lists, invoices and settlement use.
- **Customer base currency** = column `baseCurrency` in `02-customer-master.xlsx`
  — the currency you quote, invoice and settle in with them.

Because money always converts between those currencies, we also need the
**FX rate list** (`server/services/fx.js`):

| Excel header | Type | Meaning | Example |
|---|---|---|---|
| `base` | ISO-4217 | "from" currency | `EUR` |
| `quote` | ISO-4217 | "to" currency | `USD` |
| `rate` | number > 0 | **quote units per 1 base unit** — `EUR,USD,1.08` = 1 EUR = 1.08 USD | `1.08` |
| `rateDate` | YYYY-MM-DD | rate date (defaults today) | `2026-10-19` |
| `source` | TEXT | audit trail (`ECB`, `manual`) | `ECB` |
| `booked` | `0`/`1` | 1 = confirmed/locked | `1` |

- **Minimum pairs:** every supplier base currency → your base currency, and
  every customer base currency → your base currency. Inverse pairs are derived
  automatically — never send both directions.
- **No rate for a pair = silent 1.0 conversion** — wrong quotes, no error
  (`server/services/fx.js:7-23`). This is why item 6 is High priority.
- Also confirm your **rate source and refresh cadence** (ECB daily? manual
  monthly?) — or state that manual updates in Admin → FX are acceptable.

---

# 7. Process captures: screenshots / process-flow videos 🟠

For **each process below** send a screen recording (preferred) or annotated
screenshots. **Template: `08-process-capture-checklist.xlsx`** (sheets
`Processes`, `HowToCapture`) — it is the capture plan; fill the `currentTools`
column as you go.

| ID | Process (supplier quote → customer quote) | Capture |
|---|---|---|
| P1 | Receiving supplier price lists — where files arrive, how they are saved & named | video |
| P2 | Opening & validating a raw list — finding the header row, spotting bad barcodes | video |
| P3 | **Converting raw list → prepared price list (the VLOOKUP process)** | video |
| P4 | Updating currency rates — source, cadence, how applied | screenshot + video |
| P5 | Deciding the sell price — markup/discount tiers, minimum margin, rounding | screenshot |
| P6 | Producing the **company copy** of an offer | video |
| P7 | Producing & sending the **customer copy** (masking, PDF, email) | video + the sent email |
| P8 | Receiving customer PO → placing the supplier order | video |
| P9 | Reconciling supplier proforma/invoice against the order | video |
| P10 | Monthly price refresh / detecting supplier price changes | video + before/after files |
| P11 | (your own process not listed — write it in the template) | |

Capture rules (full list on `HowToCapture`): 2–10 min per process, one
process = one file; show the **full window** — formula bar, headers, file
names, folder paths; narrate what you do and why; hide only passwords/API
keys, **never prices, formulas or file names**; name files
`PROC-{processId}_{step}_{YYYYMMDD}.mp4/.png`; put everything in one
`process-captures/` folder in the delivery package.

**If you only capture three: P3, P6, P7** — they define your current pricing
and offer process end to end.

---

# 8. VLOOKUP formulas currently in use 🟠

**Template: `09-vlookup-formulas.xlsx`** (sheets `Formulas`, `HowToExtract`,
`ReadMe`) — one row per distinct formula.

- **Which formulas:** `VLOOKUP`, `XLOOKUP`, `INDEX+MATCH`, `SUMIF(S)`, nested
  `IF`/`IFS` pricing tiers, currency conversion, rounding, margin calculation,
  any cross-workbook reference — across price preparation, FX, pricing, offer
  building, stock lookup and any Excel report you maintain.
- **How to copy without breaking anything:** click the cell → copy the formula
  **from the formula bar** → paste into column `E` of the `Formulas` sheet
  (pre-formatted as text, so nothing executes; if Excel re-evaluates it,
  format the cell as Text first — steps are on `HowToExtract`).
- **Fill per row:** workbook file, sheet, cell/column (e.g. `J2 (dragged to
  J2:Z900)`), formula text, **business purpose in plain words**, input columns,
  output column, related process (P-id), example input → example result.
- **Macros / Power Query:** describe in `businessPurpose` and attach the
  workbook itself.

Together with the prepared price list (3b) and the P3/P6/P7 videos (7), these
formulas **are** the specification of your current process — they tell us
exactly what the platform must reproduce.

---

# 9. Excel templates for every file ✅

**Provided by us — you do not build these.** The pack lives in
`client-templates/` and is regenerated with `npm run gen:templates`.

| File | Contents |
|---|---|
| `00-readme-index.xlsx` | Map of the pack: what each file is, who fills it, priority |
| `01-supplier-master.xlsx` | `Suppliers` + `Guide` + `ReadMe` |
| `02-customer-master.xlsx` | `Customers` + `Guide` + `ReadMe` |
| `03-raw-price-list-log.xlsx` | Log of every raw supplier file you send |
| `04-prepared-price-list.xlsx` | `PreparedPriceList` + `VLOOKUP-examples` + `Guide` + `ReadMe` |
| `05-offer-company-copy.xlsx` | Internal offer layout with cost & margin |
| `06-offer-customer-copy.xlsx` | Customer offer layout, cost-masked |
| `07-document-naming.xlsx` | Naming patterns + rules + your current names column |
| `08-process-capture-checklist.xlsx` | P1–P11 capture plan + recording instructions |
| `09-vlookup-formulas.xlsx` | Formula log (text-safe) + extraction instructions |

The system also **generates** standard-format files for you — do not send:
after every import each supplier list is auto-cleaned into our 49-column
standard template (downloadable Excel/PDF per upload; template-*input*
loading is not wired yet, so native supplier layouts remain the ingesting
path — `server/services/template.js`), and all reports, quotes, placements
and grids export in dual **Excel + PDF** from every screen.

---

## Appendix A — additional operational data (needed, but not part of the 9)

These were on the earlier checklist; keep them on the plan, lower in the pack.

| Item | What | Detail |
|---|---|---|
| A1 | **User accounts** | `username,password,role,displayName,email,active`; roles `viewer` < `analyst` < `buyer` < `admin` (`server/services/auth.js`); bootstrap admin comes from `PTP_ADMIN_USER`/`PTP_ADMIN_PASS` (`04-hosting-hardening.md`) |
| A2 | **Business settings** | 26 keys with defaults — margin floor, capital limit, landed-cost defaults, cash-flow days, alert thresholds, `require_offer_approval`, session length, `capture_secret` (must be replaced). Full table with "Your value" column available on request / in Admin → Settings (`server/db.js:611-639`) |
| A3 | **PFI samples** | One real proforma per supplier for order reconciliation; header auto-detect accepts `ean/upc/gtin`, `descrip/nombre`, `precio/pvp`, `importe/total`, `cantidad/qty` (`server/services/pfi.js:16-50`) |
| A4 | **Opening records** | Opening stock lots (`inventory_lots`), open customer demands (`demands`), historical deals/quotes/orders (≥3 months for forecast) — field lists as previously documented (`db.js:154-219`) |
| A5 | **Capture webhook** | If you use Plaud/reMarkable: choose `capture_secret` (A2) and configure `POST /api/captures/webhook` with `X-Capture-Secret` (`server/routes/captures.js:24-34`) |
| A6 | **AI assistant credentials** | `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` + written OK that product names, prices and counterparty names go to that provider |

---

## Delivery instructions

1. **One package** (zip or shared folder):

   ```
   01-supplier-master.xlsx          (item 1)
   02-customer-master.xlsx          (item 2)
   raw-price-lists/                 (item 3a: files AS RECEIVED + 03 log)
   prepared-price-lists/            (item 3b: existing + our template)
   offers/                          (item 4: real company + customer copies)
   07-document-naming.xlsx          (item 5: with your current names filled)
   fx-rates.xlsx                    (item 6)
   process-captures/                (item 7: P1..Pn media)
   09-vlookup-formulas.xlsx         (item 8)
   ```

2. **Do not reformat supplier files** — send exactly what the supplier sends
   (merged cells, title rows, Spanish headers included). The importer finds the
   header itself.
3. Barcodes: text, never stripped of leading zeros; money: plain numbers, no
   symbols inside cells; dates in *our* files: `YYYY-MM-DD`.
4. Anything you cannot provide — mark it "unavailable" in your reply so we
   adjust the plan (e.g. no history = forecast stays off).

## Acceptance checks we run on receipt

- Raw files: layout detection passes; barcode validity rate reported per file
  (below ~90% we stop and discuss item 3a); currency/price-basis confirmed
  against the `03` log.
- Masters: referential checks (codes unique; every FX pair needed by item 6
  exists; customer codes consistent with offer examples).
- Offers: company vs customer copy diff → the exact masking list for the
  platform.
- Named files: each real document you send matches an agreed pattern (item 5).
- Captures: all P-ids present or explicitly deferred; VLOOKUP log rows have
  plain-language purposes.
- Everything re-exportable as Excel **and** PDF from day one (built in).

## What NOT to send

- ✅ **Product master / SKU list** — products are built automatically from
  valid GTINs in supplier files (`server/services/matcher.js:54-96`). Only if
  barcodes are unusable does this change (tell us — item 3a).
- ✅ **Standard template files** — the system generates the cleaned 49-column
  template after every import (Excel/PDF download per upload).
- ✅ **Report/quote/placement exports** — built in, dual Excel + PDF on every
  screen.
- ✅ **Any file "pre-cleaned" by hand** — raw supplier originals only.

## Open questions (answer with the package)

1. Confirm each supplier's currency, cost-vs-RRP and real trade discount %.
2. Which suppliers use files outside the two known layouts? (item 3a)
3. Base currency for the company itself, and destination market? (item 6)
4. Do your prepared price lists and offers match our template columns, or do
   we need to adapt them? (items 3b, 4)
5. Does any current document name conflict with the proposed patterns? (item 5)
6. Which three processes hurt most today — do we start capture there? (item 7)
7. FX source and refresh cadence? (item 6)
8. Day-one scope for Appendix A items (users, settings, opening records)?
9. Data-sharing OK for the AI assistant? (A6)
