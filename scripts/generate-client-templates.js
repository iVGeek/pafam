'use strict';

// Generates the client data template pack (client-templates/*.xlsx).
// Run: npm run gen:templates

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const OUT = path.join(__dirname, '..', 'client-templates');

function build(sheets) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.rows);
    if (s.widths) ws['!cols'] = s.widths.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  return wb;
}

function save(file, sheets) {
  const wb = build(sheets);
  XLSX.writeFile(wb, path.join(OUT, file));
  console.log('wrote', file);
}

function guide(rows) {
  return { name: 'Guide', rows, widths: [26, 12, 16, 62, 34] };
}

function readme(title, lines) {
  return { name: 'ReadMe', rows: [[title], [''], ...lines.map((l) => [l])], widths: [110] };
}

fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- 00 index
save('00-readme-index.xlsx', [{
  name: 'Index',
  rows: [
    ['Client data template pack — fill each file and return all together'],
    [''],
    ['File', 'What it is', 'Who fills', 'Return as', 'Priority'],
    ['01-supplier-master.xlsx', 'One row per supplier: terms, landed-cost inputs, base currency, price-list format', 'Client', 'xlsx', 'BLOCKER'],
    ['02-customer-master.xlsx', 'One row per customer: terms, credit, base currency', 'Client', 'xlsx', 'HIGH'],
    ['03-raw-price-list-log.xlsx', 'Log of every raw supplier price list you send us (file, currency, cost/RRP, discount, case pack)', 'Client', 'xlsx', 'BLOCKER'],
    ['04-prepared-price-list.xlsx', 'Your prepared price list — the one you currently send to customers (one per supplier or shared format)', 'Client', 'xlsx', 'BLOCKER'],
    ['05-offer-company-copy.xlsx', 'Example of your INTERNAL offer document (with cost & margin)', 'Client', 'xlsx', 'HIGH'],
    ['06-offer-customer-copy.xlsx', 'Example of the offer you actually SEND to the customer (cost & margin removed)', 'Client', 'xlsx', 'HIGH'],
    ['07-document-naming.xlsx', 'Agreed naming format for every supplier- and customer-facing document', 'Both', 'xlsx', 'HIGH'],
    ['08-process-capture-checklist.xlsx', 'Processes to capture with screenshots or screen video (supplier quote to customer quote)', 'Client', 'xlsx + media', 'HIGH'],
    ['09-vlookup-formulas.xlsx', 'Every VLOOKUP/XLOOKUP/INDEX formula currently used in your workbooks, as text', 'Client', 'xlsx', 'HIGH'],
    [''],
    ['IMPORTANT'],
    ['Raw supplier price lists (03) are sent AS RECEIVED — do not rename or edit them. The log describes them.'],
    ['In every file keep the header row exactly as-is and add example rows below it if the Guide shows any.'],
    ['Dates: YYYY-MM-DD. Money: plain numbers (no currency symbols inside cells). Codes/currency/barcode cells: text.'],
  ],
  widths: [34, 74, 12, 16, 12],
}]);

// ------------------------------------------------------- 01 supplier master
save('01-supplier-master.xlsx', [
  {
    name: 'Suppliers',
    rows: [
      ['code', 'name', 'baseCurrency', 'priceType', 'tradeDiscountPct', 'incoterm', 'incotermPlace', 'paymentTerms', 'dutyPct', 'freightPerUnit', 'insurancePct', 'brokeragePerUnit', 'handlingPerUnit', 'otherTaxPct', 'recoverableTaxPct', 'stockCountry', 'originCountry', 'priceListFormat', 'contactName', 'contactEmail', 'contactPhone', 'active', 'notes'],
      ['ALCODIS', 'Alcodis Trading SL', 'EUR', 'cost', 0, 'EXW', 'Barcelona', '30 days from invoice', 0, 0.35, 0.5, 0.1, 0.05, 0, 0, 'ES', 'FR', 'ALCODIS', 'Ana Ruiz', 'sales@alcodis.example', '+34 900 000 000', 1, 'EXAMPLE ROW — replace'],
      ['IGAN', 'Igan Distribucion SA', 'EUR', 'rrp', 40, 'EXW', 'Lleida', '50% advance, 50% on delivery', 0, 0.25, 0.5, 0.1, 0.05, 0, 0, 'ES', 'ES', 'IGAN', 'Marc Soler', 'pedidos@igan.example', '+34 900 000 001', 1, 'EXAMPLE ROW — replace'],
    ],
    widths: [12, 26, 13, 10, 17, 10, 14, 26, 9, 15, 13, 18, 16, 12, 18, 13, 14, 16, 16, 28, 18, 8, 22],
  },
  guide([
    ['Field', 'Required', 'Type', 'Meaning', 'Example'],
    ['code', 'YES', 'TEXT', 'Unique supplier code. ALCODIS and IGAN already exist in the platform — keep those codes exactly.', 'ALCODIS'],
    ['name', 'YES', 'TEXT', 'Legal / trading name of the supplier.', 'Alcodis Trading SL'],
    ['baseCurrency', 'YES', 'ISO 4217', 'Base currency of this supplier: the currency its price lists, invoices and settlement use. Determines which FX rates we need.', 'EUR'],
    ['priceType', 'YES', 'cost | rrp', 'Whether the supplier price list is a COST price or a RETAIL (RRP/PVP) price.', 'rrp'],
    ['tradeDiscountPct', 'If priceType=rrp', 'number %', 'Your trade discount off the supplier RRP (this is how cost is derived from an RRP list).', '40'],
    ['incoterm', 'Recommended', 'EXW|FOB|CIF|DAP|DDP|FCA|CPT', 'Delivery term the supplier quotes.', 'EXW'],
    ['incotermPlace', 'If incoterm set', 'TEXT', 'Named place of the Incoterm.', 'Lleida'],
    ['paymentTerms', 'Recommended', 'TEXT', 'How and when you pay the supplier.', '30 days from invoice'],
    ['dutyPct', 'YES (costing)', 'number %', 'Import duty rate for this supplier — 0 only if genuinely duty-free.', '0'],
    ['freightPerUnit', 'YES (costing)', 'money', 'Freight cost per bottle from this supplier.', '0.35'],
    ['insurancePct', 'YES (costing)', 'number %', 'Insurance rate applied to cost.', '0.5'],
    ['brokeragePerUnit', 'YES (costing)', 'money', 'Customs brokerage per bottle.', '0.10'],
    ['handlingPerUnit', 'YES (costing)', 'money', 'Handling / warehouse handling per bottle.', '0.05'],
    ['otherTaxPct', 'If applicable', 'number %', 'Any other tax on this supply line.', '0'],
    ['recoverableTaxPct', 'If applicable', 'number %', 'Recoverable portion of tax (e.g. VAT reclaimable).', '18'],
    ['stockCountry', 'Recommended', 'ISO country', 'Where the supplier stocks goods.', 'ES'],
    ['originCountry', 'Optional', 'ISO country', 'Country of manufacture / origin of goods.', 'FR'],
    ['priceListFormat', 'YES (us)', 'ALCODIS | IGAN | OTHER', 'Which layout the supplier price files use. OTHER = we must build a new profile from samples (send with 03).', 'ALCODIS'],
    ['contactName / contactEmail / contactPhone', 'Optional', 'TEXT', 'Commercial contact.', ''],
    ['active', 'Optional', '1 | 0', '1 = trading, 0 = inactive (default 1).', '1'],
    ['notes', 'Optional', 'TEXT', 'Anything we should know.', ''],
  ]),
  readme('How to fill 01-supplier-master.xlsx', [
    '1. One row per supplier you will use in the first year — even suppliers whose price files come later.',
    '2. Base currency is the single most important column: every price, quote and margin for that supplier converts through it.',
    '3. priceListFormat tells us whether we can import their files automatically today (ALCODIS / IGAN) or need samples to build a profile (OTHER).',
    '4. Landed-cost columns (duty/freight/insurance/brokerage/handling) may be overridden per supplier by real invoices later; give your current best numbers.',
    '5. The two EXAMPLE rows show the format — replace them with your real suppliers.',
  ]),
]);

// ------------------------------------------------------- 02 customer master
save('02-customer-master.xlsx', [
  {
    name: 'Customers',
    rows: [
      ['code', 'name', 'baseCurrency', 'region', 'paymentTerms', 'creditLimit', 'contactName', 'contactEmail', 'contactPhone', 'address', 'taxId', 'sanctioned', 'active', 'notes'],
      ['CUST-001', 'Acme Distribution LLC', 'USD', 'US', 'Net 45', 50000, 'John Doe', 'buying@acme.example', '+1 555 000 0000', '123 Main St, Miami FL', 'US-123456789', 0, 1, 'EXAMPLE ROW — replace'],
      ['CUST-002', 'Parfumerie Dubois', 'EUR', 'EU', 'Net 30', 25000, 'Claire Dubois', 'contact@dubois.example', '+33 1 00 00 00 00', '10 Rue de la Paix, Paris', 'FR-987654321', 0, 1, 'EXAMPLE ROW — replace'],
    ],
    widths: [12, 26, 13, 10, 16, 12, 16, 28, 18, 34, 16, 12, 8, 22],
  },
  guide([
    ['Field', 'Required', 'Type', 'Meaning', 'Example'],
    ['code', 'Recommended', 'TEXT, unique', 'Your customer code. Used in file naming (see 07) and document references.', 'CUST-001'],
    ['name', 'YES', 'TEXT', 'Customer legal / trading name. Must match exactly wherever it appears in other files.', 'Acme Distribution LLC'],
    ['baseCurrency', 'YES', 'ISO 4217', 'Base currency of this customer: the currency you quote, invoice and settle in with them.', 'USD'],
    ['region', 'Recommended', 'TEXT', 'Market / region — drives regional reporting.', 'US'],
    ['paymentTerms', 'Recommended', 'TEXT', 'Agreed terms with this customer.', 'Net 45'],
    ['creditLimit', 'Optional', 'money', 'Credit limit in the customer base currency — feeds the credit KPI.', '50000'],
    ['contactName / contactEmail / contactPhone', 'Optional', 'TEXT', 'Buyer contact.', ''],
    ['address / taxId', 'Optional', 'TEXT', 'Invoice details.', ''],
    ['sanctioned', 'Optional', '1 | 0', '1 = blocked for trade (sanctions/compliance). Default 0.', '0'],
    ['active', 'Optional', '1 | 0', '1 = trading (default).', '1'],
    ['notes', 'Optional', 'TEXT', 'Anything we should know.', ''],
  ]),
  readme('How to fill 02-customer-master.xlsx', [
    '1. One row per customer you trade with or will quote in the first year.',
    '2. baseCurrency (required) pairs with your FX rate list: we need a rate from each customer base currency to your own base currency.',
    '3. Keep code stable — it is used as the document naming key in 07-document-naming.xlsx.',
    '4. The two EXAMPLE rows show the format — replace them.',
  ]),
]);

// ------------------------------------------------ 03 raw price list log
save('03-raw-price-list-log.xlsx', [
  {
    name: 'RawPriceListLog',
    rows: [
      ['supplierCode', 'originalFileName', 'receivedDate', 'listValidFrom', 'listValidTo', 'fileCurrency', 'priceBasis', 'tradeDiscountPctIfRrp', 'defaultUnitsPerCase', 'hasBarcodeColumn', 'barcodeColumnHeader', 'headerRowNumber', 'notes'],
      ['ALCODIS', 'LISTA OCTUBRE ALCODIS(v.2).xls', '2026-10-01', '2026-10-01', '2026-10-31', 'EUR', 'cost', 0, 6, 'YES', 'EAN (Bt', 7, 'EXAMPLE ROW — replace'],
      ['IGAN', 'igan_tarifa_2026_09.xlsx', '2026-09-28', '2026-09-28', '2026-10-28', 'EUR', 'rrp', 40, 12, 'YES', 'CodigoEAN', 29, 'EXAMPLE ROW — replace'],
    ],
    widths: [14, 40, 14, 13, 13, 14, 12, 22, 20, 17, 22, 16, 30],
  },
  guide([
    ['Field', 'Required', 'Type', 'Meaning', 'Example'],
    ['supplierCode', 'YES', 'TEXT', 'Must match a code in 01-supplier-master.xlsx.', 'ALCODIS'],
    ['originalFileName', 'YES', 'TEXT', 'The file EXACTLY as the supplier sent it — you do not rename or edit the file itself.', 'LISTA OCTUBRE ALCODIS(v.2).xls'],
    ['receivedDate', 'YES', 'YYYY-MM-DD', 'Date you received it.', '2026-10-01'],
    ['listValidFrom / listValidTo', 'Recommended', 'YYYY-MM-DD', 'Validity period printed on the list (if any).', '2026-10-01 / 2026-10-31'],
    ['fileCurrency', 'YES', 'ISO 4217', 'Currency of the prices inside the file (our two known layouts assume EUR — correct us if wrong).', 'EUR'],
    ['priceBasis', 'YES', 'cost | rrp', 'Are the prices what you PAY (cost) or RETAIL (rrp/PVP)?', 'cost'],
    ['tradeDiscountPctIfRrp', 'If priceBasis=rrp', 'number %', 'Your trade discount off the RRP list.', '40'],
    ['defaultUnitsPerCase', 'If file prices cases', 'integer', 'Bottles per case when the price is per case and the file does not say per line.', '6'],
    ['hasBarcodeColumn', 'YES', 'YES | NO', 'Whether the file has an EAN/UPC column. NO = flag us before sending.', 'YES'],
    ['barcodeColumnHeader', 'If hasBarcodeColumn', 'TEXT', 'Exact header of the barcode column (copy-paste from the file).', 'CodigoEAN'],
    ['headerRowNumber', 'Recommended', 'integer', 'Row number where the real header sits (counting from the very first row of the sheet).', '29'],
    ['notes', 'Optional', 'TEXT', 'Anything unusual (merged title rows, multi-sheet, price in second sheet...).', ''],
  ]),
  readme('How to send raw supplier price lists', [
    '1. Do NOT rename, reformat, translate or clean raw supplier files — the importer recognises their native layout from the header row.',
    '2. For EVERY raw file: add one row here describing it, then send file + log together.',
    '3. Send history if you have it (6-12 months of lists): price trends, price-change alerts and supplier performance are built from it.',
    '4. Re-sending an identical file later is safe (deduplicated) — nothing imports twice.',
    '5. Barcodes: valid GS1 check digits are what create products. Blank/invalid barcodes become review items and never become products.',
  ]),
]);

// --------------------------------------------- 04 prepared price list
save('04-prepared-price-list.xlsx', [
  {
    name: 'PreparedPriceList',
    rows: [
      ['ean', 'brand', 'product', 'concentration', 'sizeMl', 'gender', 'casePack', 'supplierCode', 'supplierListDate', 'costPerUnit', 'costCurrency', 'fxRateToSell', 'landedCost', 'sellPrice', 'sellCurrency', 'markupPct', 'rrp', 'availability', 'validUntil', 'incoterm', 'leadTimeDays', 'notes'],
      ['3348901392025', 'Dior', 'Sauvage EDP 100ml', 'EDP', 100, 'Men', 6, 'ALCODIS', '2026-10-01', 61.5, 'EUR', 1.08, 63.9, 82.5, 'USD', 29, 105, 'In stock', '2026-10-31', 'EXW', 7, 'EXAMPLE ROW — replace'],
      ['3348901387032', 'Dior', 'Sauvage EDT 60ml', 'EDT', 60, 'Men', 12, 'IGAN', '2026-09-28', 38.1, 'EUR', 1.08, 39.6, 54.9, 'USD', 38, 78, 'Low stock', '2026-10-28', 'EXW', 7, 'EXAMPLE ROW — replace'],
    ],
    widths: [16, 12, 26, 15, 9, 9, 10, 14, 17, 13, 13, 14, 12, 11, 13, 11, 9, 13, 13, 10, 13, 24],
  },
  {
    name: 'VLOOKUP-examples',
    rows: [
      ['What you calculate today', 'Typical formula (adjust ranges to your files)', 'Notes'],
      ['Pull the supplier cost for an EAN from the raw list', "=VLOOKUP($A2,'[ALCODIS_RAW_20261019_01.xlsx]Sheet1'!$A:$R,10,FALSE)", 'Column 10 = the price column in the raw file. Save this exact formula in 09-vlookup-formulas.xlsx too.'],
      ['Pull a dated FX rate for the cost currency', "=VLOOKUP(C2,FXRates!$A:$B,2,FALSE)", 'Cost currency in C2, rates table in FXRates.'],
      ['Apply your standard markup to landed cost', '=ROUND(L2*(1+P2/100),2)', 'Landed cost x (1 + markup%).'],
      ['Trade discount off an RRP list', '=ROUND(M2*(1-Q2/100),2)', 'RRP x (1 - trade discount%).'],
      ['Tier price by quantity', '=IF(J2>=12,61.5,IF(J2>=6,63.9,66.4))', 'Tier logic — send the real one from your workbook.'],
      ['Find last confirmed stock date', "=INDEX('[ALCODIS_RAW_20261019_01.xlsx]Sheet1'!$K:$K,MATCH($A2,'[ALCODIS_RAW_20261019_01.xlsx]Sheet1'!$A:$A,0))", 'INDEX/MATCH variant — copy the real one you use.'],
    ],
    widths: [52, 86, 74],
  },
  guide([
    ['Field', 'Required', 'Type', 'Meaning', 'Example'],
    ['ean', 'YES', 'TEXT', 'Unit barcode. Format cell as Text — leading zeros are significant.', '3348901392025'],
    ['brand / product / concentration / sizeMl / gender', 'YES', 'TEXT / int', 'Identity of the fragrance as you present it to customers.', 'Dior / Sauvage EDP 100ml / EDP / 100 / Men'],
    ['casePack', 'If sold by case', 'integer', 'Units per case when price relates to a case. Never infer it from a case barcode.', '6'],
    ['supplierCode / supplierListDate', 'YES', 'TEXT / YYYY-MM-DD', 'Which supplier list this line came from and its date (traceability).', 'ALCODIS / 2026-10-01'],
    ['costPerUnit / costCurrency', 'YES', 'number / ISO', 'What you pay per bottle, in the supplier base currency (per BOTTLE, not per case).', '61.5 / EUR'],
    ['fxRateToSell', 'If currencies differ', 'number', 'Rate used to convert cost into sell currency (quote units per 1 base unit).', '1.08'],
    ['landedCost', 'YES (for margin)', 'number', 'Cost after freight, duty, handling — your true cost per bottle.', '63.9'],
    ['sellPrice / sellCurrency', 'YES', 'number / ISO', 'Price you quote the customer per bottle.', '82.5 / USD'],
    ['markupPct', 'Recommended', 'number %', 'Markup applied over landed cost — makes your pricing rule auditable.', '29'],
    ['rrp', 'If known', 'number', 'Recommended retail price.', '105'],
    ['availability', 'Recommended', 'TEXT', 'In stock / Low stock / Pre-order / Out of stock.', 'In stock'],
    ['validUntil', 'Recommended', 'YYYY-MM-DD', 'Until when this price holds.', '2026-10-31'],
    ['incoterm / leadTimeDays', 'Recommended', 'enum / int', 'Delivery term and lead time quoted to the customer.', 'EXW / 7'],
    ['notes', 'Optional', 'TEXT', 'Damage status, tester, sealed, promotions...', ''],
  ]),
  readme('How to fill 04-prepared-price-list.xlsx', [
    '1. Send TWO things per supplier: the RAW file as received (03) and YOUR PREPARED version of that same list — the one you actually send to customers.',
    '2. Also send the FIRST example of your existing prepared list even if its columns differ from ours: we need to see your current transformation, not a cleaned-up copy.',
    '3. If your prepared list is produced by VLOOKUP from the raw file, record those formulas in 09-vlookup-formulas.xlsx — that is how we rebuild your pricing logic.',
    '4. This template shows the target structure. Fill as many columns as you have; leave unknowns blank (never 0 for unknown).',
    '5. costPerUnit must be PER BOTTLE. If your raw price is per case, divide by casePack or leave casePack filled so we can convert.',
  ]),
]);

// -------------------------------------------- 05 offer company copy
save('05-offer-company-copy.xlsx', [
  {
    name: 'Offer-Internal',
    rows: [
      ['OFFER — COMPANY COPY (INTERNAL) — NEVER SEND TO CUSTOMER'],
      [''],
      ['Offer reference', 'Q-0042', '', 'Date', '2026-10-19'],
      ['Customer code', 'CUST-001', '', 'Valid until', '2026-11-02'],
      ['Customer name', 'Acme Distribution LLC', '', 'Currency', 'USD'],
      ['Prepared by', 'Maria Serra', '', 'Status', 'DRAFT / APPROVED / SENT'],
      ['Approved by', '(if approval required)', '', 'Price list basis', 'ALCODIS 2026-10-01'],
      [''],
      ['line', 'sku', 'ean', 'brand', 'product', 'concentration', 'sizeMl', 'qty', 'unitPriceSell', 'lineTotal', 'supplierCode', 'unitCost', 'landedUnitCost', 'marginPct', 'markupPct', 'incoterm', 'leadTimeDays', 'notes'],
      [1, 'ALC-000123', '3348901392025', 'Dior', 'Sauvage EDP 100ml', 'EDP', 100, 240, 82.5, 19800, 'ALCODIS', 61.5, 63.9, 22.6, 29.1, 'EXW', 7, 'EXAMPLE — replace'],
      [2, 'ALC-000456', '3348901387032', 'Dior', 'Sauvage EDT 60ml', 'EDT', 60, 120, 54.9, 6588, 'IGAN', 38.1, 39.6, 27.9, 38.6, 'EXW', 7, 'EXAMPLE — replace'],
      [''],
      ['', '', '', '', '', 'Subtotal', '', '', '', 26388],
      ['', '', '', '', '', 'Freight / other (if charged)', '', '', '', 0],
      ['', '', '', '', '', 'TOTAL', '', '', '', 26388],
      ['', '', '', '', '', 'Blended margin % on this offer', '', '', '', '23.8'],
      [''],
      ['Payment terms', 'Net 45', '', 'Internal notes', 'Customer negotiates volume — floor price 78.50 USD'],
      [''],
      ['INTERNAL — this sheet contains supplier cost, landed cost, margin and internal notes. The customer copy is 06-offer-customer-copy.xlsx.'],
    ],
    widths: [6, 14, 16, 10, 24, 15, 9, 8, 15, 12, 14, 11, 15, 11, 11, 11, 13, 44],
  },
  guide([
    ['Field', 'Required', 'Type', 'Meaning'],
    ['Offer reference', 'YES', 'TEXT', 'Your quote number. Platform format is Q-#### (e.g. Q-0042); keep your own if different and note it in 07.'],
    ['Date / Valid until', 'YES', 'YYYY-MM-DD', 'Issue and expiry dates.'],
    ['Customer code / name', 'YES', 'TEXT', 'Must match 02-customer-master.xlsx.'],
    ['Currency', 'YES', 'ISO 4217', 'Currency of unitPriceSell — normally the customer base currency.'],
    ['Prepared by / Approved by / Status', 'Recommended', 'TEXT', 'Who made it, who signed it off, workflow state.'],
    ['Price list basis', 'Recommended', 'TEXT', 'Which supplier list + date the prices came from (traceability).'],
    ['Line items: qty, unitPriceSell, lineTotal', 'YES', 'number', 'What you sell, at what price, line total = qty x unitPriceSell.'],
    ['supplierCode, unitCost, landedUnitCost', 'YES (internal)', 'number', 'Supplier and true cost — this is WHY there are two copies of the offer.'],
    ['marginPct / markupPct', 'Recommended', 'number %', 'Margin on sell price / markup on cost per line, plus blended margin on totals.'],
    ['Totals block', 'YES', 'number', 'Subtotal, charges, TOTAL, blended margin %.'],
    ['Payment terms / Internal notes', 'Optional', 'TEXT', 'Terms sent to customer are in 06; internal notes (floors, approvals) stay here only.'],
  ]),
  readme('How to use 05-offer-company-copy.xlsx', [
    '1. Send us 1-3 REAL examples of your current internal/company offer copy (save the real content over the example rows).',
    '2. This copy is the internal record: cost, landed cost, margin, floor price notes. It must never leave the company — label it in your naming convention (07).',
    '3. The customer copy template is 06 — the difference between the two files defines exactly which columns must be hidden or removed by the platform.',
    '4. If your current company copy is a spreadsheet with formulas, also send the file itself and record its formulas in 09.',
  ]),
]);

// ------------------------------------------ 06 offer customer copy
save('06-offer-customer-copy.xlsx', [
  {
    name: 'Offer-Customer',
    rows: [
      ['OFFER — CUSTOMER COPY (as sent to the customer)'],
      [''],
      ['Offer reference', 'Q-0042', '', 'Date', '2026-10-19'],
      ['Customer', 'Acme Distribution LLC', '', 'Valid until', '2026-11-02'],
      ['Prepared by', 'Maria Serra', '', 'Currency', 'USD'],
      [''],
      ['line', 'brand', 'product', 'concentration', 'sizeMl', 'qty', 'unitPrice', 'lineTotal', 'availability', 'leadTimeDays', 'notes'],
      [1, 'Dior', 'Sauvage EDP 100ml', 'EDP', 100, 240, 82.5, 19800, 'In stock', 7, 'EXAMPLE — replace'],
      [2, 'Dior', 'Sauvage EDT 60ml', 'EDT', 60, 120, 54.9, 6588, 'Low stock', 7, 'EXAMPLE — replace'],
      [''],
      ['', '', '', '', '', 'Subtotal', 26388],
      ['', '', '', '', '', 'Freight (per Incoterm)', 0],
      ['', '', '', '', '', 'TOTAL', 26388],
      [''],
      ['Incoterm', 'EXW Barcelona', '', 'Payment terms', 'Net 45'],
      ['Delivery lead time', '7 days from order', '', 'Prices valid until', '2026-11-02'],
      [''],
      ['Terms: prices in USD, exclude/import duty unless stated. Authenticity guaranteed. Subject to prior sale.'],
    ],
    widths: [6, 14, 10, 24, 15, 9, 8, 12, 13, 14, 44],
  },
  guide([
    ['Field', 'Required', 'Type', 'Meaning'],
    ['Offer reference / Date / Valid until', 'YES', 'TEXT / date', 'Same reference as the company copy — one offer, two files.'],
    ['Customer / Currency', 'YES', 'TEXT / ISO', 'Who it is for and the quoting currency.'],
    ['Line items: brand..qty, unitPrice, lineTotal', 'YES', 'text / number', 'Exactly what the customer sees. NO cost, NO landed cost, NO margin, NO supplier code, NO internal notes.'],
    ['availability / leadTimeDays / notes', 'Recommended', 'text / int', 'Commercial detail you currently send.'],
    ['Totals block', 'YES', 'number', 'Subtotal, charges, TOTAL.'],
    ['Incoterm / Payment terms / lead time / validity', 'YES', 'text', 'Commercial terms block as you normally print it.'],
    ['Terms footer', 'Recommended', 'TEXT', 'Your standard small print.'],
  ]),
  readme('How to use 06-offer-customer-copy.xlsx', [
    '1. Send 1-3 REAL examples of the offer you actually send to customers (email attachment or printed PDF — export to xlsx or paste content here).',
    '2. Together with 05 (company copy) this tells us precisely which information must be masked when a document goes to a customer.',
    '3. The platform generates this copy from the same offer data: Excel and PDF, cost-masked. Your examples let us match your layout, terms wording and branding.',
    '4. If you send PDFs, also tell us in 07-document-naming.xlsx what the file is called.',
  ]),
]);

// ------------------------------------------------- 07 naming conventions
save('07-document-naming.xlsx', [
  {
    name: 'Naming',
    rows: [
      ['documentType', 'audience', 'pattern', 'example', 'format', 'containsConfidential', 'yourCurrentNamePattern', 'notes'],
      ['Supplier raw price list (as received)', 'supplier -> us', 'KEEP ORIGINAL FILENAME (never rename the file itself)', 'LISTA OCTUBRE ALCODIS(v.2).xls', 'xls / xlsx', 'YES', '', 'Described in 03-raw-price-list-log.xlsx'],
      ['Supplier raw price list (archive copy)', 'internal', 'SUP-{supplierCode}_RAW_{YYYYMMDD}_{seq}', 'SUP-ALCODIS_RAW_20261019_01.xlsx', 'xlsx', 'YES', '', 'Optional internal archive naming'],
      ['Supplier quotation request (RFQ)', 'us -> supplier', 'RFQ-{supplierCode}_{YYYYMMDD}_{seq}', 'RFQ-IGAN_20261019_02.xlsx', 'xlsx', 'YES', '', ''],
      ['Supplier proforma invoice (PFI)', 'supplier -> us', '{supplierCode}_PFI_{YYYYMMDD}_{seq}', 'IGAN_PFI_20261105_01.xlsx', 'xlsx / pdf', 'YES', '', 'Used for placement reconciliation'],
      ['Prepared price list (sent to customer)', 'us -> customer', 'PL-{customerCode}_{YYYYMMDD}_R{rev}', 'PL-CUST-001_20261019_R1.xlsx', 'xlsx / pdf', 'NO*', 'R{rev} = revision', 'Content: 04 template. *unless it shows cost — it must not'],
      ['Offer — company copy (internal)', 'internal', 'OFFER-{quoteRef}_INTERNAL_{YYYYMMDD}', 'OFFER-Q-0042_INTERNAL_20261019.xlsx', 'xlsx', 'YES — NEVER SEND', '', 'Content: 05 template'],
      ['Offer — customer copy (as sent)', 'us -> customer', 'OFFER-{quoteRef}_{customerCode}_{YYYYMMDD}', 'OFFER-Q-0042_CUST-001_20261019.pdf', 'pdf (and xlsx)', 'NO', '', 'Content: 06 template. Platform export: ptp-quote-{id}.xlsx/.pdf'],
      ['Customer purchase order (received)', 'customer -> us', '{customerCode}_PO_{YYYYMMDD}_{seq}', 'CUST-001_PO_20261020_01.xlsx', 'xlsx / pdf', 'YES', '', ''],
      ['Supplier order placement (platform export)', 'us -> supplier', 'placement-{PO-ref} (system-generated)', 'placement-PO-0007.xlsx / .pdf', 'xlsx / pdf', 'YES', '', 'Generated by the platform — do not rename'],
      ['Cleaned supplier import (platform export)', 'internal', '{supplierCode}-upload-{n} (system-generated)', 'ALCODIS-upload-1.xlsx', 'xlsx', 'YES', '', 'Generated after every import'],
      ['Process capture (screenshot / video)', 'client -> us', 'PROC-{processId}_{step}_{YYYYMMDD}', 'PROC-P03_step1_20261019.mp4', 'png / mp4', 'YES — internal screens', '', 'See 08-process-capture-checklist.xlsx'],
      ['VLOOKUP formula log', 'client -> us', '09-vlookup-formulas.xlsx (this pack)', '09-vlookup-formulas.xlsx', 'xlsx', 'YES', '', 'Paste formulas as TEXT'],
    ],
    widths: [46, 16, 62, 52, 14, 22, 26, 52],
  },
  {
    name: 'Rules',
    rows: [
      ['Rule', 'Detail'],
      ['Date format', 'YYYYMMDD inside file names (20261019); YYYY-MM-DD inside cells.'],
      ['Separators', '_ between blocks, - inside a block (customer codes keep their own -). No spaces in file names.'],
      ['Sequence', 'Two digits per day per document type: _01, _02...'],
      ['Revision', 'R1, R2... increments whenever content changes after sending.'],
      ['Reference keys', 'supplierCode, customerCode and quoteRef always come from the master files (01 / 02) and the platform (Q-####) — never invented per document.'],
      ['Case', 'UPPERCASE for document type tokens (RAW, PFI, RFQ, PO, OFFER); keep supplier/customer codes in their master case.'],
      ['Two-copy rule', 'Every customer-facing document that has an internal twin ends in either _INTERNAL (never sent) or the customer code (safe to send).'],
      ['Extensions', '.xlsx for editable/spreadsheet, .pdf for what was actually sent to the customer, .xls kept only for raw supplier files as received.'],
    ],
    widths: [24, 110],
  },
  readme('How to use 07-document-naming.xlsx', [
    '1. Column "pattern" is the convention we propose the platform will use (and already partly uses for generated exports).',
    '2. Column "yourCurrentNamePattern" is for YOU: write the naming you use today for each document you already produce, so we can reconcile the two conventions.',
    '3. If any proposed pattern conflicts with your ERP/email habits, change it here — this file becomes the naming spec everyone agrees on.',
  ]),
]);

// ---------------------------------------- 08 process capture checklist
save('08-process-capture-checklist.xlsx', [
  {
    name: 'Processes',
    rows: [
      ['id', 'process', 'what to capture', 'captureType', 'fileNaming', 'what to highlight / narrate', 'currentTools', 'receivedDate'],
      ['P1', 'Receiving supplier price lists (where files arrive, how you save & name them)', 'Screen video from inbox/download to archive folder', 'video', 'PROC-P01_{step}_{YYYYMMDD}.mp4', 'Source (email/portal), how you name the file, which folder, who forwards it', '', ''],
      ['P2', 'Opening and validating a raw supplier list (finding the header row, spotting bad barcodes)', 'Screen video opening the raw file', 'video', 'PROC-P02_{step}_{YYYYMMDD}.mp4', 'Header row location, barcode column, price column, case-pack clues, obvious errors', '', ''],
      ['P3', 'Converting the raw list into your prepared price list (THE VLOOKUP PROCESS)', 'Screen video of the whole transformation, sheet by sheet', 'video', 'PROC-P03_{step}_{YYYYMMDD}.mp4', 'Every formula you drag/fill, lookup source file, FX application, markup/discount rule, rounding, how the output file is produced and saved', '', ''],
      ['P4', 'Updating currency rates (where rates come from, how often, how applied)', 'Screenshots of the rate source + video of applying rates', 'screenshot + video', 'PROC-P04_{step}_{YYYYMMDD}', 'Source website/workbook, date of rate, pairs used, who does it, cadence', '', ''],
      ['P5', 'Deciding the customer sell price (markup/discount tiers, minimum margin, rounding)', 'Screenshots of any rule sheet + short video', 'screenshot', 'PROC-P05_{step}_{YYYYMMDD}', 'The pricing table/rules, exceptions, who approves a price below floor', '', ''],
      ['P6', 'Producing the company copy of an offer (with cost & margin)', 'Screen video creating one offer end to end', 'video', 'PROC-P06_{step}_{YYYYMMDD}.mp4', 'Which file/template, formulas, cost columns, approval step, where it is saved', '', ''],
      ['P7', 'Producing and sending the customer copy (masking cost & printing/PDF)', 'Screen video + the actual sent email as an example', 'video + email', 'PROC-P07_{step}_{YYYYMMDD}.mp4', 'Which columns are deleted/hidden, PDF export, subject line, file name used, recipients', '', ''],
      ['P8', 'Receiving a customer order (PO) and placing the supplier order', 'Screen video from customer PO to supplier order/confirmation', 'video', 'PROC-P08_{step}_{YYYYMMDD}.mp4', 'PO file handling, stock check, price re-check, order file/email to supplier, references used', '', ''],
      ['P9', 'Reconciling the supplier proforma/invoice against the order', 'Screen video matching PFI lines to your order', 'video', 'PROC-P09_{step}_{YYYYMMDD}.mp4', 'How mismatches (price/qty/currency) are found and resolved, who decides', '', ''],
      ['P10', 'Monthly price refresh / detecting supplier price changes', 'Screen video comparing new list to old + before/after files', 'video', 'PROC-P10_{step}_{YYYYMMDD}.mp4', 'How you spot changes, how the prepared list is reissued, how customers are told', '', ''],
      ['P11', 'YOUR PROCESS NOT LISTED: ____________________', '', '', 'PROC-P11_{step}_{YYYYMMDD}', '', '', ''],
    ],
    widths: [7, 62, 56, 18, 40, 76, 24, 15],
  },
  {
    name: 'HowToCapture',
    rows: [
      ['How to record process captures'],
      [''],
      ['Tool', 'Any is fine: Teams/Zoom record, OBS, Loom, or a phone pointed at the screen (last resort).'],
      ['Length', '2-10 minutes per process. One process = one file. Stop between processes.'],
      ['Scope', 'Show the FULL window: formula bar, column headers, file names, folder paths. Crop nothing.'],
      ['Narration', 'Say out loud what you are doing and WHY (e.g. "I look up the EAN in the October list, then take cost times 1.08").'],
      ['Secrets', 'Hide only passwords and API keys. Do NOT hide prices, formulas or file names — that is exactly what we need.'],
      ['Formulas', 'Where a screen shows a formula, also copy it into 09-vlookup-formulas.xlsx.'],
      ['Naming', 'PROC-{processId}_{step}_{YYYYMMDD} where step = step1/step2... inside that process, extension .mp4 / .png.'],
      ['Delivery', 'Put all media in one folder named process-captures/ inside the delivery package (zip or shared drive link).'],
      ['Priority', 'If you only capture three: P3 (raw -> prepared list), P6 (company offer), P7 (customer copy).'],
    ],
    widths: [16, 116],
  },
]);

// --------------------------------------------- 09 VLOOKUP formulas log
save('09-vlookup-formulas.xlsx', [
  {
    name: 'Formulas',
    rows: [
      ['id', 'workbookFile', 'sheetName', 'cellOrColumn', 'formulaText (paste as TEXT)', 'businessPurpose', 'inputColumns (source)', 'outputColumn (result)', 'relatedProcessId', 'exampleInput', 'exampleResult'],
      ['F01', 'my-price-prep.xlsx', 'Prepared', 'J2 (dragged to J2:Z900)', "=VLOOKUP($A2,'[LISTA OCTUBRE ALCODIS(v.2).xls]Sheet1'!$A:$R,10,FALSE)", 'Looks up the supplier cost for the EAN in column A of my prepared sheet, from the October raw list', 'raw list col A=EAN, col J=price', 'costPerUnit', 'P3', '3348901392025', '61.5'],
      ['F02', 'my-price-prep.xlsx', 'FX', 'C2', '=VLOOKUP(B2,FX!$A:$B,2,FALSE)', 'Converts cost currency to USD using my FX sheet', 'FX!A=currency pair, FX!B=rate', 'fxRateToSell', 'P4', 'EURUSD', '1.08'],
      ['F03', '', '', '', '', 'EXAMPLE ROWS ABOVE — replace with your real ones. Add one row per distinct formula.', '', '', '', '', ''],
    ],
    widths: [7, 26, 14, 24, 96, 62, 30, 20, 15, 24, 16],
  },
  {
    name: 'HowToExtract',
    rows: [
      ['How to copy a formula WITHOUT breaking anything'],
      [''],
      ['1', 'Click the cell that CONTAINS the formula (not the result).'],
      ['2', 'The formula appears in the formula bar at the top — select it there and Ctrl+C.'],
      ['3', 'Come to the "Formulas" sheet of this file. Column E is formatted as text: just paste (Ctrl+V) — it will stay as text, not execute.'],
      ['4', 'If Excel ever turns it into a working formula, press Ctrl+Z and format the cell as Text first (Home > Number > Text), then paste again.'],
      ['5', 'Fill in businessPurpose in plain words ("pulls cost by barcode", "rounds to 2 decimals") — that is what lets us rebuild your logic.'],
      ['6', 'One row per DISTINCT formula. If J2:J900 is the same formula dragged down, one row and cellOrColumn = J2 (dragged to J2:J900).'],
      ['7', 'Also list VLOOKUP/XLOOKUP/INDEX+MATCH/SUMIF and any nested IF pricing chains — pricing IFs are as important as lookups.'],
      ['8', 'Macros/Power Query: describe them in businessPurpose and send the workbook itself.'],
      [''],
      ['Formula types we specifically need', 'VLOOKUP, XLOOKUP, INDEX+MATCH, SUMIF(S), IF/IFS price tiers, currency conversion, rounding, margin calc, any cross-workbook reference.'],
    ],
    widths: [34, 116],
  },
  readme('How to fill 09-vlookup-formulas.xlsx', [
    '1. Every VLOOKUP/XLOOKUP/INDEX formula currently in use across your workbooks — one row per distinct formula.',
    '2. Paste formula text ONLY into column E of the Formulas sheet (it is pre-formatted as text so nothing executes).',
    '3. Include formulas from: price preparation, FX conversion, pricing/markup, offer building, stock lookup, any report you keep in Excel.',
    '4. Attach or reference the workbook file names (column workbookFile) and if possible send copies of those workbooks with the delivery package.',
    '5. Together with process videos (08) and the prepared price list (04), these formulas are the specification of your current pricing process.',
  ]),
]);

console.log('done ->', OUT);
