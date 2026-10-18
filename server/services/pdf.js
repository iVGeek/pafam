'use strict';
// PDF rendering for every export in the system.
//
// One rule: the PDF and the .xlsx always come from the same rows/columns, so
// the two formats can never disagree. pdf-lib is used because it has no native
// dependencies and works on any platform.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 36;
const COLORS = {
  ink: rgb(0.13, 0.14, 0.16),
  muted: rgb(0.45, 0.47, 0.5),
  head: rgb(0.93, 0.94, 0.95),
  rule: rgb(0.82, 0.83, 0.85),
  zebra: rgb(0.975, 0.978, 0.982),
  brand: rgb(0.32, 0.2, 0.55),
  white: rgb(1, 1, 1),
};

// The standard PDF fonts are WinAnsi-only. Replace anything outside that set
// (control chars, box drawing, stray replacement glyphs) so text can never
// silently become a black square or break the writer.
const WIN_ANSI = /^[\n\r\t -~\u00A0-\u00FF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u2013\u2014\u2018\u2019\u201C\u201D\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]$/;
function sanitize(value) {
  const s = value == null ? '' : String(value);
  let out = '';
  for (const ch of s) {
    if (ch === '\n' || ch === '\r' || ch === '\t') out += ' ';
    else if (WIN_ANSI.test(ch)) out += ch;
    else out += '?';
  }
  return out;
}

function fit(text, font, size, maxW) {
  const t = sanitize(text);
  if (!t) return '';
  if (font.widthOfTextAtSize(t, size) <= maxW) return t;
  let cut = t;
  const dots = '...';
  while (cut.length > 1 && font.widthOfTextAtSize(cut + dots, size) > maxW) cut = cut.slice(0, -1);
  return cut + dots;
}

function cellValue(row, col) {
  const raw = typeof col.value === 'function' ? col.value(row) : row[col.key];
  return raw == null ? '' : raw;
}

// Convert descriptor rows ({columns, rows}) into the grid the renderer draws.
function gridFromSheet(columns, rows) {
  const cols = (columns || []).map((c) => ({ title: c.title || '', wch: c.wch || 16 }));
  const cells = (rows || []).map((r) => (columns || []).map((c) => cellValue(r, c)));
  return { cols, cells };
}

function columnWidths(cols, cells, contentW) {
  const weights = cols.map((c, i) => {
    let w = Math.max(String(c.title).length, Number(c.wch) || 16);
    for (let r = 0; r < Math.min(cells.length, 60); r += 1) {
      const len = String(cells[r] && cells[r][i] != null ? cells[r][i] : '').length;
      w = Math.max(w, Math.min(len, 60));
    }
    return Math.max(5, Math.min(w, 60));
  });
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map((w) => Math.max(28, (w / total) * contentW));
}

/**
 * Render a document: title, a label/value meta block, then an optional table.
 * `columns`/`rows` are the same descriptors the Excel export uses.
 */
async function render(options) {
  const opts = options || {};
  const orientation = opts.orientation || 'landscape';
  const pageW = orientation === 'portrait' ? A4.w : A4.h;
  const pageH = orientation === 'portrait' ? A4.h : A4.w;
  const contentW = pageW - MARGIN * 2;

  const doc = await PDFDocument.create();
  if (opts.title) doc.setTitle(sanitize(opts.title).slice(0, 120));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const { cols, cells } = opts.grid || gridFromSheet(opts.columns, opts.rows);
  const widths = cols.length ? columnWidths(cols, cells, contentW) : [];
  const hasTable = cols.length > 0;
  const rowH = 15;
  const headH = 17;

  let page = doc.addPage([pageW, pageH]);
  let y = pageH - MARGIN;
  let pPage = page;

  const drawTableHeader = () => {
    const x0 = MARGIN;
    pPage.drawRectangle({ x: x0, y: y - headH + 4, width: contentW, height: headH, color: COLORS.head });
    let x = x0 + 5;
    widths.forEach((w, i) => {
      pPage.drawText(fit(cols[i].title, bold, 8, w - 8), { x, y: y - headH + 9, size: 8, font: bold, color: COLORS.ink });
      x += w;
    });
    y -= headH;
  };

  // ---- title + meta ----
  if (opts.title) {
    const t = sanitize(opts.title);
    pPage.drawText(fit(t, bold, 15, contentW), { x: MARGIN, y: y - 12, size: 15, font: bold, color: COLORS.ink });
    y -= 24;
    pPage.drawLine({ start: { x: MARGIN, y: y + 4 }, end: { x: MARGIN + contentW, y: y + 4 }, thickness: 1, color: COLORS.brand });
    y -= 8;
  }
  for (const pair of opts.meta || []) {
    const label = sanitize(pair[0]);
    const value = sanitize(pair[1]);
    const lw = Math.min(150, font.widthOfTextAtSize(label + ':', 8.5) + 10);
    pPage.drawText(fit(label + ':', bold, 8.5, lw), { x: MARGIN, y: y - 9, size: 8.5, font: bold, color: COLORS.muted });
    pPage.drawText(fit(value, font, 8.5, contentW - lw), { x: MARGIN + lw, y: y - 9, size: 8.5, font, color: COLORS.ink });
    y -= 13;
    if (y < MARGIN + rowH * 2) { page = doc.addPage([pageW, pageH]); pPage = page; y = pageH - MARGIN; }
  }
  if (opts.meta && opts.meta.length) y -= 6;

  // ---- table ----
  if (hasTable) {
    if (!cells.length) {
      pPage.drawText('No rows to show.', { x: MARGIN, y: y - 10, size: 9, font, color: COLORS.muted });
      y -= 16;
    } else {
      if (y - headH < MARGIN + rowH) { page = doc.addPage([pageW, pageH]); pPage = page; y = pageH - MARGIN; }
      drawTableHeader();
      cells.forEach((cellsRow, r) => {
        if (y - rowH < MARGIN + 4) {
          page = doc.addPage([pageW, pageH]); pPage = page; y = pageH - MARGIN;
          drawTableHeader();
        }
        if (r % 2 === 1) pPage.drawRectangle({ x: MARGIN, y: y - rowH + 4, width: contentW, height: rowH, color: COLORS.zebra });
        let x = MARGIN + 5;
        widths.forEach((w, i) => {
          const text = fit(cellsRow[i], font, 8, w - 9);
          pPage.drawText(text, { x, y: y - rowH + 8, size: 8, font, color: COLORS.ink });
          x += w;
        });
        y -= rowH;
      });
      pPage.drawRectangle({ x: MARGIN, y: y + 4, width: contentW, height: 0.6, color: COLORS.rule });
      y -= 6;
    }
  }
  for (const line of opts.notes || []) {
    if (y - 12 < MARGIN) { page = doc.addPage([pageW, pageH]); pPage = page; y = pageH - MARGIN; }
    pPage.drawText(fit(line, font, 8, contentW), { x: MARGIN, y: y - 9, size: 8, font, color: COLORS.muted });
    y -= 12;
  }

  // ---- footers ----
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `${i + 1} / ${pages.length}   generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
    p.drawText(fit(label, font, 7, contentW), { x: MARGIN, y: 16, size: 7, font, color: COLORS.muted });
  });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

// Sheet descriptor ({columns, rows}) -> PDF.
async function sheetPdf(descriptor, options) {
  const opts = options || {};
  const grid = gridFromSheet(descriptor.columns, descriptor.rows);
  const meta = (descriptor.meta || []).concat(opts.meta || []);
  const portrait = opts.orientation === 'portrait' || (!opts.orientation && grid.cols.length <= 3);
  return render({
    title: opts.title || descriptor.title || descriptor.name,
    meta,
    grid,
    orientation: opts.orientation || (portrait ? 'portrait' : 'landscape'),
    notes: opts.notes || descriptor.notes,
  });
}

// A raw grid (array of arrays, first row = header) -> PDF. Used by the cleaned
// template snapshot and by the client-side "export this table" feature.
// Narrow tables read better in portrait; wide ones need landscape.
async function gridPdf(header, rows, options) {
  const opts = options || {};
  const cols = (header || []).map((t, i) => ({ title: String(t), wch: String(t).length + 6 }));
  return render({
    title: opts.title,
    meta: opts.meta || [],
    grid: { cols, cells: rows || [] },
    orientation: opts.orientation || (cols.length <= 3 ? 'portrait' : 'landscape'),
    notes: opts.notes,
  });
}

// Label/value document (quote, placement cover sheet) -> PDF.
async function metaPdf(options) {
  return render(Object.assign({ orientation: 'portrait' }, options));
}

module.exports = { render, sheetPdf, gridPdf, metaPdf, sanitize, fit };
