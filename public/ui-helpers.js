'use strict';

/* ============================ helpers ============================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n, cur = '') {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur ? `${v} ${cur}` : v;
}
function num(n, d = 0) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
function pct(n, d = 1) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toFixed(d) + '%';
}
function dt(s) { return s ? String(s).replace('T', ' ').slice(0, 19) : '—'; }

function toast(msg, kind = '') {
  const wrap = $('#toasts') || document.body;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<button class="x" aria-label="Dismiss">&#10005;</button>${esc(msg)}`;
  el.querySelector('.x').addEventListener('click', () => el.remove());
  wrap.appendChild(el);
  const sticky = kind === 'err';
  setTimeout(() => { if (el.isConnected) el.remove(); }, sticky ? 12000 : 4200);
  while (wrap.children.length > 4) wrap.firstChild.remove();
}

async function api(method, url, body, isForm) {
  const opts = { method, headers: {} };
  if (body && !isForm) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  if (body && isForm) { opts.body = body; }
  const r = await fetch('/api' + url, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (r.status === 401 && !url.startsWith('/auth/login')) {
    state.user = null;
    showLogin();
    throw new Error((data && data.error) || 'Please sign in');
  }
  if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
  return data;
}
const GET = (u) => api('GET', u);
const POST = (u, b) => api('POST', u, b);
const DEL = (u) => api('DELETE', u);

const RANK = { viewer: 1, analyst: 2, buyer: 3, admin: 4 };
function can(min) { return (RANK[state.user && state.user.role] || 0) >= (RANK[min] || 1); }

function modal(title, bodyHtml, onMount, opts) {
  const wide = opts && opts.wide;
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(title)}</h2><button class="ghost sm" data-close aria-label="Close">&#10005;</button></div><div style="margin-top:14px" data-body></div></div>`;
  bg.querySelector('[data-body]').innerHTML = bodyHtml;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); if (lastFocus) lastFocus.focus(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.hasAttribute('data-close')) close(); });
  document.addEventListener('keydown', onKey);
  const lastFocus = document.activeElement;
  document.body.appendChild(bg);
  const first = bg.querySelector('input, select, textarea, button:not([data-close])');
  if (first) first.focus();
  if (onMount) onMount(bg);
  return bg;
}

function skeleton(n) {
  n = n || 4;
  const bars = Array.from({ length: n }).map(() => '<div class="bar" style="width:' + (40 + Math.random() * 55) + '%"></div>').join('');
  return `<div class="skel" aria-busy="true">${bars}</div>`;
}

const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  percent: '<path d="M19 5 5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  clipboard: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  award: '<circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/>',
  compare: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98"/><path d="m15.41 6.51-6.82 3.98"/>',
  calculator: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M8 6h8"/><path d="M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  trending: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  forecast: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  sparkles: '<path d="M12 3v3m0 12v3M5.6 5.6l2.2 2.2m8.4 8.4 2.2 2.2M3 12h3m12 0h3M5.6 18.4l2.2-2.2m8.4-8.4 2.2-2.2"/><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/>',
  building: '<rect width="16" height="20" x="4" y="2" rx="2" ry="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 1v4m0 14v4M4.2 4.2l2.8 2.8m10 10 2.8 2.8M1 12h4m14 0h4M4.2 19.8l2.8-2.8m10-10 2.8-2.8"/>',
  scroll: '<path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/>',
  paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
};
function icon(name, size) {
  const path = ICONS[name] || '';
  return `<span class="ni"><svg width="${size || 18}" height="${size || 18}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg></span>`;
}
const ROUTE_ICONS = {
  dashboard: 'grid', imports: 'upload', offers: 'tag', products: 'package', exceptions: 'alert',
  demands: 'inbox', buying: 'cart', builder: 'percent', quotes: 'file', orders: 'clipboard',
  placements: 'truck', shipments: 'truck', lowest: 'award', compare: 'compare', pricing: 'calculator',
  lists: 'list', inventory: 'archive', customers: 'users', captures: 'inbox', alerts: 'bell',
  trends: 'trending', forecast: 'forecast', performance: 'activity', reports: 'download', 'ai-chat': 'sparkles',
  suppliers: 'building', settings: 'gear', users: 'users', audit: 'scroll',
};
function decorateNav() {
  $$('#nav a').forEach((a) => {
    if (a.querySelector('.ni')) return;
    a.insertAdjacentHTML('afterbegin', icon(ROUTE_ICONS[a.dataset.route] || 'file', 18));
  });
}

function badgeList(flags) {
  const map = {
    'estimated-cost-from-rrp': ['warn', 'cost est. from RRP'],
    'retail-price': ['bad', 'retail (not cost)'],
    'priced-per-case': ['info', 'per case'],
    'invalid-barcode': ['bad', 'bad barcode'],
    'no-price': ['warn', 'no price'],
  };
  return (flags || []).map((f) => {
    const [k, label] = map[f] || ['muted', f];
    return `<span class="badge ${k}">${esc(label)}</span>`;
  }).join(' ');
}

/* ============================ state ============================ */
const state = { route: 'dashboard', settings: {}, suppliers: [], user: null };

const ROUTE_MIN = {
  dashboard: 'viewer', offers: 'viewer', products: 'viewer', compare: 'viewer', lowest: 'viewer', pricing: 'viewer', builder: 'viewer', lists: 'analyst',
  inventory: 'viewer', customers: 'viewer', demands: 'viewer', quotes: 'viewer', suppliers: 'viewer',
  exceptions: 'viewer', imports: 'buyer', captures: 'analyst', alerts: 'viewer', trends: 'viewer', orders: 'viewer', placements: 'viewer', shipments: 'viewer', buying: 'viewer', forecast: 'viewer', performance: 'viewer', reports: 'viewer', settings: 'admin', users: 'admin', audit: 'admin',
};

function showLogin() {
  $('#login').classList.remove('hidden');
  // Demo credentials are a local-dev convenience only — never on a real host.
  const host = location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  const el = $('#demoCreds');
  if (el) el.classList.toggle('hidden', !local);
}
function hideLogin() { $('#login').classList.add('hidden'); }

/* ======================= in-window search ======================= */
// One global box in the top bar filters whatever window is open; the big
// tables also get their own filter. Both work on the rendered DOM, so every
// module is covered without touching each route.
let viewSearch = '';

function isPlaceholderRow(row) {
  return row.cells && row.cells.length === 1 && row.cells[0].colSpan > 1;
}

function filterTableRows(table, query) {
  const ql = (query || '').trim().toLowerCase();
  const body = table.tBodies && table.tBodies[0];
  if (!body) return { shown: 0, total: 0 };
  let shown = 0, total = 0;
  Array.from(body.rows).forEach((r) => {
    if (isPlaceholderRow(r)) { r.classList.toggle('hidden', ql.length > 0); return; }
    total += 1;
    const hit = !ql || r.textContent.toLowerCase().includes(ql);
    if (hit) shown += 1;
    r.classList.toggle('hidden', !hit);
  });
  return { shown, total };
}

function applyGlobalSearch() {
  const root = $('#view');
  const ql = viewSearch.trim().toLowerCase();
  let shown = 0, total = 0;
  $$('table', root).forEach((t) => {
    const res = filterTableRows(t, ql);
    shown += res.shown; total += res.total;
  });
  $$('.card', root).forEach((c) => {
    total += 1;
    const hit = c.textContent.toLowerCase().includes(ql);
    if (hit) shown += 1;
    c.classList.toggle('hidden', !hit);
  });
  return { shown, total };
}

function installTableFilters() {
  state._filters = state._filters || {};
  $$('#view table').forEach((t) => {
    if (t.dataset.filtered === '1') return;
    const body = t.tBodies && t.tBodies[0];
    const rows = body ? Array.from(body.rows).filter((r) => !isPlaceholderRow(r)) : [];
    if (rows.length < 8) return; // only the big tables earn a filter
    const wrap = t.closest('.table-wrap') || t;
    if (!wrap.parentNode) return;
    const bar = document.createElement('div');
    bar.className = 'tblFilter';
    bar.innerHTML = '<input type="search" placeholder="Filter these rows…" autocomplete="off" aria-label="Filter these rows" /><span class="small muted"></span>';
    const input = bar.querySelector('input');
    const count = bar.querySelector('span');
    state._filters._n = (state._filters._n || 0) + 1;
    const fid = 'f' + state._filters._n;
    const saved = state._filters[state.route + ':' + fid];
    if (saved) input.value = saved;
    input.addEventListener('input', () => {
      state._filters[state.route + ':' + fid] = input.value;
      const res = filterTableRows(t, input.value);
      count.textContent = input.value ? `${res.shown}/${res.total}` : '';
    });
    if (input.value) {
      const res = filterTableRows(t, input.value);
      count.textContent = `${res.shown}/${res.total}`;
    }
    wrap.parentNode.insertBefore(bar, wrap);
    t.dataset.filtered = '1';
  });
}

function refreshSearchUI() {
  const root = $('#view');
  if (!root) return;
  const active = viewSearch.trim().length > 0;
  $$('.tblFilter', root).forEach((b) => b.classList.toggle('hidden', active));
  const count = $('#searchCount');
  if (!active) {
    $$('table tbody tr, .card', root).forEach((el) => el.classList.remove('hidden'));
    $$('.tblFilter span', root).forEach((s) => { s.textContent = ''; });
    if (count) count.textContent = '';
    return;
  }
  const res = applyGlobalSearch();
  if (count) count.textContent = res.total ? `${res.shown}/${res.total}` : 'no matches';
}

/* ======================= export this view ======================= */
// Every screen exports itself. The client reads the visible tables (so the
// export honours the search filter) and posts them to /api/export/table,
// which returns the same document as Excel or PDF.
function viewGrid() {
  const root = $('#view');
  const title = ($('#pageTitle') && $('#pageTitle').textContent.trim()) || 'Export';
  const visibleRows = (t) => {
    const body = t.tBodies && t.tBodies[0];
    if (!body) return [];
    return Array.from(body.rows).filter((r) => !r.classList.contains('hidden') && !isPlaceholderRow(r));
  };
  const tables = $$('table', root).filter((t) => visibleRows(t).length > 0);
  let maxCols = 1;
  let headers = [];
  const rows = [];
  tables.forEach((t, i) => {
    const headRow = t.tHead && t.tHead.rows[0];
    const th = headRow ? Array.from(headRow.cells).map((c) => c.textContent.trim()) : [];
    const body = visibleRows(t);
    let firstHeader = false;
    if (!headers.length && th.length) { headers = th; firstHeader = true; }
    if (tables.length > 1) {
      const panel = t.closest('.panel');
      const h = panel && panel.querySelector('h2');
      const caption = ((h ? h.textContent : '') || `Table ${i + 1}`).trim();
      rows.push([caption]);
      // the first table's header is already the document header row
      if (th.length && !firstHeader) rows.push(th);
    }
    body.forEach((r) => rows.push(Array.from(r.cells).map((c) => c.textContent.replace(/\s+/g, ' ').trim())));
    maxCols = Math.max(maxCols, th.length, ...body.map((r) => r.cells.length));
    rows.push([]);
  });
  while (rows.length && !rows[rows.length - 1].length) rows.pop();
  const columns = headers.slice();
  while (columns.length < maxCols) columns.push('');
  const padded = rows.map((r) => {
    const c = r.slice();
    while (c.length < maxCols) c.push('');
    return c;
  });
  return { title, columns, rows: padded };
}

async function exportView(format) {
  const grid = viewGrid();
  if (!grid.rows.length) { toast('Nothing to export on this screen', 'warn'); return; }
  const btns = $$('.viewExportBar [data-vx]');
  btns.forEach((b) => { b.disabled = true; });
  try {
    const r = await fetch('/api/export/table?format=' + (format === 'pdf' ? 'pdf' : 'xlsx'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(grid),
    });
    if (!r.ok) {
      const t = await r.text();
      let msg = 'HTTP ' + r.status;
      try { msg = (JSON.parse(t) || {}).error || msg; } catch { /* keep */ }
      throw new Error(msg);
    }
    const blob = await r.blob();
    const a = document.createElement('a');
    const slug = grid.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'export';
    a.download = slug + (format === 'pdf' ? '.pdf' : '.xlsx');
    a.href = URL.createObjectURL(blob);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`Exported ${a.download} (${num(grid.rows.length)} rows)`, 'ok');
  } catch (e) {
    toast('Export failed: ' + e.message, 'err');
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

function installExportBar() {
  const root = $('#view');
  if (!root || $('.viewExportBar', root)) return;
  const grid = viewGrid();
  if (!grid.rows.length) return;
  const bar = document.createElement('div');
  bar.className = 'viewExportBar';
  bar.innerHTML = `
    <span class="small muted">${num(grid.rows.length)} rows on this screen</span>
    <span class="small muted viewExportBarHint">export honours the current search</span>
    <span class="spacer"></span>
    <button class="btn sm" data-vx="xlsx" title="Download this screen as Excel">${icon('download', 15)}Excel</button>
    <button class="btn sm" data-vx="pdf" title="Download this screen as PDF">${icon('download', 15)}PDF</button>`;
  root.insertBefore(bar, root.firstChild);
  $$('.viewExportBar [data-vx]', bar).forEach((b) => b.addEventListener('click', () => exportView(b.dataset.vx)));
}

const DEAL_STEPS = [
  ['demands', 'Demand'], ['buying', 'Buying'], ['builder', 'Quote'],
  ['orders', 'Order'], ['placements', 'Placement'], ['shipments', 'Shipment'],
];
function dealStepper(active) {
  return `<div class="deal-stepper" aria-label="Deal lifecycle">${DEAL_STEPS.map(([r, label], i) =>
    `${i ? '<span class="ds-sep">›</span>' : ''}<button class="ds ${r === active ? 'active' : ''}" data-step="${r}" type="button"><span class="n">${i + 1}</span>${label}</button>`
  ).join('')}</div>`;
}

function numCell(v) {
  const n = Number(String(v || '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && String(v || '').trim() !== '' ? n : null;
}
function installTableSorting() {
  $$('#view table').forEach((t) => {
    if (t.dataset.sortable === '1') return;
    t.dataset.sortable = '1';
    const head = t.tHead && t.tHead.rows[0];
    if (!head) return;
    Array.from(head.cells).forEach((th, col) => {
      if (!th.textContent.trim() || th.classList.contains('num') === false && col === head.cells.length - 1) {
        // leave the action (empty) column unsortable
        if (!th.textContent.trim()) return;
      }
      if (!th.textContent.trim()) return;
      th.classList.add('sortable');
      th.title = 'Click to sort';
      th.addEventListener('click', () => {
        const body = t.tBodies[0];
        if (!body) return;
        const rows = Array.from(body.rows).filter((r) => !isPlaceholderRow(r));
        const desc = th.classList.contains('sorted') && !th.classList.contains('desc');
        Array.from(head.cells).forEach((h) => h.classList.remove('sorted', 'desc'));
        th.classList.add('sorted');
        if (desc) th.classList.add('desc');
        const dir = desc ? -1 : 1;
        rows.sort((a, b) => {
          const av = a.cells[col] ? a.cells[col].textContent : '';
          const bv = b.cells[col] ? b.cells[col].textContent : '';
          const an = numCell(av), bn = numCell(bv);
          if (an != null && bn != null) return (an - bn) * dir;
          return String(av).localeCompare(String(bv)) * dir;
        });
        rows.forEach((r) => body.appendChild(r));
      });
    });
  });
}

function wireView() {
  const root = $('#view');
  if (!root) return;
  if (DEAL_STEPS.some(([r]) => r === state.route) && !root.querySelector('.deal-stepper')) {
    root.insertAdjacentHTML('afterbegin', dealStepper(state.route));
  }
  installExportBar();
  installTableFilters();
  installTableSorting();
  $$('#view [data-step]').forEach((b) => b.addEventListener('click', () => go(b.dataset.step)));
  const box = $('#globalSearch');
  if (box) box.value = '';
  const drop = $('#globalSearchDrop');
  if (drop) drop.classList.add('hidden');
}

const globalSearchBox = $('#globalSearch');
const globalDrop = $('#globalSearchDrop');
let gsTimer = null;
async function globalFind(q) {
  const query = (q || '').trim();
  if (query.length < 2 || !globalDrop) { if (globalDrop) globalDrop.classList.add('hidden'); return; }
  const ql = query.toLowerCase();
  const customers = await GET('/customers').catch(() => []);
  const custHits = customers.filter((c) => (c.name || '').toLowerCase().includes(ql) || (c.code || '').toLowerCase().includes(ql)).slice(0, 5);
  const supHits = (state.suppliers || []).filter((s) => (s.name || '').toLowerCase().includes(ql) || (s.code || '').toLowerCase().includes(ql)).slice(0, 5);
  const prod = await GET('/products?limit=8&q=' + encodeURIComponent(query)).catch(() => ({ rows: [] }));
  const prodHits = prod.rows || [];
  const html = [];
  if (prodHits.length) {
    html.push('<div class="gs-sec">Products</div>');
    prodHits.forEach((p) => html.push(`<button class="gs-item" data-gs="product" data-id="${p.id}">${esc((p.display_name || '').slice(0, 60))}<span class="sub">${esc(p.canonical_gtin || '')} · ${p.supplier_count} supplier(s)</span></button>`));
  }
  if (custHits.length) {
    html.push('<div class="gs-sec">Customers</div>');
    custHits.forEach((c) => html.push(`<button class="gs-item" data-gs="customer">${esc(c.name || '')}<span class="sub">${esc(c.code || '')} · ${esc(c.region || '')}</span></button>`));
  }
  if (supHits.length) {
    html.push('<div class="gs-sec">Suppliers</div>');
    supHits.forEach((s) => html.push(`<button class="gs-item" data-gs="supplier" data-id="${esc(s.code)}">${esc(s.name || s.code)}<span class="sub">${esc(s.code)} · ${esc(s.currency || '')}</span></button>`));
  }
  globalDrop.innerHTML = html.join('') || '<div class="gs-item">No matches</div>';
  globalDrop.classList.remove('hidden');
  $$('#globalSearchDrop [data-gs]').forEach((b) => b.addEventListener('click', () => {
    globalDrop.classList.add('hidden');
    if (b.dataset.gs === 'product') openCompare(Number(b.dataset.id));
    else if (b.dataset.gs === 'supplier') { state._offerFilter = state._offerFilter || { limit: 40, offset: 0 }; state._offerFilter.supplier = b.dataset.id; state._offerFilter.offset = 0; go('offers'); }
    else if (b.dataset.gs === 'customer') { go('customers'); }
  }));
}
if (globalSearchBox) {
  globalSearchBox.addEventListener('input', () => {
    const q = globalSearchBox.value;
    clearTimeout(gsTimer);
    gsTimer = setTimeout(() => globalFind(q), 180);
  });
  globalSearchBox.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { globalSearchBox.value = ''; if (globalDrop) globalDrop.classList.add('hidden'); }
    if (e.key === 'Enter') {
      const first = globalDrop && globalDrop.querySelector('[data-gs]');
      if (first) first.click();
    }
  });
  document.addEventListener('click', (e) => {
    if (globalDrop && !globalDrop.contains(e.target) && e.target !== globalSearchBox) globalDrop.classList.add('hidden');
  });
}

async function loadSettings() {
  try {
    state.settings = await GET('/settings');
    state.suppliers = await GET('/suppliers');
    const cur = state.settings.base_currency || 'USD';
    $('#baseCur').textContent = 'Base ' + cur;
  } catch (e) { /* ignore */ }
}

/* ============================ product picker ============================ */
function mountProductPicker(root, onPick) {
  const input = root.querySelector('[data-pp-input]');
  const results = root.querySelector('[data-pp-results]');
  const hidden = root.querySelector('[data-pp-id]');
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    hidden.value = '';
    if (q.length < 2) { results.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      try {
        const data = await GET('/products?limit=20&q=' + encodeURIComponent(q));
        results.innerHTML = data.rows.map((p) =>
          `<div class="card" style="padding:8px 10px;cursor:pointer" data-id="${p.id}" data-name="${esc(p.display_name || p.canonical_gtin)}">
             <div style="font-weight:600">${esc(p.display_name || '(no name)')}</div>
             <div class="muted small mono">${esc(p.canonical_gtin || '')} · ${esc(p.category || '')} · ${p.supplier_count} supplier(s)</div>
           </div>`).join('') || '<div class="muted small">No matches</div>';
        $$('[data-id]', results).forEach((el) => el.addEventListener('click', () => {
          hidden.value = el.dataset.id;
          input.value = el.dataset.name;
          results.innerHTML = '';
          if (onPick) onPick(Number(el.dataset.id), el.dataset.name);
        }));
      } catch (e) { results.innerHTML = `<div class="muted small">${esc(e.message)}</div>`; }
    }, 220);
  });
}
