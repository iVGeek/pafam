# Client email — data required to configure and accept the platform

Ready to send after replacing `[Name]` and the recipient. Plain text below; attach
the `client-templates/` pack and `06-client-data-checklist.md`.

---

**Subject:** Pilot data pack needed to configure and sign off the trading platform

Hello [Name],

Thank you for sending the two supplier price lists (L'Oréal 17 Nov analysis and
GE Wholesale 15 Nov). We have already built importers for both layouts and
loaded them successfully:

- **L'Oréal:** 38 products, all 38 with valid EANs.
- **GE Wholesale:** 944 rows, 909 matched to products. 25 blank UPCs, 10 invalid
  UPCs and 1 duplicate were captured as exceptions — nothing was guessed or
  invented.

That is a useful start, but it covers only **one item** of the onboarding pack
(item 3a: raw price lists) for **two suppliers**. A price list on its own cannot
configure or validate the system, so I have set out below exactly what we still
need and why.

## First, an important point about "training"

Our platform is rule-based, not a model that learns from price lists. Barcode
matching, landed cost, margin and cash-flow rules are deterministic. To make it
work on your business we need three different kinds of input:

1. **Commercial parameters** to configure the rules — supplier terms,
   currencies, FX, tax/duty, payment days.
2. **Real documents** to validate them against — the files your team produces
   today — so we can prove the ten pilot acceptance criteria on your data
   rather than on samples.
3. **Several months of real delivery history** before the demand forecast can
   report a measured accuracy figure. Until then it correctly reports
   "insufficient history" rather than a guessed number.

## 1. Commercial configuration — needed before we can price anything

- **Supplier master** (`01-supplier-master.xlsx`) for **every supplier you plan
  to use in year one**: code, name, base currency, whether the price list is
  cost or RRP, trade discount %, incoterm, payment terms, duty %, freight /
  insurance / brokerage / handling per unit, recoverable tax %, stock country.
- **Specifically for the two files you sent, please confirm the column
  meanings** (we have made conservative assumptions but cannot sign them off
  without you):
  - L'Oréal: is `NEW CP` the price we actually pay, or is `GCS CP` the real
    cost? Is `SP` your intended selling price or a retail reference? Is `QTY`
    units or cases? (We currently read NEW CP = cost, SP = reference only,
    QTY = units, and ignore GCS CP / CP Var as analysis columns.)
  - GE: is `Price (USD)` our acquisition cost or a retail price? Is `Stock`
    units or cases? (We currently read cost / units.)
- **Customer master** (`02-customer-master.xlsx`) for a few real customers:
  name, quote/invoice currency, payment terms, region.
- **Your company base currency**, plus **FX rates** (`10-fx-rates.xlsx`) for
  every supplier and customer currency to that base, with rate dates and
  source. Without a rate the comparison, sourcing and deal calculator now
  flag the 1:1 figure as an explicit assumption instead of presenting it as
  a real conversion — but an assumed rate cannot be signed off for trading.

## 2. Real documents — needed to sign off the pilot

Please send **1–3 real examples** of each (your actual current documents, not
cleaned-up copies):

- The **prepared price list** you send customers — both your current format and
  the same content mapped to our template.
- **Customer offers in both versions**: the internal/company copy and the
  customer copy. We use the difference to prove that supplier costs never leak
  into customer documents.
- **Purchase orders, sales orders and payment records**, plus an **extract from
  your accounts**, so we can reconcile the GL journal line by line.
- A **shipment** with freight / duty / handling costs, to verify allocation and
  per-bottle landed cost.
- Evidence of **case packs** (units per case), **testers / gift sets**, and any
  **conflicting size descriptions** — these must not merge into one product.
- **Two brokers offering the same physical lot** (same owner + lot reference),
  so we can prove it is counted once.
- An **expired or stale offer** and one **below minimum order quantity**.
- Your current **document naming conventions** (`07-document-naming.xlsx`) and
  the **VLOOKUP formulas** used to build prepared lists
  (`09-vlookup-formulas.xlsx`). Together these define the pricing process we
  are reproducing.

## 3. History — needed for trends, alerts and the forecast

- **6–12 months of supplier price lists**, where available, so price trends,
  change alerts and supplier scorecards have something real to measure.
- **At least 5 months of delivered orders** (product, quantity, delivery date,
  price). This is the minimum for the forecast to produce a measured accuracy
  figure.

## 4. Two organisational items

- Nominate the **product owner** (domain owner) who can approve product
  matches, prices, quantities and buying rules, and confirm the turnaround time
  for clearing the exceptions queue.
- Confirm the **day-one scope** for users, settings and opening records
  (Appendix A of the data checklist).

## Attachments

- The template pack in `client-templates/` (`00-readme-index.xlsx` is the map)
- `06-client-data-checklist.md` — every field, its priority and why it matters
- `ACCEPTANCE-RUNBOOK.md` — the ten pilot criteria we need to pass on real data

If a field is genuinely unavailable, please mark it **"unavailable"** in the
file rather than leaving it blank — we will not invent values. If it is easier,
we can walk through the templates together in a short call.

The critical path is **items 1 and 6 first** (supplier master + FX), then the
real documents, then the history. That order lets us start validating while the
rest is being gathered.

Kind regards,
[Name]

---

*Internal note (do not send): source of the ask is `06-client-data-checklist.md`
§19–32 and §497, `02-pilot-sow.md` §5, and `ACCEPTANCE-RUNBOOK.md` §1. The two
price lists cover only checklist item 3a for L'Oréal and GE. Open questions 10
and 11 hold the unconfirmed column mappings; correcting them is a one-line
supplier-default change plus re-import.*
