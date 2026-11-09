# Plaud / Zapier live intake — setup (brief §15)

> The brief's instruction: *"Evaluate its documented Zapier, MCP or CLI options in a
> technical pilot against the actual company account; choose the supported route that
> meets access and reliability needs. Do not assume an unrestricted public API."*
> This file records the pilot steps. The platform already ingests either way —
> Zapier button below, or transcript-file import in Capture Inbox.

## Option A — Plaud export files (supported today, no API needed)
1. In the Plaud app, export the recording **transcript + summary**.
2. Name it `CUSTOMERCODE-YYYYMMDD-STAFF` (e.g. `CUST42-20261010-AL`).
3. Capture Inbox → **Import Plaud file** → pick the file. The meeting
   convention is validated; an unconfirmed customer is flagged, never
   silently attached. Staff approval is still required before promotion.

## Option B — Zapier (pilot on the company account)
1. Create a Zap: trigger = Plaud recording/transcript available (or
   "new file in Plaud export folder").
2. Action = **Webhook by Zapier** POST to:
   `https://YOUR-HOST/api/captures/webhook`
   Header: `x-capture-secret: <Settings capture_secret>`
   Body (JSON): `{ "source": "plaud", "title": "<CUSTOMER-YYYYMMDD-STAFF>", "text": "<transcript>" }`
3. Send one test recording, confirm it lands in Capture Inbox as `source=webhook`,
   then promote it to a demand.

## Option C — reMarkable
Export text/PDF from the reMarkable cloud (Google Drive / Dropbox / OneDrive),
then either drop into the same webhook or import via Capture Inbox
(same as Plaud files).

## Rules in force either way
- Original transcript always preserved (`captures.raw_text`).
- An unclear SKU/EAN/currency stays unresolved — never invented (brief §15).
- Recurring mentions merge into the same open requirement (demand versions).
- Quote exports never reveal supplier names or buying costs.
