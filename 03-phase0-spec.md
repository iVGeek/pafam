# Phase 0 — Discovery Artefacts

Excel template, data dictionary, database model and calculation specification.
Derived from §5 (template), §6 (matching), §7–§9 (calculations) of the brief.

---

## 1. Standard supplier Excel template

One row per supplier offer for a specific SKU, packaging condition, stock lot, location and
quantity price tier (§5). **Blank = unknown; never 0.**

**Sheet: `Offers`** (sheet 2 `FieldGuide` lists allowable values; sheet 3 `Enum` holds lookups).

### 1.1 Source and dates
| # | Column header | Notes |
|---|---------------|-------|
| 1 | Supplier ID | required |
| 2 | Supplier name | |
| 3 | Offer ID | supplier's reference |
| 4 | List date | dated snapshot anchor (§3) |
| 5 | Valid until | |
| 6 | Last stock confirmation | |
| 7 | Source file | filled/verified by system |
| 8 | Source row | filled/verified by system |

### 1.2 Product identity
| # | Column header | Notes |
|---|---------------|-------|
| 9 | Original EAN / UPC | **stored as text** |
| 10 | Internal SKU | |
| 11 | Brand | |
| 12 | Fragrance name | |
| 13 | Concentration | EDP/EDT/etc. |
| 14 | Size (ml) | |
| 15 | Gender / category | |
| 16 | Set contents | |

### 1.3 Packaging and condition
| # | Column header | Notes |
|---|---------------|-------|
| 17 | Retail pack or tester | |
| 18 | With / without cap | |
| 19 | With / without box | |
| 20 | Sealed or unboxed | |
| 21 | Damage status | |
| 22 | Batch / lot reference | |
| 23 | Manufacture date | only if verified |

### 1.4 Price and quantity
| # | Column header | Notes |
|---|---------------|-------|
| 24 | Currency | ISO code |
| 25 | Price | per unit or case |
| 26 | Price basis | unit \| case |
| 27 | Units per case | required if basis=case |
| 28 | Available quantity | |
| 29 | Quantity unit | |
| 30 | MOQ | |
| 31 | Order multiple | |
| 32 | Price tier minimum | |
| 33 | Price tier maximum | |

### 1.5 Logistics and terms
| # | Column header | Notes |
|---|---------------|-------|
| 34 | Stock country | |
| 35 | Stock warehouse | |
| 36 | Country of origin | |
| 37 | Incoterm | e.g. DAP, FOB |
| 38 | Incoterm named place | |
| 39 | Ready date | |
| 40 | Lead time | |
| 41 | Payment terms | |
| 42 | Freight inclusions | |

### 1.6 Eligibility and evidence
| # | Column header | Notes |
|---|---------------|-------|
| 43 | Permitted destination | |
| 44 | Permitted channels | |
| 45 | US suitability status | |
| 46 | Authenticity documents | |
| 47 | Stock owner ID | dedup key (§11) |
| 48 | Unique lot reference | dedup key (§11) |
| 49 | Stock confidence | firm \| indicative \| on request |

---

## 2. Data dictionary

Type key: `TEXT` = string, `DEC` = decimal, `INT` = integer, `DATE` = date, `ENUM` = controlled
value, `CUR` = currency amount, `BOOL` = boolean.

### 2.1 Offer / supplier fields (primary table)

| Field | Group | Type | Req | Validation / rule |
|-------|-------|------|-----|-------------------|
| supplier_id | Source | TEXT | Y | must exist in supplier master |
| supplier_name | Source | TEXT | Y | snapshot of name at list date |
| offer_id | Source | TEXT | Y | unique per supplier + list_date |
| list_date | Source | DATE | Y | snapshot anchor; immutable |
| valid_until | Source | DATE | N | ≥ list_date if present |
| last_stock_confirmation | Source | DATE | N | freshness source (§11) |
| source_file_id | Source | TEXT | Y | FK → upload_file; system-set |
| source_row | Source | INT | Y | system-set |
| gtin_source | Identity | TEXT | N | original value, **stored as text** |
| gtin_canonical | Identity | TEXT | N | GTIN-14, padded, valid check digit only |
| gtin_type | Identity | ENUM | N | EAN-13 \| UPC-A \| EAN-8 \| case |
| internal_sku | Identity | TEXT | N | must resolve via alias table |
| brand | Identity | TEXT | N | |
| fragrance_name | Identity | TEXT | N | |
| concentration | Identity | ENUM | N | EDP/EDT/EDC/Parfum/other |
| size_ml | Identity | INT | N | > 0 |
| gender_category | Identity | ENUM | N | |
| set_contents | Identity | TEXT | N | |
| pack_type | Packaging | ENUM | N | retail \| tester \| gift set \| refill |
| has_cap | Packaging | BOOL | N | blank = unknown |
| has_box | Packaging | BOOL | N | blank = unknown |
| sealed_status | Packaging | ENUM | N | sealed \| unboxed |
| damage_status | Packaging | ENUM | N | none \| minor \| major \| unknown |
| lot_reference | Packaging | TEXT | N | batch/lot |
| manufacture_date | Packaging | DATE | N | only if verified |
| currency | Price | TEXT | Y | ISO-4217 |
| price | Price | DEC | Y | > 0 |
| price_basis | Price | ENUM | Y | unit \| case |
| units_per_case | Price | INT | Cond | required if price_basis = case |
| available_quantity | Price | INT | N | blank = unknown |
| quantity_unit | Price | TEXT | N | |
| moq | Price | INT | N | |
| order_multiple | Price | INT | N | |
| tier_min | Price | INT | N | |
| tier_max | Price | INT | N | ≥ tier_min |
| stock_country | Logistics | TEXT | N | |
| stock_warehouse | Logistics | TEXT | N | |
| country_of_origin | Logistics | TEXT | N | |
| incoterm | Logistics | ENUM | N | DAP/FOB/EXW/CIF/… |
| incoterm_place | Logistics | TEXT | N | required if incoterm present |
| ready_date | Logistics | DATE | N | |
| lead_time_days | Logistics | INT | N | |
| payment_terms | Logistics | TEXT | N | |
| freight_inclusions | Logistics | TEXT | N | drives double-count control (§8) |
| permitted_destination | Eligibility | TEXT | N | |
| permitted_channels | Eligibility | TEXT | N | |
| us_suitability_status | Eligibility | ENUM | N | eligible \| review \| not eligible |
| authenticity_documents | Eligibility | TEXT | N | |
| stock_owner_id | Eligibility | TEXT | N | dedup key |
| unique_lot_ref | Eligibility | TEXT | N | dedup key |
| stock_confidence | Eligibility | ENUM | N | firm \| indicative \| on_request |

### 2.2 Validation rules (§6)

| Rule | Behaviour |
|------|-----------|
| Barcode stored as text | leading zeros preserved on import/export |
| Length + check digit | invalid → exception queue |
| Canonical GTIN | valid GTINs padded to 14 digits; source value retained |
| Unit vs case | never equate case barcode to bottle without verified units-per-case |
| Post-barcode identity | brand, fragrance, concentration, size, set contents, condition must agree |
| Missing/conflicting/invalid barcode | → exception queue |
| Description match | suggests candidates only; **never auto-merges** |
| Retail/tester/gift set/refill/damaged | kept separate; comparison group allowed without merging inventory |

---

## 3. Database model

Key principle (§3): **list snapshots are immutable history.** New imports add dated offers;
they never overwrite past prices or prior stock snapshots.

### 3.1 Core entities

```
Supplier ──< SupplierOffer >── Product
                    │              │
                    │              ├──< ProductAlias (internal SKU ⇄ barcode)
                    │              └──< ComparisonGroupMember
                    │
                    ├──< PriceTier
                    ├── StockLot >── StockOwner
                    ├──< OfferException
                    └── UploadFile ──< UploadRow (audit)

Product ──< InventoryLot >── Warehouse
               └──< Reservation

Customer ──< CustomerDemand ──< Quote ──< Order ──< Receipt
                                              └──< Delivery
                                    Order ──< Payment

FxRate            (dated, USD per source currency, source + booked)
Shipment          ──< CostAllocation (driver: weight/volume/value)
DealScenario      (conservative/base/upside + stress)
AuditLog, User, Role
```

### 3.2 Selected table definitions

**SupplierOffer** (immutable, dated)
- `offer_pk`, `supplier_id`, `offer_id`, `list_date`, `valid_until`,
  `last_stock_confirmation`, `source_file_id`, `source_row`, all §2.1 field columns,
  `status` (draft|review|approved|rejected|expired), `approved_by`, `approved_at`,
  `created_at`
- Unique constraint: `(supplier_id, offer_id, list_date)` — **prevents duplicate offers on
  re-import (§3, §20)**.

**Product** — `product_pk`, `canonical_gtin`, `internal_sku`, `brand`, `fragrance_name`,
`concentration`, `size_ml`, `gender_category`, `set_contents`, `created_at`.

**ProductAlias** — `alias_pk`, `product_fk`, `alias_type` (gtin|sku|case_barcode),
`alias_value`, `packaging_level`, `verified_units_per_case`, `verified` (bool), `source`.
- Case barcodes store `packaging_level=case` and require `verified_units_per_case` before any
  unit conversion (§6).

**StockLot** — `lot_pk`, `stock_owner_id`, `unique_lot_ref`, `stock_country`,
`stock_warehouse`, `confidence`, `first_seen`, `last_confirmed`.
- Duplicate broker offers for the same `(stock_owner_id, unique_lot_ref)` link to one
  `stock_pool` and are counted once (§11, §20).

**InventoryLot** (own stock) — `inv_pk`, `warehouse_fk`, `lot_reference`, `on_hand`,
`reserved`, `quarantined`, `in_transit`.
- Available-to-sell = usable on hand − reservations; **inbound excluded until receipt** (§11).

**Reservation** — `res_pk`, `inv_pk`, `demand_fk`, `qty`, `created_at`.
- Constraint: Σ active reservations per InventoryLot ≤ usable on hand (§20).

**CustomerDemand** (dated) — `demand_pk`, `customer_fk`, `product_fk`, `status`
(wishlist|active|quote|order|fulfilled|lost|expired), `captured_at`, `evidence_link`,
`owner`, `extraction_confidence`, `match_confidence`, `approved_by`, `expiry_date`,
`supersedes_demand_fk` (version history — never silently overwrites a confirmed order §15).

**FxRate** — `fx_pk`, `source_currency`, `rate` (USD per source unit), `rate_date`,
`rate_source`, `booked` (bool).

**Shipment / CostAllocation** — `shipment_fk`, `cost_type`, `amount`, `driver`
(chargeable_weight|volume|value), `allocated_to_offer_fk`.
- Allocated totals must reconcile to the shipment (§8).

**DealScenario** — `scenario_fk`, `deal_fk`, `kind` (conservative|base|upside),
plus stress flags `price_drop`, `customer_default` (§8).

---

## 4. Calculation specification

### 4.1 Metrics (§7)

| Metric | Formula |
|--------|---------|
| Landed unit cost | `purchase_price_usd + inbound_freight + insurance + duty + brokerage + handling + nonrecoverable_taxes + inbound_fees`, per **sellable** unit |
| Net unit revenue | `selling_price − discounts − rebates − returns_allowance − customer_deductions` |
| Gross profit | `net_revenue − landed_cost` |
| Gross margin % | `gross_profit ÷ net_revenue` |
| Deal contribution | `gross_profit − outbound_delivery − commission − transaction_fees − storage − financing − expected_credit_loss` |
| Contribution margin | `deal_contribution ÷ net_revenue` |
| Markup (on cost) | `gross_profit ÷ landed_cost` — kept **separate** from margin |
| Capital efficiency | `deal_contribution ÷ deployed_capital` |
| Simple annualised return | `return × 365 ÷ cash_cycle_days` — **never presented as guaranteed** |

### 4.2 Controls (§8)

1. **Define each cost once** — respect Incoterm inclusions to prevent double counting.
2. **Allocate shipment costs** by a documented driver (chargeable weight / volume / value);
   allocated totals must reconcile to the shipment.
3. **Recoverable taxes** affect cash funding but are **not** permanent cost.
4. Track refundable deposits, supplier advances and customer deposits in **cash flows**.
5. Use **broker-confirmed** duty and import inputs for the specific origin/classification/date.
6. **Missing material costs ⇒ show incomplete profitability**, never a false zero-cost result.
7. Store financing rate and funding dates; for multiple payments/receipts use **daily funding
   balances**; use **XIRR only where dated cash flows support it**.
8. Show conservative / base / upside cases; include price-drop and customer-default stress cases.

### 4.3 FX rule (§7)

Convert using a **dated** rate expressed as **USD per unit of source currency**; retain original
currency, rate source, rate date and any booked rate. **Convert case prices to bottle prices
before comparing.**

### 4.4 Worked example (§9) — reconciliation target

```
Buy 1,000 bottles @ $30            = $30,000.00
Inbound costs                      =  $3,000.00
Landed unit cost                   = $33.00/bottle
Sell @ $40 (1,000)                 = $40,000.00
Gross profit = 40,000 − 33,000     =  $7,000.00
Gross margin = 7,000 / 40,000      =     17.5%
Outbound + other deal costs        =  $2,000.00
Deal contribution = 7,000 − 2,000  =  $5,000.00
Contribution margin = 5,000/40,000 =     12.5%
Deployed capital                   = $35,000.00
Simple deal return = 5,000/35,000  =     14.29%
90-day cycle → 14.29% × 365/90     =     57.95%  (not a forecast)
```

### 4.5 Quantity scenarios (§7)

Recompute landed cost and deal contribution per MOQ / price tier, because tiers and freight
change the outcome. Run conservative / base / upside for selling price, FX, freight, delay and
sell-through.

### 4.6 Buying recommendation output (§10)

Must display: supplier, exact SKU, executable quantity, customer matches, demand status,
landed cost, suggested selling price, contribution, cash requirement, expected collection date,
missing assumptions — subject to manager-set minimum margins, capital limits and approval rules.

### 4.7 Customer quote output (§16, §20)

Includes quantity, validity, delivery terms, payment terms. **Never reveals supplier names or
buying costs.**
