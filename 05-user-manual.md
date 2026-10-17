# Perfumes — User Manual

This is the day-to-day guide to the **Perfumes** wholesale trading platform.
It walks through every screen with the buttons you press, in order. Screenshots
show the seeded demo data, so what you see will look the same minus your own
records.

- **Audience:** buying staff, traders and administrators.
- **Live URL:** the address your administrator gave you (Railway/Render domain,
  e.g. `https://perfumes.up.railway.app`).
- **Hosting, backups and security** are covered in
  [`04-hosting-hardening.md`](04-hosting-hardening.md); this manual is about
  using the app.
- Pictures live in [`docs/manual/img/`](docs/manual/img).

> Replace the sample numbers in the screenshots with your own — the layout and
> buttons are identical.

## Contents

1. [Signing in and roles](#1-signing-in-and-roles)
2. [The layout](#2-the-layout)
3. [Importing supplier price lists](#3-importing-supplier-price-lists)
4. [Reviewing supplier offers](#4-reviewing-supplier-offers)
5. [Products & matching](#5-products--matching)
6. [Exceptions](#6-exceptions)
7. [Finding the cheapest source](#7-finding-the-cheapest-source)
8. [Comparing prices for one product](#8-comparing-prices-for-one-product)
9. [Deal calculator](#9-deal-calculator)
10. [Offer builder — cost → selling price](#10-offer-builder--cost--selling-price)
11. [Comparing two uploaded lists](#11-comparing-two-uploaded-lists)
12. [Inventory, customers and the demand book](#12-inventory-customers-and-the-demand-book)
13. [Deals & quotes](#13-deals--quotes)
14. [Comparing two quotes (% difference)](#14-comparing-two-quotes-difference)
15. [Orders & payments](#15-orders--payments)
16. [Order placement (send to a supplier)](#16-order-placement-send-to-a-supplier)
17. [Order vs supplier PFI (variance check)](#17-order-vs-supplier-pfi-variance-check)
18. [Shipment costs](#18-shipment-costs)
19. [Buying recommendations](#19-buying-recommendations)
20. [Intelligence: captures, alerts, trends, forecast, performance, reports](#20-intelligence-captures-alerts-trends-forecast-performance-reports)
21. [Admin: suppliers, settings, users, audit](#21-admin-suppliers-settings-users-audit)
22. [Roles at a glance](#22-roles-at-a-glance)
23. [Where each client request lives](#23-where-each-client-request-lives)
24. [Troubleshooting](#24-troubleshooting)

---

## 1. Signing in and roles

Go to the app URL. You get the sign-in card:

![Sign in](docs/manual/img/01-login.png)

1. Type your **Username** and **Password**.
2. Click **Sign in** (or press Enter).

Demo accounts shipped with the sample data:

| Username | Password | Role | Can do |
|---|---|---|---|
| `admin` | `admin123` | Administrator | Everything, including settings, users and suppliers |
| `buyer` | `buyer123` | Buyer | Imports, offers, deals, quotes, orders, placements, approvals |
| `analyst` | `analyst123` | Analyst | Imports, captures, PFI uploads, exception & shipment work |
| `viewer` | `viewer123` | Viewer | Read-only lookups and reports |

Change a password any time with **Password** in the top bar (see §2), or an
admin can reset any user from **Users & Roles**.

> **First thing to do:** change the `admin` password (top bar → **Password**).

## 2. The layout

![Dashboard](docs/manual/img/02-dashboard.png)

- **Sidebar (left):** every screen, grouped into **Catalogue**, **Trading**,
  **Intelligence** and **Admin**. You only see the pages your role can open.
- **Top bar:** the base currency, a **Refresh** button (reloads the current
  screen), your name and role, **Password** (change your own), and **Sign out**.
- **Dashboard** is the landing page: headline counts, cross-supplier
  opportunities (where one supplier is cheaper than another for the same
  barcode), items to review, and exception breakdown.

---

## 3. Importing supplier price lists

![Import Lists](docs/manual/img/03-imports.png)

**Import a list (buyer role):**

1. In the left menu choose **Import Lists**.
2. **Supplier** — pick the vendor (e.g. `ALCODIS`, `IGAN`).
3. **File** — choose the `.xls`/`.xlsx` downloaded from the supplier. (Or type a
   server-side path if you copied the file onto the server.)
4. **List date** — the date the list was published.
5. Press **Import**.
6. The upload appears in the list below with its row count and data-quality
   score. Re-importing the *same* file is ignored automatically (SHA-256
   fingerprint), so you can't create duplicates by mistake.

Every import is also rewritten onto the standard template
(`supplier-template.xlsx`) and can be downloaded from the upload row as
**Template**.

---

## 4. Reviewing supplier offers

![Supplier Offers](docs/manual/img/04-offers.png)

This is every imported offer with how its price was normalised (per bottle vs
per case, list vs net, EUR/USD).

**Filter and act:**

1. Open **Supplier Offers**.
2. Use the filters/brand search, then **Apply**.
3. Approve or reject offers with the row buttons **Approve** / **Reject**
   (buyer role). Approval is recorded with who and when.
4. An offer with no price or no valid barcode can never be approved.

If your administrator turns on *require offer approval*, only approved offers
can win a sourcing comparison or drive a buying recommendation.

---

## 5. Products & matching

![Products & Matching](docs/manual/img/05-products.png)

The **product master** is resolved by barcode (GTIN), so the same bottle from
two suppliers is one product.

1. Open **Products & Matching**.
2. Type a brand / name / barcode and press **Search**.
3. Each row shows how many suppliers carry it.

**Compare two products:**

![Product comparison](docs/manual/img/05b-products-compare.png)

1. Tick two products.
2. Press **Compare** — supplier offers, pack sizes and unit costs side by side.

---

## 6. Exceptions

![Exceptions](docs/manual/img/06-exceptions.png)

Rows the importer couldn't resolve (missing/duplicate barcode, bad price, size
clash) land here for a human.

1. Open **Exceptions**.
2. Read the reason, then **Resolve** once you have decided what to do.

---

## 7. Finding the cheapest source

![Lowest Landed Cost](docs/manual/img/07-lowest.png)

**Cheapest executable supplier for an exact SKU and quantity.**

1. Open **Lowest Landed Cost**.
2. Pick the product and enter the quantity you want to buy.
3. Press **Find lowest**.
4. The winner is ranked by *landed cost* (cost + freight + duty, etc.), with
   MOQ, stock, expiry and eligibility checks. Anything missing is flagged rather
   than guessed.

---

## 8. Comparing prices for one product

![Price Comparison](docs/manual/img/08-compare.png)

1. Open **Price Comparison**.
2. Choose the product.
3. Press **Find cheapest** to normalise and rank every offer for that barcode,
   with a clear note where offers aren't directly comparable.

---

## 9. Deal calculator

![Deal Calculator](docs/manual/img/09-pricing.png)

Price a deal end to end: landed cost, margin, markup and ROI.

1. Open **Deal Calculator**.
2. Enter cost, quantity and costs (outbound delivery, commission, fees,
   storage, financing, expected credit loss).
3. Press **Calculate**.
4. Press **Save deal** to keep it in **Deals & Quotes**.

The deal is checked against your configured margin/markup policy, and the
contribution figure subtracts the deal costs and reports return on the capital
deployed.

---

## 10. Offer builder — cost → selling price

![Offer Builder](docs/manual/img/10-builder.png)

Turn a supplier **cost price** into a **selling price** at a target margin. Both
margin conventions are shown side by side so there is no ambiguity:

- **Markup on cost:** `SP = cost × (1 + m)`
- **Margin on selling:** `SP = cost ÷ (1 − m)`

**How to use:**

1. Open **Offer Builder**.
2. Pick the product (or enter a cost directly).
3. Enter the cost price and the target margin %.
4. Choose the basis (markup on cost / margin on selling) — the other is shown for
   comparison.
5. Press **Calculate selling price**.
6. Supplier candidates are ranked so you can pick the best-cost source, then
   **Save deal** to store it.

---

## 11. Comparing two uploaded lists

![Compare Lists](docs/manual/img/11-lists.png)

See what changed between two supplier price lists **by barcode or description**.

1. Open **Compare Lists**.
2. Choose **List A** and **List B** (two uploaded files).
3. Press **Compare**.
4. The table shows added, removed and changed rows with the old and new price and
   the % move.

---

## 12. Inventory, customers and the demand book

### Inventory

![Inventory](docs/manual/img/12-inventory.png)

Lots you hold, reservations and in-transit stock.

- **Add lot** records a physical lot you own.
- **Reserve** ties stock in a lot to a demand or order so two traders cannot sell
  the same bottle. Active reservations can never exceed usable stock.
- **Release** cancels a reservation.

![Add a lot](docs/manual/img/12b-inventory-addlot.png)

### Customers

![Customers](docs/manual/img/13-customers.png)

Buyers and their commercial terms. Press **Add** to create one.

![Add a customer](docs/manual/img/13b-customers-add.png)

### Demand book

![Demand Book](docs/manual/img/14-demands.png)

Customer requests to match against supply.

1. **Add demand** to record a request (customer, product, quantity, target).
2. **Revise** supersedes a demand with a new version — the old one is kept and
   linked, so you can always see what was believed and when.
3. **History** shows the version chain. Once a demand is on an order it is
   **locked** and cannot be rewritten.

![Add a demand](docs/manual/img/14b-demands-add.png)

---

## 13. Deals & quotes

![Deals & Quotes](docs/manual/img/15-quotes.png)

Every saved deal/quote with its contribution, ROI and capital required.

1. Open **Deals & Quotes**.
2. To add one, fill **Create quote** (customer, product, quantity, unit price,
   landed unit cost, validity) and press **Create quote**.

![Create a quote](docs/manual/img/15c-quotes-create.png)

Each row has a **Quote** link that downloads the customer-facing Excel — supplier
cost is never included.

---

## 14. Comparing two quotes (% difference)

![Quote comparison](docs/manual/img/15b-quotes-compare.png)

Compare **two saved quotes** and see the percentage difference on every field.

1. Open **Deals & Quotes**.
2. Under **Compare two quotes (% difference)**, pick **Quote A (base)** and
   **Quote B**.
3. Press **Compare %**.
4. A window lists each field with A, B, the change and the **Δ %**. Fields where
   A is zero show `-` (percentage from zero is undefined, and is shown honestly
   rather than as a huge number).

---

## 15. Orders & payments

![Orders & Payments](docs/manual/img/16-orders.png)

Purchase and sales orders, payments in/out, and *forecast vs realised* margin.

1. Press **Create order** to raise one.
2. **Record payment** books money in/out against the order.
3. Where dates support it, a settled order also shows a money-weighted **XIRR**
   and the days capital was funded; where they don't, it says *why* instead of a
   misleading number.

![Create an order](docs/manual/img/16b-orders-create.png)

---

## 16. Order placement (supplier order)

![Order Placement](docs/manual/img/17-placements.png)

Build a supplier order with **cost price** and **full-box quantities**, ready to
send.

1. Open **Order Placement**.
2. Pick the **Supplier** and currency.
3. **Load from purchase plan** to auto-fill what that supplier should be
   ordered, **or** search a product, pick the offer, and press **Add line**.
4. Set the number of **full boxes** and the **unit cost** per line — totals update
   live. Quantities round to whole boxes (suppliers don't ship part boxes).
5. Press **Save placement**.
6. Each saved row can be **Export**ed to Excel and, once you have the supplier's
   proforma, reconciled with **PFI** (next section).

---

## 17. Order vs PFI variance

![PFI reconciliation](docs/manual/img/17b-pfi.png)

Compare the supplier's **proforma invoice (PFI)** against what you ordered.

1. Open **Order Placement** and find the saved placement.
2. Press **PFI** on its row.
3. Choose the **PFI file (Excel)** the supplier sent and press **Compare**.
4. You get order total, PFI total, the **variance**, and line-by-line
   **quantity** and **price** differences, plus anything **extra on the PFI** or
   **missing from it**.
5. Optionally attach the supplier's **PDF** proforma to the same record for the
   audit trail. Past comparisons are listed under **Recorded comparisons**.

> The Excel PFI is the primary source of truth; the PDF is just attached as
> evidence.

---

## 18. Shipment costs

![Shipment Costs](docs/manual/img/18-shipments.png)

Spread freight, duty and handling across the lines they belong to.

1. Open **Shipment Costs**.
2. Press **Create shipment**.
3. Add the cost lines and allocate them to the order/placement lines.

![Create a shipment](docs/manual/img/18b-shipments-create.png)

---

## 19. Buying

![Buying](docs/manual/img/19-buying.png)

Match live demand to the cheapest **executable** supplier.

1. Open **Buying**.
2. Each demand shows the recommended supplier, rounded to MOQ/order multiples and
   priced against the customer target or a policy floor.
3. **Why** explains the recommendation; anything breaching margin policy or the
   capital limit is flagged.
4. **Quote** creates a customer quote straight from the recommendation.

---

## 20. Intelligence

### Capture inbox (Plaud / reMarkable notes)

![Capture Inbox](docs/manual/img/20-captures.png)

1. Open **Capture Inbox**.
2. Press **Capture** to log a note, or ingest from your recorder.
3. Turn a note into work with **Promote to demand**, park it with **Ignore**, or
   **Delete** it.

![Log a capture](docs/manual/img/20b-captures-add.png)

### Alerts

![Alerts](docs/manual/img/21-alerts.png)

Price movements, expiring offers and low stock. Press **Mark read** per row or
**Mark all read**.

### Price trends

![Price Trends](docs/manual/img/22-trends.png)

Observed supplier price history with 7/30/90/180-day movement. Real date gaps are
shown, never invented points. **Refresh alerts** re-checks thresholds.

### Demand forecast

![Demand Forecast](docs/manual/img/23-forecast.png)

A moving-average baseline that is honest about thin history.

### Performance

![Performance](docs/manual/img/24-performance.png)

Profitability, cash, capital and stock KPIs.

### Reports & exports

![Reports & Exports](docs/manual/img/25-reports.png)

Supplier performance and one-click Excel exports.

---

## 21. Admin

Only the **admin** role sees this group.

### Suppliers & terms

![Suppliers & Terms](docs/manual/img/26-suppliers.png)

Price type (list/net), default trade discount and Incoterms per supplier. Edit
and press **Save**.

### Settings & FX

![Settings & FX](docs/manual/img/27-settings.png)

Policy thresholds (margin/markup, capital limits, alert thresholds) and currency
rates. **Save settings**, or **Add rate** to add an FX rate.

### Users & roles

![Users & Roles](docs/manual/img/28-users.png)

Create accounts with **Create user**, change roles, and **Reset pw** to issue a
new password.

![Create a user](docs/manual/img/27b-users-create.png)

### Audit log

![Audit Log](docs/manual/img/29-audit.png)

Who did what, and when — every stock, price, demand and approval change.

---

## 22. Roles at a glance

| Role | Rank | Can do |
|------|------|--------|
| **viewer** | 1 | View dashboards, offers, products, prices, reports |
| **analyst** | 2 | Everything a viewer can, plus imports cleanup, captures, PFI uploads, resolve exceptions, record shipments |
| **buyer** | 3 | Everything an analyst can, plus create offers/deals/quotes/orders/placements/customers/inventory, approve offers, import lists |
| **admin** | 4 | Everything, plus settings, users, suppliers and admin actions |

Navigation items are hidden automatically when your role is too low, and the
server enforces the same rules, so you cannot change data you are not allowed to.

---

## 23. The client requirements, and where to find them

| Requirement | Screen |
|---|---|
| Cost price → selling price (CP & SP) with both margin conventions | **Offer Builder** (§10) |
| Order placement with cost price and full-box quantities, exportable | **Order Placement** (§16) |
| Order vs supplier PFI variance (Excel primary, PDF attached) | **Order Placement → PFI** (§17) |
| Percentage difference between two uploaded lists | **Compare Lists** (§11) |
| Percentage difference between two saved quotes | **Deals & Quotes → Compare %** (§14) |
| Product profitability | **Offer Builder** supplier ranking / **Performance** (§10, §20) |
| Hosting & security hardening | [`04-hosting-hardening.md`](04-hosting-hardening.md) |

---

## 24. Troubleshooting

- **"Please sign in" / bounced to the login screen** — your session expired.
  Sign in again.
- **A menu item is missing** — your role does not include it (see §22).
- **A supplier file won't import** — check it is `.xls`/`.xlsx` and that the
  supplier is selected; rows that can't be read land in **Exceptions**.
- **A placement won't save** — you need the **buyer** role.
- **PFI comparison says no header found** — the file needs barcode, price and
  quantity columns (an export from the platform works perfectly).
- **Changes disappeared after a restart** — the deployment is missing its
  persistent volume; see [`04-hosting-hardening.md`](04-hosting-hardening.md) §3.
