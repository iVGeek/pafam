# Fixed-Price Pilot — Statement of Work (SOW)

**Project:** Perfume Wholesale Trading Platform — Pilot
**Client:** [Client legal name]
**Supplier:** [Vendor legal name]
**Reference:** Perfume wholesale trading software brief, 10 October 2026
**SOW date:** [date]  **Version:** 1.0

This SOW covers **Phase 0 (Discovery) + Phase 1 (Data foundation) + Phase 2 (Trading engine)**
only — i.e. the working pilot. Phase 3 (Intelligence) and Phase 4 (Advanced decisions) are
explicitly **out of scope** and are covered by a separate SOW.

---

## 1. Objective

Deliver a working pilot that lets staff identify a profitable, executable buying opportunity for
a specific customer **without manually joining supplier lists**, where every recommendation can be
traced to its source and assumptions (§23).

The pilot must demonstrate one complete end-to-end workflow (§22):

```
import validated SKU → confirmed stock → customer demand → landed margin
→ reviewed quote → order → receipt → sale → collection → realised margin
```

---

## 2. In-scope deliverables

**Phase 0 — Discovery**
- Standard supplier Excel template (§5).
- Data dictionary (§4).
- Database model (§4), including dated snapshot / history design (§3).
- Calculation specification (§4, §7–§10).
- Written acceptance targets agreed before build (§4, §20).

**Phase 1 — Data foundation**
- Excel **import & export** with original-file retention, file versions, row references and
  upload timestamps (§3).
- Duplicate-upload protection: re-importing the same file must not duplicate offers (§3, §20).
- Column-mapping screens with validation.
- Barcode handling: stored as text, leading zeros preserved, length + check-digit validation,
  canonical GTIN-14 for valid GTINs, source value preserved (§6).
- Internal SKU + barcode alias table; unit-vs-case separation; no case→bottle equivalence
  without a verified units-per-case conversion (§6).
- Product master (brand, fragrance, concentration, size, set contents) with post-barcode
  identity checks (§6).
- Exception queue for missing / conflicting / invalid barcodes; description matching may
  suggest but never auto-merge (§6).
- Dated offer snapshots that never overwrite history (§3).
- Upload and approval audit log.

**Phase 2 — Trading engine**
- Landed unit cost with FX, inbound freight, insurance, duty, brokerage, handling,
  non-recoverable taxes and inbound fees (§7).
- Net unit revenue, gross profit/margin, deal contribution, contribution margin, markup (§7).
- Cash return, capital efficiency, simple annualised return (never presented as guaranteed) (§7).
- Calculation controls: define each cost once, Incoterm inclusions, documented allocation driver,
  recoverable-tax treatment, incomplete-profitability flagging, daily funding balances, XIRR
  only with dated cash flows (§8).
- MOQ / quantity tiers / price-tier scenarios; conservative / base / upside plus price-drop and
  customer-default stress cases (§7, §8).
- Own inventory: on-hand, reserved, quarantined, available-to-sell, in transit, by warehouse
  and lot; **reservations cannot oversell a lot** (§11, §20).
- Customer records and **dated** demand records (§14).
- Buying recommendation output (§10) and customer quote export that **never reveals supplier
  names or buying costs** (§16, §20).
- Role-based access, audit log, cost/notes restriction to authorised staff (§19).

---

## 3. Out of scope (this SOW)

- Phase 3: market trend charts (§12), alerts engine (§13), Plaud ingestion (§15),
  reMarkable ingestion (§15), note extraction & follow-up tasks.
- Phase 4: demand forecasts, purchasing optimisation, accounting/warehouse integrations (§17).
- Supplier-ranking KPI suite and other §18 analytics beyond the buying recommendation.
- AI/LLM note extraction of any kind.
- Import/legal/regulatory clearance or broker confirmation of perfume transport rules (§19).
- Data migration of more than the agreed representative clean sample.
- Barcode hardware / scanners, ERP/accounting licences, third-party subscription fees.

---

## 4. Acceptance criteria (pilot exit — derived from §20)

1. Valid UPC and EAN aliases match correctly; leading zeros survive Excel import.
2. Case barcodes, testers, gift sets and conflicting sizes do not merge incorrectly.
3. Duplicate file upload creates no extra offers; a new list preserves old prices.
4. One stock pool offered by two brokers is counted once.
5. Unknown and stale stock are excluded from confirmed totals.
6. The §9 illustrative example reconciles exactly.
7. Case conversion, MOQ, price tiers, FX, included freight, recoverable taxes, partial receipts
   and returns produce reviewed results.
8. Stock reservations cannot oversell the same lot.
9. Actual purchase, sales and payment records reconcile with a supplied sample of accounts.
10. Supplier costs do not appear on customer exports.

Pilot is accepted when all ten criteria pass on the client's representative real data sample.

---

## 5. Client responsibilities

- Nominate the decision-making domain owner (PO) with authority to approve matches, prices,
  quantities and buying rules (§3, §15, §16).
- Provide a representative, cleaned supplier-file sample and completed historical deals before
  Phase 1 migration begins (§17).
- Provide sample customer notes, at least several real supplier formats, overlapping stock
  offers, multiple currencies, case prices, retail packs and testers (§22).
- Confirm agreed FX source, duty/import inputs and Incoterm rules (§7, §8).
- Review and approve exception-queue items within the agreed turnaround to avoid schedule drift.

---

## 6. Assumptions

- Single production deployment; one primary operating company.
- English-language UI.
- Client provides a representative clean data sample; large-scale migration is Phase 4.
- Hosting/cloud accounts and third-party subscriptions are client-owned and client-paid.
- Supplier files are Excel/CSV; no bespoke real-time supplier feeds in the pilot.
- No Plaud/reMarkable automation is required for pilot acceptance.

---

## 7. Commercials (indicative)

**Fixed price — Pilot (Phases 0–2).** Effort basis: 1,400–1,800 engineering hours (~8–10
person-months), engineering-only, per the accompanying delivery plan.

| Scenario | Blended $/hr | Fixed price |
|----------|--------------|-------------|
| Lean (remote / mid-senior) | $85 | ~$120k |
| Standard (US senior blend) | $120 | ~$192k |
| Premium (US senior / specialist) | $160 | ~$256k |

Full-team figures (adding PM/UX/QA/EM/DevOps) are **1.45×–2.2×** the above depending on the
delivery model chosen.

**Payment schedule (suggested)**

| Milestone | % | Trigger |
|-----------|----|---------|
| M0 Spec signed off | 15% | Week 4 |
| M1 Data foundation accepted | 35% | Week 14 |
| M2 Pilot go-live / all §20 tests pass | 40% | Week 24 |
| Warranty / 30-day defect period | 10% | 30 days post-M2 |

**Exclusions:** taxes; travel; hosting; third-party licences; content/data entry; ongoing run
costs. **Warranty:** 30 days of defect fixes post-M2. **Change control:** any new requirement is
estimated and scheduled via written change order; scope is frozen at M0.

---

## 8. Timeline

- Phase 0 Discovery: 3–5 weeks
- Phase 1 Data foundation: 6–9 weeks
- Phase 2 Trading engine: 7–10 weeks
- **Pilot total: ~24 weeks (~4–6 months)**, with appropriate phase overlap.
