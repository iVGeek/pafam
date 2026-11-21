# Plaud / Zapier live intake — setup (brief §15)

> The brief's instruction: *"Evaluate its documented Zapier, MCP or CLI options in a
> technical pilot against the actual company account; choose the supported route that
> meets access and reliability needs. Do not assume an unrestricted public API."*
> This file records the pilot steps. The platform already ingests either way —
> Zapier button below, or transcript-file import in Capture Inbox.

## Option A — Plaud export files (supported today, no API needed)
1. In the Plaud app, export the recording **transcript + summary**.
2. Name it `CUSTOMERCODE-YYYYMMDD-STAFF` (e.g. `CUST42-20261010-AL`).
3. Capture Inbox → **Import transcript file** → pick the file (.txt, .md, .srt,
   .vtt or .json). The meeting convention is validated; an unconfirmed customer
   is flagged, never silently attached. Staff approval is still required before
   promotion. PDFs are rejected — export the transcript as text.

## Option B — Zapier (pilot on the company account)
1. Create a Zap: trigger = Plaud recording/transcript available (or
   "new file in Plaud export folder").
2. Action = **Webhook by Zapier** POST to:
   `https://YOUR-HOST/api/captures/webhook`
   Header: `x-capture-secret: <Admin → Settings → capture_secret>` (admin only;
   generated randomly on first boot and redacted for other roles)
   Body (JSON): `{ "source": "plaud", "title": "<CUSTOMER-YYYYMMDD-STAFF>", "text": "<transcript>" }`
3. Send one test recording, confirm it lands in Capture Inbox as `source=webhook`,
   then promote it to a demand.

## Option C — reMarkable (manual text path only)
reMarkable has no push API here and the platform has **no OCR pipeline**. The
Capture Inbox and `/api/captures/webhook` accept **plain text only**: exported
PDFs, page images and handwriting photos are rejected with an error, not
silently stored. Convert the handwriting to text first:
1. In the reMarkable app open the notebook and use **Convert to text**, or
   select the handwritten lines and **Copy**.
2. Paste it into Capture Inbox → **Add a note** (source `remarkable`), or save
   the text as `CUSTOMER-YYYYMMDD-STAFF.txt` and use **Import transcript file**.
3. If conversion quality is poor, type the few lines that matter (customer,
   product, quantity, price) and keep the original PDF in your own drive.

Why not automatic: OCR (PDF → text) is its own pipeline with separate accuracy,
cost and privacy review, and is not part of the pilot
(`02-pilot-sow.md` §out-of-scope). A PDF dropped into the webhook is refused.

## Rules in force either way
- Original transcript always preserved (`captures.raw_text`).
- Intake is text-only: no PDF/OCR, no image or audio attachments.
- An unclear SKU/EAN/currency stays unresolved — never invented (brief §15).
- Recurring mentions merge into the same open requirement (demand versions).
- Quote exports never reveal supplier names or buying costs.
