# Acceptance runbook — pilot exit (brief §20 / SOW §4)

This is the sign-off script for the **ten pilot acceptance criteria**. It turns
`02-pilot-sow.md` §4 into steps, expected results and an evidence trail that the
client's product owner (PO) can sign.

> **Rule:** pilot is accepted only when all ten criteria pass **on the client's
> representative real data**. Automated tests (`npm test`) prove the engine on
> the sample fixture; they are supporting evidence, **not** a substitute for
> this run. Any "N/A" needs a written waiver from the PO. Confirm the open
> decisions in `CLIENT-DECISIONS-NEEDED.md` (PO, base currency, FX source,
> destination, column mappings) before starting — a blank answer is not a
> default and an assumed value cannot be signed off.

## Run metadata

| Field | Value |
|---|---|
| Run ID (e.g. `2026-11-ACC-01`) | |
| Date / window | |
| Environment + URL | |
| Commit (`git rev-parse --short HEAD`) | |
| DB / snapshot used (path + SHA-256) | |
| Client data package path | |
| Tester | |
| Client PO (decision maker) | |
| Result | ☐ PASS ☐ FAIL ☐ WAIVED (attach PO note) |

## 0. Before you start (once per run)

1. **Validate the package first** — this must exit `0` before any import:
   ```powershell
   npm run check:client -- <path-to-package> --base <client-base-currency>
   npm run check:client -- <path-to-package> --base <client-base-currency> --json > acceptance\01\intake.json
   ```
   Confirm the base currency with the client; the validator default is `USD`.
   Save `intake.json` as evidence for row 1 below. Blockers stop the run.
2. **Use a separate acceptance database** so demo data cannot contaminate the
   evidence (PowerShell):
   ```powershell
   $env:PTP_DATA_DIR = "C:\path\to\acceptance"
   $env:PTP_DB       = "C:\path\to\acceptance\ptp.db"
   $env:PTP_AUTO_SEED = "false"
   npm start
   ```
3. Sign in with the roles the steps need: **buyer** for import/approve/reserve/deals,
   **admin** for settings/users, **viewer** can observe. Record the account used.
4. Create `acceptance\<run-id>\01` … `10` for screenshots and exported files.
   Never overwrite a previous run's evidence; start a new run ID after fixes.

## 1. Test matrix

Evidence column = the file name you save in `acceptance\<run-id>\<n>\`.

### 1. UPC/EAN aliases match; leading zeros survive Excel import

| | |
|---|---|
| **Where** | **Import Lists**, **Supplier Offers**, **Products & Matching** — `POST /api/import`, `GET /api/offers`, `GET /api/products` |
| **Do** | Import each real raw list (buyer). Search the product master for a known EAN/UPC with leading zeros and for a UPC↔EAN alias. Open **Supplier Offers** and approve/reject a real row. |
| **Expect** | Barcodes are text; leading zeros are exactly as in the source cell. One product resolves per canonical GTIN; aliases of that product match. Offer shows normalised price, list date, supplier and approval state (who/when). An offer with no price or invalid barcode cannot be approved. |
| **Evidence** | `intake.json`, source-cell screenshot, product-match screenshot, approved-offer screenshot |
| **Result** | ☐ PASS ☐ FAIL ☐ WAIVED — note: |

### 2. Case barcodes, testers, gift sets and conflicting sizes do not merge

| | |
|---|---|
| **Where** | **Products & Matching** (tick two → **Compare**), **Exceptions** — `GET /api/products/:id/compare`, `GET /api/exceptions` |
| **Do** | Find a real case barcode and its bottle; a tester/gift set; two rows with conflicting size. Compare each pair. Resolve one exception (analyst) with the PO's decision. |
| **Expect** | Case barcode is a separate alias with `packaging_level=case` and verified units/case; no unit conversion until verified. Testers/gift sets stay distinct products. Size clashes land in **Exceptions** with a reason, never silently merged. |
| **Evidence** | compare screenshots, exception-before/after screenshots |
| **Result** | ☐ PASS ☐ FAIL ☐ WAIVED — note: |

### 3. Duplicate upload creates no extra offers; a new list preserves old prices

| | |
|---|---|
| **Where** | **Import Lists** (upload list), **Compare Lists** (List A vs List B) — `GET /api/uploads`, `GET /api/offers` |
| **Do** | Record offer count. Re-import the **same** file (same date) and re-count. Then import a **new** dated list for that supplier and compare A↔B. |
| **Expect** | Same file is ignored by SHA-256 fingerprint / `(supplier_id, offer_id, list_date)` — offer count unchanged, no new upload rows. New list adds **dated** offers; previous list date and prices remain visible and unchanged. |
| **Evidence** | upload-list screenshots with counts/dates, compare screenshot |
| **Result** | ☐ PASS ☐ FAIL ☐ WAIVED — note: |

### 4. One stock pool offered by two brokers is counted once

| | |
|---|---|
| **Where** | `GET /api/pools` (also the AI tool `observed_supply`). Pool key = `stock_owner_id` + `unique_lot_ref`. |
| **Do** | Pick a real lot offered by two brokers with the same owner/lot reference. Compare the brokers' quantities with the pool row and with `naiveSum`. |
| **Expect** | Both offers are members of **one** pool; `deduplicated: true`, `brokers` lists both, pool quantity = **MAX** of members (not the sum). `doubleCountAvoided` reflects the removed double count. |
| **Evidence** | JSON response screenshot/file with the pool and totals |
| **Result** | ☐ PASS ☐ FAIL ☐ WAIVED — note: |

### 5. Unknown and stale stock are excluded from confirmed totals

| | |
|---|---|
| **Where** | `GET /api/pools`, **Lowest Landed Cost** (`GET /api/sourcing/lowest`), **Alerts** (`offer_expired`) |
| **Do** | Find a broker offer with no owner/lot reference, an expired `valid_until`, and one below MOQ. Ask **Find lowest** for a real SKU; refresh alerts. |
| **Expect** | Owner-less offers are **unverified** and reported in `unverifiedQuantity`/`unverifiedCount`, never merged or added to confirmed supply. Sourcing ranks only executable offers (in stock, MOQ met, unexpired, not retail-only). Expired offers raise an alert with a date. |
| **Evidence** | pools JSON, lowest-cost screenshot, expired-alert screenshot |
| **Result** | ☐ PASS ☐ FAIL ☐ WAIVED — note: |

### 6. The §9 worked example reconciles exactly

| | |
|---|---|
| **Where** | **Deal Calculator** — manual landed cost, `POST /api/deals/compute`; target from `03-phase0-spec.md` §4.4 |
| **Do** | Enter: **Supplier offer** = *manual landed cost*; **Landed unit cost** `33`; **Selling unit price** `40`; **Quantity** `1000`; **Outbound cost/unit** `2`; Discount, Commission, Expected credit loss, Supplier advance % and Customer deposit % = `0`; **Customer pay days** `90`; **Supplier pay days** `0`; leave order date as today. Press **Calculate**. If you instead select a real offer, its landed components must sum to `$33.00/bottle` (purchase `$30.00` + inbound `$3.00`). |
| **Expect** | Revenue `$40,000.00`; cost `$33,000.00`; gross profit `$7,000.00`; **gross margin 17.5%**; deal costs `$2,000.00`; **contribution `$5,000.00` / 12.5%**; **deployed capital `$35,000.00`**; **simple deal return 14.29%**; 90-day **annualised 57.95%**. No invented precision. |
| **Evidence** | `06-deal-calculator.png`, JSON response if captured |
| **Result** | ☐ PASS ☐ FAIL ☐ WAIVED — note: |

### 7. Case conversion, MOQ, price tiers, FX, included freight, recoverable taxes, partial receipts and returns produce reviewed results

| | |
|---|---|
| **Where** | **Price Comparison** / **Offer Builder**, **Lowest Landed Cost**, **Settings & FX**, **Shipment Costs**, **Deal Calculator**, **Orders & Payments** (`POST /api/import`, `/api/shipments/:id/allocate`, `/orders/:id/status`) |
| **Do** | Walk **one real deal** through: a case-priced offer converted to per bottle; a quantity crossing an MOQ/price tier; a supplier list in a second currency with a dated FX rate; a shipment with freight/duty/handling allocated; recoverable VAT/IVA; a partial receipt; a return. Record each figure from the source document alongside the screen value. |
| **Expect** | Per-bottle basis used before comparison. Tier/MOQ changes the landed cost. FX uses a **dated** rate (USD per source unit), original currency retained. If a rate is absent, comparison/sourcing/deal calculator must display the `FX rate missing — 1:1 assumed` flag and the figure must **not** be signed off until a real rate is loaded. Shipment allocations sum back to the shipment total (rounding remainder disclosed). Recoverable tax appears in **cash**, not in landed cost. Partial receipt/return updates status without rewriting history; anything unresolved is flagged, not guessed. |
| **Evidence** | `07-case-tier-fx.png`, `07-shipment-allocation.png`, `07-partial-return.png`, source-document copies |
| **Result** | ☐ PASS ☐ FAIL ☐ WAIVED — note: |

### 8. Stock reservations cannot oversell the same lot

| | |
|---|---|
| **Where** | **Inventory** (Add lot / Reserve / Release), `GET /api/inventory/availability`, `POST /api/reservations` |
| **Do** | Add or pick a real lot with usable on-hand `N`. Reserve `N`. Try to reserve `1` more. Check availability. Release the reservation. |
| **Expect** | After reserving `N`, availability = `0` and the extra reservation is refused (error shown). Usable on hand − active reservations never goes negative; in-transit stock is not available before receipt. Release restores availability. |
| **Evidence** | `08-reserve-oversell.png`, availability JSON |
| **Result** | ☐ PASS ☐ FAIL ☐ WAIVED — note: |

### 9. Actual purchase, sales and payment records reconcile with the supplied accounts sample

| | |
|---|---|
| **Where** | **Orders & Payments** (Create order / Record payment), **Reports** → **GL Journal** (`GET /api/export/gl.xlsx` or `.pdf`) |
| **Do** | Enter the client's real purchase/sales orders and payments from the sample. Export the GL journal in both formats. Compare its lines and per-currency totals to the client's accounts extract. |
| **Expect** | Cash-basis double entry per payment (outbound: Purchases debit / Bank credit; inbound: Bank debit / Sales credit). **Each currency balances separately** — debit = credit; no cross-currency totals and no hidden netting. Any imbalance is labelled `OUT OF BALANCE`, not silently resolved. Differences to the client extract are explained line by line. |
| **Evidence** | `09-gl.xlsx`, `09-gl.pdf`, `09-accounts-reconciliation.xlsx` |
| **Result** | ☐ PASS ☐ FAIL ☐ WAIVED — note: |

### 10. Supplier costs do not appear on customer exports

| | |
|---|---|
| **Where** | **Deals & Quotes** → row **Quote** (`GET /api/export/quote/:id.xlsx|.pdf`), client's customer-copy offer from item 4/5 of the package |
| **Do** | Download a real quote in both formats. Open the client's customer offer copy. Search both for supplier names/codes, `unitCost`, `landedUnitCost`, `marginPct`, `markupPct` and any supplier cost figure. |
| **Expect** | No supplier identity, buying cost, landed cost, margin or markup anywhere in either customer-facing document. Quantity, price, validity, payment/delivery terms are present. |
| **Evidence** | `10-quote.xlsx`, `10-quote.pdf`, `10-customer-offer.png`, search-result screenshots |
| **Result** | ☐ PASS ☐ FAIL ☐ WAIVED — note: |

## 2. Supporting checks (run, attach output)

```powershell
npm test                                              # engine correctness on the fixture
npm run check:client -- <package> --base <base>       # package pre-check (must be 0)
git rev-parse --short HEAD                            # record build in the run metadata
```

`npm test` uses a throwaway database and the sample fixture. It does **not**
satisfy any of the ten criteria above; attach it as engine evidence only.

## 3. Demo to pair with sign-off (not acceptance criteria)

Use the same client data: intake → import/exceptions → landed cost →
buying recommendation → cost-masked quote → supplier placement → PFI variance →
shipment allocation → payment → GL + stock exports → `GET /api/integrations` →
text-only capture (Plaud transcript / converted reMarkable text; PDF rejected)
→ Forecast page showing either measured MAPE or the honest "insufficient
history" reason. Archive the walkthrough with `11-demo-recording` evidence.

## 4. Sign-off

| Field | Value |
|---|---|
| Criteria passed | ___ / 10 |
| Failures / waivers (reference criterion number + PO note) | |
| Evidence pack location | `acceptance\<run-id>\` |
| Tester name / date | |
| **Client PO name / signature / date** | |
| **Decision** | ☐ Pilot accepted (M2) ☐ Not accepted — revisit criteria: ___ |

Do not mark M2 complete until the PO signature is in the evidence pack. After
sign-off, push the same commit hash and database snapshot reference into the
project status note so the acceptance is reproducible.
