# Client decisions needed before the pilot run

Internal working document. Fill the **Answer** column before sending
`CLIENT-DATA-REQUEST-EMAIL.md` or starting an acceptance run. A blank answer
means "not yet agreed", not "use the default" — the default is only what the
system will do if the client does not decide, and an assumed value cannot be
signed off.

Items marked **BLOCKING** stop all ten acceptance criteria. Items marked
**CRITERION n** stop that specific criterion. Everything else can be gathered
in parallel.

| # | Decision | Owner | Why it matters | Default if not decided | Answer | Blocking |
|---|---|---|---|---|---|---|
| D1 | Named product owner (PO) with authority to approve matches, prices, quantities and buying rules | Client | SOW §5; required to sign every criterion and any waiver. Without a name there is no sign-off. | none — no default | | **BLOCKING** |
| D2 | PO email / recipient for the data request and evidence pack | Client | Needed to actually send `CLIENT-DATA-REQUEST-EMAIL.md` | none — no default | | **BLOCKING** |
| D3 | Company base currency | Client / PO | Drives every FX path, landed cost and GL per-currency balance. Validator and runtime default to USD. | `USD` | | **BLOCKING** |
| D4 | Destination market (country) and import duty / tax inputs | Client / PO | Criterion 7: landed cost cannot be computed without duty and destination | `US`, duty `0` | | **CRITERION 7** |
| D5 | Agreed FX source (e.g. ECB) and rate date convention | Client / PO | Criterion 7 requires a **dated** rate; a missing rate is now flagged as 1:1 assumed and must not be signed off | latest available rate, source `demo` | | **CRITERION 7** |
| D6 | Incoterm rules per supplier (or supplier default) | Client / PO | Determines which inbound costs are included; unknown incoterm is flagged `incoterm-unknown` | per supplier master; unknown flagged | | **CRITERION 7** |
| D7 | L'Oréal column meanings: is `NEW CP` the price paid, is `SP` selling price or retail reference, is `QTY` units or cases? | Client / PO | Open question 10 in the email. We currently read NEW CP = cost, SP = reference, QTY = units. A wrong mapping fabricates every price. | NEW CP cost / SP reference / QTY units | | **CRITERION 7** |
| D8 | GE Wholesale: is `Price (USD)` acquisition cost or retail? Is `Stock` units or cases? | Client / PO | Open question 11 in the email. Wrong mapping changes cost basis and stock totals. | cost / units | | **CRITERION 7** |
| D9 | Confirm the accounts extract and its currencies for GL reconciliation | Client finance | Criterion 9: each currency must balance separately; we need the real extract to compare line by line | none — no default | | **CRITERION 9** |
| D10 | Provide both internal and customer copies of one real offer | Client | Criterion 10: needed to prove no supplier cost leaks into the customer document | none — no default | | **CRITERION 10** |
| D11 | Two brokers offering the same physical lot (same owner + lot reference) | Client | Criterion 4: without a real overlapping offer we cannot prove single-pool counting | none — no default | | **CRITERION 4** |
| D12 | Exception-queue turnaround time (working days) | Client / PO | SOW §5; slow approval stalls criteria 1 and 2 | none — no default | | schedule only |
| D13 | Day-one users and roles (buyer / analyst / viewer / admin) | Client / PO | SOW §5 Appendix A; needed to create accounts before the run | seeded demo roles | | schedule only |
| D14 | Opening records: stock lots, open demands, historical quotes/orders | Client | Needed to populate criteria 7–9 with real data | none — no default | | **BLOCKING** for real-data run |
| D15 | ≥5 months of real delivered-order history | Client | Forecast stays honestly "insufficient history" without it. Forecast is out of pilot scope, so this is not an acceptance blocker. | withhold forecast | | no (out of scope) |
| D16 | Capture webhook: use Plaud/reMarkable text intake, and rotate `capture_secret` after setup? | Client / Ops | Out of pilot scope (SOW §3). If used, admin copies the generated secret from Admin → Settings. Secret is currently generated randomly and redacted for non-admins. | not enabled | | no (out of scope) |
| D17 | AI assistant: keep OpenRouter ZDR / no data retention enabled? | Client / Ops | Account-level setting at `https://openrouter.ai/settings/privacy`. Disabling ZDR unlocks free tool-capable models but sends prompts to providers that may retain them. | **ZDR on**, paid Luna chain | | no (decided: keep ZDR on) |
| D18 | Permanent CloudFront/S3 backup stack | Client / Ops | Currently daily local SQLite snapshots (14-day retention) only. Permanent off-site backup needs AWS IAM access keys and a client-owned account. | local snapshots only | | no (blocked on IAM keys) |

## Recording an answer

Add the answer and the date in the **Answer** column, then update
`CLIENT-DATA-REQUEST-EMAIL.md` if the answer changes what we ask for. Never
substitute synthetic or demo data for a missing answer — mark it
**unavailable** and raise it with the PO before the run.

## Critical path

D1 → D2 (so we can send the request), then D3 + D4 + D5 + D6 (so we can
configure and validate), then the real documents (D7–D11, D14). D15, D16,
D17 and D18 can proceed in parallel and are not pilot acceptance blockers.
