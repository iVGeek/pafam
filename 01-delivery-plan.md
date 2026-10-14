# Perfume Trading Platform — Delivery Plan (Milestones, Gantt, Staffing)

Source brief: *Perfume wholesale trading software brief* — Instructions for staff and the software
development team, main selling market USA, 10 October 2026.

This plan sequences the four phases defined in §17 of the brief and maps every section of the
brief to a phase, an owner and an exit criterion.

---

## 1. Assumed delivery team

| Code | Role | Pilot % | v1 % | Full % |
|------|------|---------|------|--------|
| PO   | Product owner / trading domain expert | 50 | 50 | 50 |
| PM   | Project / delivery manager | 25 | 25 | 25 |
| TL   | Tech lead (also hands-on) | 100 | 100 | 100 |
| DEV1 | Full-stack engineer | 100 | 100 | 100 |
| DEV2 | Full-stack engineer | 100 | 100 | 100 |
| DEV3 | Full-stack / data engineer | 0 | 100 | 100 |
| UX   | UX/UI designer | 25 | 25 | 25 |
| QA   | QA engineer | 50 | 50 | 50 |
| DO   | DevOps / platform (shared) | 25 | 25 | 25 |

Assumed stack: TypeScript — React front end, Node/NestJS **or** Python FastAPI back end,
PostgreSQL, S3-compatible object storage for original uploads, role-based auth.
Sprint length: **2 weeks**. Efficiency assumption: 60–65% of dev time is focused coding.

> The trading domain expert (PO) is mandatory. The brief repeatedly requires **staff approval**
> of matches, prices, quantities and buying decisions (§3, §15, §16). Without a decision-making
> domain owner the project stalls regardless of engineering capacity.

---

## 2. Phase → brief-section traceability

| Phase | Brief sections | Delivered capability |
|-------|----------------|----------------------|
| 0 Discovery | §4, §5–6 (spec), §7–10 (spec), §20 | Excel template, data dictionary, DB model, calculation spec, acceptance targets |
| 1 Data foundation | §3, §5, §6 | Import/export, mapping, barcode validation, product master, alias table, exceptions, dated offers, upload audit log |
| 2 Trading engine | §7, §8, §9, §10, §11, §14, §16, §19 | Landed cost, FX, tiers, profitability, scenarios, own inventory & reservations, customer demand, quote exports, RBAC/audit |
| 3 Intelligence | §12, §13, §15 | Trend/price-supply charts, alerts, Plaud + reMarkable ingestion, note extraction, follow-up tasks |
| 4 Advanced | §17 Phase 4, §18 | Demand forecasts, purchasing optimisation, accounting/warehouse integrations, KPI suite |

---

## 3. Sprint schedule (2-week sprints)

| Sprint | Weeks | Focus | Phase | Key exit criterion |
|--------|-------|-------|-------|--------------------|
| S0 | 1–2 | Discovery kickoff, data dictionary, DB model, calc spec | 0 | Spec v0.1 reviewed |
| S1 | 3–4 | Acceptance targets, Excel template, sample-data cleanup begins | 0 | **M0: Spec signed off** |
| S2 | 5–6 | Upload, versioning, row refs, upload audit log (§3) | 1 | Re-import creates no duplicates |
| S3 | 7–8 | Column mapping UI, store barcodes as text, leading zeros | 1 | Leading zeros survive import |
| S4 | 9–10 | GTIN-14 canonicalisation, check digit, alias table | 1 | Valid UPC/EAN aliases match |
| S5 | 11–12 | Product master, unit-vs-case separation, comparison groups | 1 | Case barcode ≠ bottle |
| S6 | 13–14 | Exception queue, offer approval, dated snapshots | 1 | **M1: Data foundation done** |
| S7 | 15–16 | Landed cost + FX + Incoterm allocation (§7, §8) | 2 | §9 example reconciles |
| S8 | 17–18 | Net revenue, gross/contribution margin, markup | 2 | Margin formulas pass |
| S9 | 19–20 | MOQ/price tiers, scenario engine, stress cases | 2 | Conservative/base/upside |
| S10 | 21–22 | Own inventory, reservations, available-to-sell | 2 | Reservations cannot oversell |
| S11 | 22–23 | Customer demand records + quote export (cost masking) | 2 | Supplier cost never on quotes |
| S12 | 23–24 | Pilot hardening, UAT, §20 acceptance tests | 2 | **M2: Pilot go-live** |
| S13 | 25–26 | Trend data model, 7/30/90/180-day series | 3 | Date gaps shown, not invented |
| S14 | 27–28 | Trend dashboards + outlier/freshness flags | 3 | Matched-supplier series works |
| S15 | 29–30 | Alerts engine + thresholds by brand/SKU (§13) | 3 | Alerts carry evidence |
| S16 | 31–32 | Plaud ingestion technical pilot (§15) | 3 | Route selected & proven |
| S17 | 33–34 | reMarkable ingestion (OCR/PDF) + note extraction | 3 | Source excerpt attached |
| S18 | 35–36 | Reviewed note extraction, follow-up tasks | 3 | **M3: v1 go-live** |
| S19–28 | 37–56 | Forecasts, purchasing optimisation, accounting & warehouse integrations, KPI suite | 4 | Backtested forecasts; reconciliation passes |

**Calendar milestones**

- **M0 — Spec signed off:** week 4
- **M1 — Data foundation complete:** week 14
- **M2 — Working pilot (Phases 1–2):** week 24 (~4–6 months of calendar time)
- **M3 — Usable v1 (through Phase 3):** week 36 (~7–9 months)
- **M4 — Full brief (incl. Phase 4):** week 56 (~12–18 months, Phase 4 iterative)

---

## 4. Gantt (high level)

```
Week        1   4   8   12  16  20  24  28  32  36  40  48  56
Phase 0     ████
Phase 1         ████████████████████
Phase 2                         ██████████████████
Phase 3                                             ██████████████████
Phase 4                                                             ████████████████
M0          ▲
M1                      ▲
M2                                          ▲
M3                                                          ▲
M4                                                                              ▲
```

---

## 5. Staffing ramp

| Weeks | TL | DEV1 | DEV2 | DEV3 | UX | QA | DO | PO | PM |
|-------|----|------|------|------|----|----|----|----|----|
| 1–4 | 1 | 1 | 0.5 | – | 0.5 | 0.25 | 0.1 | 0.5 | 0.25 |
| 5–14 | 1 | 1 | 1 | – | 0.25 | 0.5 | 0.25 | 0.5 | 0.25 |
| 15–24 | 1 | 1 | 1 | 0.5 | 0.25 | 0.5 | 0.25 | 0.5 | 0.25 |
| 25–36 | 1 | 1 | 1 | 1 | 0.25 | 0.5 | 0.25 | 0.5 | 0.25 |
| 37–56 | 1 | 1 | 1 | 1 | 0.25 | 0.5 | 0.25 | 0.5 | 0.25 |

---

## 6. Effort summary

| Scope | Person-months | Engineering hours | Calendar |
|-------|---------------|-------------------|----------|
| Pilot (Phases 0–2) | 8–10 | 1,400–1,800 | 4–6 months |
| Usable v1 (through Phase 3) | 11–15 | 2,000–2,600 | 7–9 months |
| Full brief (incl. Phase 4) | 15–24 | 2,800–4,300 | 12–18 months |

---

## 7. Schedule risks (highest first)

1. **Plaud / reMarkable connectors (§15)** — brief explicitly says do not assume an API.
   If it degrades to manual upload + OCR, remove ~2 weeks; if reliable automation is required,
   add 3–6 weeks of uncertain work. Timebox S16 as a spike.
2. **Matching edge cases (§6, §20)** — case vs unit barcodes, testers/gift sets, duplicate
   broker lots, conflicting sizes. QA-heavy; where schedules slip.
3. **Calculation correctness (§7–§9)** — FX, Incoterms, recoverable taxes, partial receipts.
   Must reconcile to the §9 example or it fails acceptance.
4. **Domain approval loop (§3, §15, §16)** — iteration speed depends on the PO/staff, not devs.
5. **Forecasting (§12/Phase 4)** — needs months of real history; cannot be compressed.

**Buffers:** assume 15–20% schedule contingency per phase for data-quality rework and
approval-cycle latency.
