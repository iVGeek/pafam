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

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.innerHTML = `<div class="toast ${kind}">${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.innerHTML = ''; }, 4200);
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

function modal(title, bodyHtml, onMount) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(title)}</h2><button class="ghost sm" data-close>✕</button></div><div style="margin-top:14px" data-body></div></div>`;
  bg.querySelector('[data-body]').innerHTML = bodyHtml;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.hasAttribute('data-close')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(bg);
  if (onMount) onMount(bg);
  return bg;
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
  dashboard: 'viewer', offers: 'viewer', products: 'viewer', compare: 'viewer', lowest: 'viewer', pricing: 'viewer',
  inventory: 'viewer', customers: 'viewer', demands: 'viewer', quotes: 'viewer', suppliers: 'viewer',
  exceptions: 'viewer', imports: 'buyer', captures: 'analyst', alerts: 'viewer', settings: 'admin', users: 'admin', audit: 'admin',
};

function showLogin() { $('#login').classList.remove('hidden'); }
function hideLogin() { $('#login').classList.add('hidden'); }

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

/* ============================ ROUTES ============================ */
const routes = {};

routes.dashboard = async () => {
  const d = await GET('/dashboard');
  const o = d.overview;
  const wins = Object.entries(d.wins || {});
  const maxWin = Math.max(1, ...wins.map((w) => w[1]));
  const cards = [
    ['Supplier offers', num(o.offers), `${o.suppliers} suppliers · ${o.uploads} uploads`],
    ['Products', num(o.products), `${num(o.overlapProducts)} sourced from 2+ suppliers`],
    ['Open exceptions', num(o.openExceptions), (o.exceptionsByType || []).map((e) => `${e.n} ${e.type.replace('_', ' ')}`).join(' · ')],
    ['Customers', num(o.customers), `${o.openDemands} open demands`],
    ['Inventory units', num(o.inventoryUnits), 'on hand'],
    ['Base currency', o.baseCurrency, 'normalised pricing'],
  ];
  const oppRows = (d.opportunities || []).map((x) => `
    <tr data-pid="${x.productId}" style="cursor:pointer">
      <td>${esc((x.displayName || '').slice(0, 46))}<div class="muted small">${esc(x.category || '')} · ${x.sizeMl ? x.sizeMl + 'ml' : ''}</div></td>
      <td class="num"><span class="badge good">${esc(x.bestSupplier)}</span> ${money(x.bestPrice)}</td>
      <td class="num">${esc(x.worstSupplier)} ${money(x.worstPrice)}</td>
      <td class="num best">${pct(x.savingPct)}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">No cross-supplier opportunities yet.</td></tr>';
  const reviewRows = (d.reviewItems || []).slice(0, 6).map((x) => `
    <tr data-pid="${x.productId}" style="cursor:pointer">
      <td>${esc((x.displayName || '').slice(0, 40))}</td>
      <td class="num">${esc(x.bestSupplier)} ${money(x.bestPrice)}</td>
      <td class="num">${esc(x.worstSupplier)} ${money(x.worstPrice)}</td>
      <td class="num"><span class="badge warn">${pct(x.savingPct)}</span></td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing to review.</td></tr>';
  const winsBars = wins.map(([k, v]) => `
    <div class="row" style="align-items:center;gap:10px;margin-bottom:6px">
      <div style="width:90px" class="small">${esc(k)}</div>
      <div class="progress" style="flex:1"><i style="width:${(v / maxWin) * 100}%"></i></div>
      <div class="small num" style="width:50px">${v}</div>
    </div>`).join('');

  $('#view').innerHTML = `
    <div class="grid cards">${cards.map((c) => `<div class="card"><div class="k">${esc(c[0])}</div><div class="v">${esc(c[1])}</div><div class="s">${esc(c[2])}</div></div>`).join('')}</div>
    <div class="split" style="margin-top:16px">
      <div>
        <div class="panel">
          <h2>Cross-supplier opportunities <span class="muted small">— cheapest vs dearest for the same barcode</span></h2>
          <div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Best</th><th class="num">Dearest</th><th class="num">Saving</th></tr></thead><tbody>${oppRows}</tbody></table></div>
        </div>
        <div class="panel" style="margin-top:16px">
          <h2>Needs review <span class="muted small">— implausible spread, likely a price-basis mismatch</span></h2>
          <div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Best</th><th class="num">Dearest</th><th class="num">Spread</th></tr></thead><tbody>${reviewRows}</tbody></table></div>
        </div>
      </div>
      <div class="panel">
        <h2>Cheapest-supplier wins</h2>
        ${winsBars || '<div class="muted small">No overlaps.</div>'}
        <hr style="border-color:var(--border);margin:14px 0">
        <h2>Exception types</h2>
        ${(o.exceptionsByType || []).map((e) => `<div class="row" style="justify-content:space-between"><span class="small">${esc(e.type.replace('_', ' '))}</span><span class="badge warn">${e.n}</span></div>`).join('') || '<div class="muted small">None</div>'}
      </div>
    </div>`;
  $$('#view tr[data-pid]').forEach((tr) => tr.addEventListener('click', () => openCompare(Number(tr.dataset.pid))));
};

routes.imports = async () => {
  const uploads = await GET('/uploads');
  const supOpts = state.suppliers.map((s) => `<option value="${esc(s.code)}">${esc(s.name)} (${esc(s.code)})</option>`).join('');
  $('#view').innerHTML = `
    <div class="split">
      <div class="panel">
        <h2>Uploads</h2>
        <div class="table-wrap"><table><thead><tr><th>File</th><th>Supplier</th><th>Sheet</th><th class="num">Rows</th><th class="num">Matched</th><th class="num">Blank</th><th class="num">Invalid</th><th>Date</th></tr></thead><tbody>
        ${uploads.map((u) => `<tr><td class="mono">${esc(u.filename)}</td><td>${esc(u.supplier_code)}</td><td class="small">${esc(u.sheet || '')}</td><td class="num">${u.rows_total}</td><td class="num">${u.rows_imported}</td><td class="num">${u.rows_blank_barcode}</td><td class="num">${u.rows_invalid_barcode}</td><td class="small">${dt(u.uploaded_at)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No uploads yet.</td></tr>'}
        </tbody></table></div>
      </div>
      <div>
        <div class="panel">
          <h2>Import a price list</h2>
          <div class="field" style="margin-bottom:10px"><label>Supplier</label>
            <select id="impSupplier"><option value="">Auto-detect from file</option>${supOpts}</select></div>
          <div class="field" style="margin-bottom:10px"><label>File (xls / xlsx)</label>
            <input type="file" id="impFile" accept=".xls,.xlsx" /></div>
          <div class="field" style="margin-bottom:10px"><label>…or server-side path</label>
            <input id="impPath" placeholder="C:\\path\\to\\list.xlsx" /></div>
          <div class="field" style="margin-bottom:10px"><label>List date</label>
            <input type="date" id="impDate" /></div>
          <button id="impGo">Import</button>
          <div id="impResult" style="margin-top:12px"></div>
        </div>
        <div class="panel" style="margin-top:16px">
          <h2>How normalization works</h2>
          <ul class="small muted" style="margin:0;padding-left:18px">
            <li>Barcodes validated (GS1 check digit) and canonicalised to GTIN-14.</li>
            <li>Unit vs case prices normalised to a per-bottle figure.</li>
            <li>RRP converted to cost with the supplier's trade discount.</li>
            <li>Non-USD prices converted via FX rates in Settings.</li>
            <li>Re-importing an identical file is ignored (dedupe by hash).</li>
          </ul>
        </div>
      </div>
    </div>`;

  $('#impGo').addEventListener('click', async () => {
    const file = $('#impFile').files[0];
    const path = $('#impPath').value.trim();
    const supplierCode = $('#impSupplier').value;
    const listDate = $('#impDate').value;
    if (!file && !path) return toast('Choose a file or enter a path.', 'err');
    const fd = new FormData();
    if (file) fd.append('file', file);
    if (path) fd.append('path', path);
    if (supplierCode) fd.append('supplierCode', supplierCode);
    if (listDate) fd.append('listDate', listDate);
    $('#impResult').innerHTML = '<div class="muted small">Importing…</div>';
    try {
      const r = await api('POST', '/import', fd, true);
      if (r.duplicate) {
        $('#impResult').innerHTML = `<div class="badge warn">Duplicate file — already imported (upload #${r.upload.id})</div>`;
      } else {
        $('#impResult').innerHTML = `<div class="badge good">Imported ${r.imported} offers</div>
          <div class="kpi-inline" style="margin-top:10px">
            <div class="item"><div class="k">matched</div><div class="v">${r.matched}</div></div>
            <div class="item"><div class="k">blank barcode</div><div class="v">${r.blankBarcode}</div></div>
            <div class="item"><div class="k">invalid</div><div class="v">${r.invalidBarcode}</div></div>
            <div class="item"><div class="k">duplicates</div><div class="v">${r.duplicates}</div></div>
          </div>`;
      }
      toast('Import complete', 'ok');
      await loadSettings();
      render();
    } catch (e) {
      $('#impResult').innerHTML = '';
      toast(e.message, 'err');
    }
  });
};

routes.offers = async () => {
  const params = state._offerFilter || (state._offerFilter = { limit: 40, offset: 0 });
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== '' && v != null) qs.set(k, v); });
  const data = await GET('/offers?' + qs.toString());
  const cats = await GET('/categories');
  const supOpts = state.suppliers.map((s) => `<option value="${esc(s.code)}" ${params.supplier === s.code ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const catOpts = cats.slice(0, 60).map((c) => `<option value="${esc(c.category)}" ${params.category === c.category ? 'selected' : ''}>${esc(c.category)} (${c.n})</option>`).join('');
  $('#view').innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        <input id="ofQ" placeholder="Search description / barcode / SKU" value="${esc(params.q || '')}" style="min-width:260px" />
        <select id="ofSupplier"><option value="">All suppliers</option>${supOpts}</select>
        <select id="ofStatus"><option value="">All status</option>${['matched', 'exception', 'new'].map((s) => `<option ${params.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <select id="ofCategory"><option value="">All categories</option>${catOpts}</select>
        <button id="ofGo" class="sm">Apply</button>
        <span class="spacer"></span>
        <span class="muted small">${num(data.total)} offers</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Supplier</th><th>Barcode</th><th>Product</th><th>Cat</th><th class="num">Size</th><th class="num">Price</th><th>Basis</th><th>Status</th></tr></thead>
        <tbody>${data.rows.map((o) => `
          <tr>
            <td><span class="badge info">${esc(o.supplier_code)}</span></td>
            <td class="mono">${esc(o.gtin_source || '')} ${o.gtin_valid ? '' : '<span class="badge bad">!</span>'}</td>
            <td>${esc((o.description || '').slice(0, 52))}</td>
            <td class="small muted">${esc(o.category || '')}</td>
            <td class="num">${o.size_ml ? num(o.size_ml) + 'ml' : '—'}</td>
            <td class="num pill-price">${money(o.price, o.currency)}</td>
            <td class="small">${esc(o.price_basis || '')}${o.units_per_case ? ' ×' + o.units_per_case : ''}</td>
            <td>${o.status === 'exception' ? '<span class="badge warn">exception</span>' : (o.status === 'matched' ? '<span class="badge good">matched</span>' : '<span class="badge muted">new</span>')}</td>
          </tr>`).join('') || '<tr><td colspan="8" class="muted">No offers.</td></tr>'}
        </tbody>
      </table></div>
      <div class="row" style="margin-top:12px">
        <button class="ghost sm" id="ofPrev" ${params.offset <= 0 ? 'disabled' : ''}>‹ Prev</button>
        <span class="muted small">${params.offset + 1}–${Math.min(params.offset + params.limit, data.total)} of ${num(data.total)}</span>
        <button class="ghost sm" id="ofNext" ${params.offset + params.limit >= data.total ? 'disabled' : ''}>Next ›</button>
      </div>
    </div>`;
  const apply = () => { params.q = $('#ofQ').value.trim(); params.supplier = $('#ofSupplier').value; params.status = $('#ofStatus').value; params.category = $('#ofCategory').value; params.offset = 0; render(); };
  $('#ofGo').addEventListener('click', apply);
  $('#ofQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  $('#ofPrev').addEventListener('click', () => { params.offset = Math.max(0, params.offset - params.limit); render(); });
  $('#ofNext').addEventListener('click', () => { params.offset += params.limit; render(); });
};

routes.products = async () => {
  const q = state._prodQ || '';
  const multi = state._prodMulti ? '1' : '';
  const data = await GET(`/products?limit=60&q=${encodeURIComponent(q)}&multi=${multi}`);
  $('#view').innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        <input id="pdQ" placeholder="Search product / barcode / category" value="${esc(q)}" style="min-width:280px" />
        <label class="row small"><input type="checkbox" id="pdMulti" ${multi ? 'checked' : ''} style="width:auto" /> Only multi-supplier</label>
        <button id="pdGo" class="sm">Search</button>
        <span class="spacer"></span>
        <span class="muted small">${num(data.total)} products</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Product</th><th>GTIN</th><th>Category</th><th class="num">Size</th><th class="num">Offers</th><th class="num">Suppliers</th><th></th></tr></thead>
        <tbody>${data.rows.map((p) => `
          <tr>
            <td>${esc((p.display_name || '(no name)').slice(0, 50))}</td>
            <td class="mono">${esc(p.canonical_gtin || '—')}</td>
            <td class="small muted">${esc(p.category || '')}</td>
            <td class="num">${p.size_ml ? num(p.size_ml) + 'ml' : '—'}</td>
            <td class="num">${p.offer_count}</td>
            <td class="num">${p.supplier_count > 1 ? `<span class="badge good">${p.supplier_count}</span>` : p.supplier_count}</td>
            <td><button class="sm ghost" data-cmp="${p.id}">Compare</button></td>
          </tr>`).join('') || '<tr><td colspan="7" class="muted">No products.</td></tr>'}
        </tbody>
      </table></div>
    </div>`;
  const run = () => { state._prodQ = $('#pdQ').value.trim(); state._prodMulti = $('#pdMulti').checked; render(); };
  $('#pdGo').addEventListener('click', run);
  $('#pdQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  $$('#view [data-cmp]').forEach((b) => b.addEventListener('click', () => openCompare(Number(b.dataset.cmp))));
};

routes.exceptions = async () => {
  const resolved = state._excResolved ? 1 : 0;
  const rows = await GET('/exceptions?resolved=' + resolved);
  $('#view').innerHTML = `
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        <h2 style="margin:0">Exceptions</h2>
        <label class="row small"><input type="checkbox" id="exRes" ${resolved ? 'checked' : ''} style="width:auto" /> show resolved</label>
        <span class="spacer"></span><span class="muted small">${rows.length} shown</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Type</th><th>Supplier</th><th>Row</th><th>Barcode</th><th>Detail</th><th></th></tr></thead>
        <tbody>${rows.map((e) => `
          <tr>
            <td><span class="badge ${e.type === 'invalid_barcode' ? 'bad' : 'warn'}">${esc(e.type.replace('_', ' '))}</span></td>
            <td>${esc(e.supplier_code || '')}</td>
            <td class="num">${e.source_row || ''}</td>
            <td class="mono">${esc(e.gtin_source || '')}</td>
            <td class="small">${esc(e.detail || '')}</td>
            <td>${e.resolved ? '<span class="badge muted">resolved</span>' : `<button class="sm ghost" data-res="${e.id}">Resolve</button>`}</td>
          </tr>`).join('') || '<tr><td colspan="6" class="muted">No exceptions.</td></tr>'}
        </tbody>
      </table></div>
    </div>`;
  $('#exRes').addEventListener('change', (e) => { state._excResolved = e.target.checked; render(); });
  $$('#view [data-res]').forEach((b) => b.addEventListener('click', async () => {
    try { await POST('/exceptions/' + b.dataset.res + '/resolve', { actor: 'user' }); toast('Resolved', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  }));
};

routes.compare = async () => {
  $('#view').innerHTML = `
    <div class="panel">
      <h2>Look up by barcode</h2>
      <div class="row"><input id="cmpGtin" placeholder="Scan or type EAN / UPC / GTIN" style="min-width:280px" class="mono" />
      <button id="cmpGo">Find cheapest</button></div>
      <div id="cmpOut" style="margin-top:16px"></div>
    </div>`;
  $('#cmpGo').addEventListener('click', async () => {
    const g = $('#cmpGtin').value.trim();
    if (!g) return;
    try {
      const r = await GET('/compare?gtin=' + encodeURIComponent(g));
      renderCompareResult($('#cmpOut'), r);
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#cmpGtin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#cmpGo').click(); });
};

function renderCompareResult(el, r) {
  if (!r.found) {
    el.innerHTML = `<div class="badge bad">Not found</div><div class="small muted" style="margin-top:8px">Barcode ${esc(r.query)} → ${esc(r.analysis.type)} ${r.analysis.valid ? 'valid' : 'invalid check digit'}</div>`;
    return;
  }
  el.innerHTML = `
    <div class="panel" style="background:var(--panel-2)">
      <div style="font-weight:700;font-size:15px">${esc(r.product.display_name || '')}</div>
      <div class="muted small mono">${esc(r.product.canonical_gtin || '')} · ${esc(r.product.category || '')} · ${r.product.size_ml ? r.product.size_ml + 'ml' : ''}</div>
      <div class="kpi-inline" style="margin-top:12px">
        <div class="item"><div class="k">Best cost / bottle</div><div class="v best">${money(r.best ? r.best.perBottleBase : null, r.baseCurrency)}</div></div>
        <div class="item"><div class="k">Best supplier</div><div class="v">${esc(r.best ? r.best.supplier : '—')}</div></div>
        <div class="item"><div class="k">Spread</div><div class="v">${money(r.savingsPerBottle, r.baseCurrency)} (${pct(r.savingsPct)})</div></div>
      </div>
      ${r.comparabilityWarning ? `<div class="badge warn" style="margin-top:10px">${esc(r.comparabilityWarning)}</div>` : ''}
    </div>
    <div class="table-wrap" style="margin-top:12px"><table>
      <thead><tr><th>Supplier</th><th>Description</th><th class="num">Quoted</th><th>Basis</th><th class="num">Per bottle (${esc(r.baseCurrency)})</th><th>Flags</th></tr></thead>
      <tbody>${r.offers.map((o) => `
        <tr ${r.best && o.offerId === r.best.offerId ? 'style="background:rgba(79,206,155,.08)"' : ''} ${o.isRetail ? 'class="muted"' : ''}>
          <td><span class="badge ${o.isRetail ? 'muted' : 'info'}">${esc(o.supplier)}</span></td>
          <td class="small">${esc((o.description || '').slice(0, 48))}</td>
          <td class="num">${money(o.price, o.currency)}</td>
          <td class="small">${esc(o.priceBasis)}${o.unitsPerCase && o.priceBasis === 'case' ? ' ×' + o.unitsPerCase : ''}</td>
          <td class="num pill-price ${r.best && o.offerId === r.best.offerId ? 'best' : ''}">${money(o.perBottleBase)}</td>
          <td>${badgeList(o.flags)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

async function openCompare(productId) {
  try {
    const r = await GET(`/products/${productId}/compare`);
    modal('Price comparison', `<div id="cmpModalOut"></div>`, (bg) => renderCompareResult(bg.querySelector('#cmpModalOut'), { found: true, ...r }));
  } catch (e) { toast(e.message, 'err'); }
}

/* ================= lowest executable landed cost (Q1) ================= */
const LANDING_FLAGS = {
  'tier-applied': ['info', 'quantity tier applied'],
  'below-moq': ['bad', 'below MOQ'],
  'not-order-multiple': ['bad', 'not an order multiple'],
  'insufficient-stock': ['bad', 'insufficient stock'],
  'expired': ['bad', 'offer expired'],
  'not-eligible': ['bad', 'not permitted to destination'],
  'retail-price': ['bad', 'retail (not cost)'],
  'incomplete-cost': ['warn', 'missing cost inputs'],
  'availability-unit-unknown': ['warn', 'stock unit unknown'],
  'incoterm-unknown': ['warn', 'Incoterm unknown'],
  'no-price': ['bad', 'no price'],
};
function landingFlags(flags) {
  return (flags || []).map((f) => { const [k, l] = LANDING_FLAGS[f] || ['muted', f]; return `<span class="badge ${k}">${esc(l)}</span>`; }).join(' ');
}
const COMP_LABELS = { freight: 'Freight', insurance: 'Insurance', duty: 'Duty', brokerage: 'Brokerage', handling: 'Handling', otherTaxes: 'Other taxes' };
const SOURCE_LABELS = { included: 'incl.', supplier: 'supplier', setting: 'default', missing: 'assumed 0' };
function sourceBadge(source) {
  const k = source === 'included' ? 'good' : source === 'missing' ? 'warn' : 'info';
  return `<span class="badge ${k}">${esc(SOURCE_LABELS[source] || source)}</span>`;
}

function renderLowestResult(el, r) {
  const cur = r.baseCurrency;
  if (!r.winner) {
    el.innerHTML = `<div class="badge bad">No executable offer</div>
      <div class="small muted" style="margin-top:8px">Every offer for this product is excluded at ${num(r.quantity)} units (MOQ, stock, expiry, eligibility or retail price). See the excluded list below.</div>
      ${renderExcluded(r)}`;
    return;
  }
  const w = r.winner;
  const comps = Object.entries(w.components).map(([k, c]) => `
    <div class="row" style="justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">
      <span class="small">${esc(COMP_LABELS[k] || k)} ${sourceBadge(c.source)}</span>
      <span class="num small">${money(c.value, cur)}</span>
    </div>`).join('');
  el.innerHTML = `
    <div class="panel" style="background:var(--panel-2);border-color:var(--good)">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-weight:700;font-size:15px">${esc(r.product.display_name || '(no name)')}</div>
          <div class="muted small mono">${esc(r.product.canonical_gtin || '')} · ${esc(r.product.category || '')} · ${r.product.size_ml ? r.product.size_ml + 'ml' : ''}</div>
        </div>
        <span class="badge good">Lowest landed cost</span>
      </div>
      <div class="kpi-inline" style="margin-top:12px">
        <div class="item"><div class="k">Best supplier</div><div class="v best">${esc(w.supplierName || w.supplier)}</div></div>
        <div class="item"><div class="k">Landed / bottle</div><div class="v best">${money(w.landedUnitCost, cur)}</div></div>
        <div class="item"><div class="k">Total (${num(r.quantity)} u)</div><div class="v">${money(w.totalCost, cur)}</div></div>
        <div class="item"><div class="k">Purchase / bottle</div><div class="v">${money(w.purchaseUSD, cur)}</div></div>
        <div class="item"><div class="k">Incoterm</div><div class="v">${esc(w.incoterm || '—')}</div></div>
        <div class="item"><div class="k">Savings vs next</div><div class="v">${money(r.savingsVsNext, cur)}</div></div>
      </div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:6px">${landingFlags(w.flags)}${w.complete ? '<span class="badge good">cost complete</span>' : `<span class="badge warn">assumed: ${esc(w.missing.join(', '))}</span>`}</div>
      <div style="margin-top:12px;max-width:420px"><div class="muted small" style="margin-bottom:4px">Cost build-up per bottle (${esc(cur)})</div>${comps}</div>
      ${r.warnings.length ? `<div class="small muted" style="margin-top:10px">${r.warnings.map((x) => '• ' + esc(x)).join('<br>')}</div>` : ''}
    </div>
    <div class="table-wrap" style="margin-top:14px"><table>
      <thead><tr><th class="num">#</th><th>Supplier</th><th>Incoterm</th><th class="num">Purchase / bottle</th><th class="num">Landed / bottle</th><th class="num">Total</th><th>Cost</th><th>Flags</th></tr></thead>
      <tbody>${r.ranked.map((o, i) => `
        <tr style="${i === 0 ? 'background:rgba(79,206,155,.08)' : ''}">
          <td class="num">${i + 1}</td>
          <td><span class="badge ${i === 0 ? 'good' : 'info'}">${esc(o.supplier)}</span></td>
          <td class="small">${esc(o.incoterm || '—')}</td>
          <td class="num">${money(o.purchaseUSD, cur)}</td>
          <td class="num pill-price ${i === 0 ? 'best' : ''}">${money(o.landedUnitCost, cur)}</td>
          <td class="num">${money(o.totalCost, cur)}</td>
          <td class="small">${o.complete ? '<span class="badge good">complete</span>' : `<span class="badge warn">${esc(o.missing.join(', '))}</span>`}</td>
          <td>${landingFlags(o.flags)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    ${renderExcluded(r)}`;
}

function renderExcluded(r) {
  if (!r.excluded.length) return '';
  return `
    <div class="panel" style="margin-top:14px">
      <h2>Excluded from ranking <span class="muted small">— not executable for this order</span></h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Supplier</th><th>Description</th><th class="num">Landed / bottle</th><th>Reason</th></tr></thead>
        <tbody>${r.excluded.map((o) => `
          <tr class="muted"><td><span class="badge muted">${esc(o.supplier)}</span></td>
          <td class="small">${esc((o.description || '').slice(0, 46))}</td>
          <td class="num">${money(o.landedUnitCost, r.baseCurrency)}</td>
          <td>${landingFlags(o.flags)}</td></tr>`).join('')}
        </tbody>
      </table></div>
    </div>`;
}

routes.lowest = async () => {
  const base = state.settings.base_currency || 'USD';
  const dest = state.settings.dest_market || 'US';
  $('#view').innerHTML = `
    <div class="panel">
      <h2>Lowest executable landed cost <span class="muted small">— exact SKU + quantity, delivered to your destination</span></h2>
      <div class="row" style="align-items:flex-start;gap:14px;flex-wrap:wrap">
        <div style="position:relative;min-width:320px;flex:1" data-pp>
          <label class="small muted">Product</label>
          <input data-pp-input placeholder="Search product by name or barcode" style="width:100%" />
          <input type="hidden" data-pp-id />
          <div data-pp-results style="margin-top:6px"></div>
        </div>
        <div><label class="small muted">Quantity</label><input id="lqQty" type="number" min="1" value="12" style="width:100px" /></div>
        <div><label class="small muted">Destination</label><input id="lqDest" value="${esc(dest)}" style="width:80px" /></div>
        <div><label class="small muted">Base currency</label><input id="lqBase" value="${esc(base)}" style="width:80px" /></div>
        <button id="lqGo" style="margin-top:16px">Find lowest</button>
      </div>
    </div>
    <div id="lqOut" style="margin-top:16px"></div>`;
  const run = async (pid) => {
    const out = $('#lqOut');
    out.innerHTML = '<div class="muted">Working…</div>';
    try {
      const r = await GET(`/sourcing/lowest?productId=${pid}&quantity=${encodeURIComponent($('#lqQty').value)}&destination=${encodeURIComponent($('#lqDest').value)}&base=${encodeURIComponent($('#lqBase').value)}`);
      renderLowestResult(out, r);
    } catch (e) { out.innerHTML = `<div class="panel"><span class="badge bad">Error</span> ${esc(e.message)}</div>`; }
  };
  mountProductPicker($('#view'), (id) => run(id));
  $('#lqGo').addEventListener('click', () => {
    const pid = $('[data-pp-id]', $('#view')).value;
    if (!pid) return toast('Pick a product first', 'err');
    run(Number(pid));
  });
};

routes.pricing = async () => {
  const customers = await GET('/customers').catch(() => []);
  const today = new Date().toISOString().slice(0, 10);
  $('#view').innerHTML = `
    <div class="split">
      <div class="panel">
        <h2>Deal calculator <span class="muted small">— contribution, capital &amp; cash flow</span></h2>
        <div class="field" style="margin-bottom:10px"><label>Buy from product</label>
          <div data-pp><input data-pp-input placeholder="search product…" /><input type="hidden" data-pp-id /><div data-pp-results style="margin-top:6px;max-height:170px;overflow:auto"></div></div>
        </div>
        <div class="field" style="margin-bottom:10px"><label>Supplier offer</label><select id="dcOffer"><option value="">— manual landed cost —</option></select></div>
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:12px">
          <div class="field"><label>Landed unit cost (manual)</label><input id="dcLanded" type="number" step="0.01" value="49" /></div>
          <div class="field"><label>Selling unit price</label><input id="dcSell" type="number" step="0.01" value="70" /></div>
          <div class="field"><label>Quantity</label><input id="dcQty" type="number" value="100" /></div>
          <div class="field"><label>Discount %</label><input id="dcDisc" type="number" step="0.1" value="0" /></div>
          <div class="field"><label>Customer</label><select id="dcCustomer"><option value="">— none —</option>${customers.map((c) => `<option value="${c.id}">${esc(c.name)}${c.payment_terms ? ' (' + esc(c.payment_terms) + ')' : ''}</option>`).join('')}</select></div>
          <div class="field"><label>Order date</label><input id="dcDate" type="date" value="${today}" /></div>
          <div class="field"><label>Supplier pay days</label><input id="dcSupDays" type="number" placeholder="from terms" /></div>
          <div class="field"><label>Customer pay days</label><input id="dcCusDays" type="number" placeholder="from customer" /></div>
        </div>
        <div class="row" style="margin-top:14px"><button id="dcGo">Calculate</button><button id="dcSave" class="ghost">Save deal</button></div>
      </div>
      <div class="panel" id="dcOut"><div class="muted small">Pick an offer (or enter a landed cost), then Calculate.</div></div>
    </div>`;

  const numOrU = (v) => (v === '' || v == null ? undefined : Number(v));
  mountProductPicker($('#view'), async (pid) => {
    try {
      const r = await GET(`/products/${pid}/compare`);
      const offers = (r.offers || []).filter((o) => !o.isRetail && o.perBottleBase != null);
      $('#dcOffer').innerHTML = `<option value="">— manual landed cost —</option>` + offers.map((o) =>
        `<option value="${o.offerId}" data-rrp="${o.rrp || ''}" data-landed="${o.perBottleBase}">${esc(o.supplier)} · ${money(o.perBottleBase)} / bottle${o.incoterm ? ' · ' + esc(o.incoterm) : ''}</option>`
      ).join('');
      if (offers[0]) { $('#dcOffer').value = String(offers[0].offerId); if (offers[0].rrp) $('#dcSell').value = offers[0].rrp; }
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#dcOffer').addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    if (opt && opt.dataset.landed) $('#dcLanded').value = opt.dataset.landed;
    if (opt && opt.dataset.rrp) $('#dcSell').value = opt.dataset.rrp;
  });
  const collect = () => ({
    offerId: $('#dcOffer').value ? Number($('#dcOffer').value) : undefined,
    landedUnitCost: $('#dcOffer').value ? undefined : numOrU($('#dcLanded').value),
    productId: $('[data-pp-id]', $('#view')).value ? Number($('[data-pp-id]', $('#view')).value) : undefined,
    customerId: $('#dcCustomer').value ? Number($('#dcCustomer').value) : undefined,
    quantity: Number($('#dcQty').value),
    sellingUnitPrice: Number($('#dcSell').value),
    discountPct: Number($('#dcDisc').value),
    supplierPayDays: numOrU($('#dcSupDays').value),
    customerPayDays: numOrU($('#dcCusDays').value),
    orderDate: $('#dcDate').value || undefined,
  });
  $('#dcGo').addEventListener('click', async () => {
    try { const r = await POST('/deals/compute', collect()); renderDealResult($('#dcOut'), r); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#dcSave').addEventListener('click', async () => {
    if (!can('buyer')) return toast('Buyer role required to save', 'err');
    const body = collect();
    if (!body.customerId) return toast('Pick a customer first', 'err');
    if (!body.productId && !body.offerId) return toast('Pick an offer or product', 'err');
    try { const r = await POST('/deals', body); toast('Deal saved (quote #' + r.id + ')', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  });
};

function renderDealResult(el, r) {
  if (!r.found) { el.innerHTML = `<div class="badge bad">${esc(r.error || 'not found')}</div>`; return; }
  const m = r.deal.metrics;
  const cf = r.deal.cashflow;
  const ok = m.passesPolicy;
  const landedLines = r.landed ? [
    ['Purchase / bottle', money(r.landed.purchaseUSD, r.baseCurrency)],
    ['Freight', money(r.landed.components.freight.value, r.baseCurrency)],
    ['Insurance', money(r.landed.components.insurance.value, r.baseCurrency)],
    ['Duty', money(r.landed.components.duty.value, r.baseCurrency)],
    ['Brokerage', money(r.landed.components.brokerage.value, r.baseCurrency)],
    ['Handling', money(r.landed.components.handling.value, r.baseCurrency)],
    ['Landed / bottle', `<b>${money(r.landed.landedUnitCost, r.baseCurrency)}</b>`],
  ] : [];
  el.innerHTML = `
    <h2>Deal result <span class="badge ${ok ? 'good' : 'bad'}">${ok ? 'meets policy' : 'below policy'}</span></h2>
    <div class="kpi-inline" style="margin-bottom:14px">
      <div class="item"><div class="k">Margin %</div><div class="v ${m.marginPct >= 15 ? 'best' : ''}">${pct(m.marginPct)}</div></div>
      <div class="item"><div class="k">Markup / unit</div><div class="v">${money(m.markup, r.baseCurrency)}</div></div>
      <div class="item"><div class="k">Contribution</div><div class="v best">${money(r.deal.contribution.total, r.baseCurrency)}</div></div>
      <div class="item"><div class="k">ROI %</div><div class="v">${pct(m.roiPct)}</div></div>
      <div class="item"><div class="k">Annualised ROI</div><div class="v">${cf.annualisedRoiPct != null ? pct(cf.annualisedRoiPct) : '—'}</div></div>
      <div class="item"><div class="k">Capital required</div><div class="v">${money(cf.peakCapital, r.baseCurrency)}</div></div>
      <div class="item"><div class="k">Capital days</div><div class="v">${num(cf.capitalDays)}</div></div>
    </div>
    <div class="muted small">Sell ${money(r.selling.sellingUnitPrice, r.baseCurrency)} · qty ${num(r.quantity)} · net revenue ${money(m.netUnitRevenue, r.baseCurrency)}/u · revenue ${money(m.revenueTotal, r.baseCurrency)} · cost ${money(m.costTotal, r.baseCurrency)}${r.selling.discountOffRrpPct != null ? ' · discount off RRP ' + pct(r.selling.discountOffRrpPct) : ''}${cf.negativeWorkingCapital ? ' · <span class="badge good">negative working capital</span>' : ''}</div>
    <div class="split" style="margin-top:14px">
      <div>
        <h2 style="font-size:13px">Dated cash flow</h2>
        <table><thead><tr><th>Date</th><th>Event</th><th class="num">Amount</th><th class="num">Balance</th></tr></thead>
        <tbody>${cf.schedule.map((e) => `<tr><td class="small">${esc(e.date)}</td><td class="small">${esc(e.label)}</td><td class="num ${e.amount < 0 ? 'muted' : ''}">${money(e.amount, r.baseCurrency)}</td><td class="num">${money(e.balance, r.baseCurrency)}</td></tr>`).join('')}</tbody></table>
      </div>
      ${landedLines.length ? `<div><h2 style="font-size:13px">Landed cost (${esc(r.landed.incoterm || '—')})</h2><table>${landedLines.map((l) => `<tr><td class="muted">${l[0]}</td><td class="num">${l[1]}</td></tr>`).join('')}</table>${r.landed.complete ? '' : `<div class="badge warn" style="margin-top:8px">assumed: ${esc(r.landed.missing.join(', '))}</div>`}</div>` : ''}
    </div>`;
}

routes.inventory = async () => {
  const d = await GET('/inventory');
  $('#view').innerHTML = `
    <div class="grid cards" style="margin-bottom:16px">
      <div class="card"><div class="k">On hand</div><div class="v">${num(d.totals.on_hand)}</div></div>
      <div class="card"><div class="k">Reserved</div><div class="v">${num(d.totals.reserved)}</div></div>
      <div class="card"><div class="k">In transit</div><div class="v">${num(d.totals.in_transit)}</div></div>
      <div class="card"><div class="k">Quarantined</div><div class="v">${num(d.totals.quarantined)}</div></div>
    </div>
    <div class="split">
      <div class="panel"><h2>Lots</h2>
        <div class="table-wrap"><table><thead><tr><th>Product</th><th>Warehouse</th><th>Lot</th><th class="num">On hand</th><th class="num">Reserved</th><th class="num">In transit</th><th class="num">Unit cost</th><th>Expiry</th></tr></thead>
        <tbody>${d.rows.map((r) => `<tr><td>${esc((r.display_name || '').slice(0, 40))}</td><td>${esc(r.warehouse || '')}</td><td class="mono">${esc(r.lot_reference || '')}</td><td class="num">${num(r.on_hand)}</td><td class="num">${num(r.reserved)}</td><td class="num">${num(r.in_transit)}</td><td class="num">${money(r.unit_cost)}</td><td class="small">${esc(r.expiry_date || '')}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No inventory.</td></tr>'}
        </tbody></table></div>
      </div>
      <div class="panel"><h2>Add lot</h2>
        <div class="field" style="margin-bottom:8px"><label>Product</label>
          <div data-pp><input data-pp-input placeholder="search product…" /><input type="hidden" data-pp-id /><div data-pp-results style="margin-top:6px;max-height:220px;overflow:auto"></div></div></div>
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
          <div class="field"><label>Warehouse</label><input id="invWh" value="Madrid WH" /></div>
          <div class="field"><label>Lot ref</label><input id="invLot" /></div>
          <div class="field"><label>On hand</label><input id="invOh" type="number" value="0" /></div>
          <div class="field"><label>Unit cost</label><input id="invCost" type="number" step="0.01" /></div>
        </div>
        <button id="invAdd" style="margin-top:12px">Add lot</button>
      </div>
    </div>`;
  mountProductPicker($('#view'));
  $('#invAdd').addEventListener('click', async () => {
    const pid = $('#invId'); const hidden = $('[data-pp-id]', $('#view'));
    const productId = hidden.value;
    if (!productId) return toast('Pick a product', 'err');
    try {
      await POST('/inventory', { productId, warehouse: $('#invWh').value, lotReference: $('#invLot').value, onHand: Number($('#invOh').value), unitCost: Number($('#invCost').value) || null });
      toast('Lot added', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  });
};

routes.customers = async () => {
  const rows = await GET('/customers');
  $('#view').innerHTML = `
    <div class="split">
      <div class="panel"><h2>Customers</h2>
        <div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Region</th><th>Currency</th><th>Terms</th><th class="num">Credit limit</th><th>Status</th></tr></thead>
        <tbody>${rows.map((c) => `<tr><td class="mono">${esc(c.code || '')}</td><td>${esc(c.name)}</td><td>${esc(c.region || '')}</td><td>${esc(c.currency || '')}</td><td>${esc(c.payment_terms || '')}</td><td class="num">${money(c.credit_limit)}</td><td>${c.active ? '<span class="badge good">active</span>' : '<span class="badge muted">off</span>'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No customers.</td></tr>'}
        </tbody></table></div>
      </div>
      <div class="panel"><h2>Add customer</h2>
        <div class="field" style="margin-bottom:8px"><label>Name</label><input id="custName" /></div>
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
          <div class="field"><label>Code</label><input id="custCode" /></div>
          <div class="field"><label>Region</label><input id="custRegion" placeholder="US / EU / ME" /></div>
          <div class="field"><label>Currency</label><input id="custCurrency" value="USD" /></div>
          <div class="field"><label>Terms</label><input id="custTerms" placeholder="Net 30" /></div>
          <div class="field"><label>Credit limit</label><input id="custLimit" type="number" /></div>
        </div>
        <button id="custAdd" style="margin-top:12px">Add</button>
      </div>
    </div>`;
  $('#custAdd').addEventListener('click', async () => {
    if (!$('#custName').value.trim()) return toast('Name required', 'err');
    try {
      await POST('/customers', { name: $('#custName').value, code: $('#custCode').value, region: $('#custRegion').value, currency: $('#custCurrency').value, paymentTerms: $('#custTerms').value, creditLimit: Number($('#custLimit').value) || null });
      toast('Customer added', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  });
};

async function loadCustomers() { return GET('/customers'); }

routes.demands = async () => {
  const rows = await GET('/demands');
  const customers = await loadCustomers();
  $('#view').innerHTML = `
    <div class="split">
      <div class="panel"><h2>Demand book</h2>
        <div class="table-wrap"><table><thead><tr><th>Customer</th><th>Product</th><th class="num">Qty</th><th>Status</th><th>Needed by</th><th>Approved</th></tr></thead>
        <tbody>${rows.map((d) => `<tr><td>${esc(d.customer_name)}</td><td>${esc((d.display_name || '').slice(0, 40))}</td><td class="num">${num(d.quantity)}</td><td><span class="badge info">${esc(d.status)}</span></td><td class="small">${esc(d.needed_by || '')}</td><td>${d.approved ? '<span class="badge good">yes</span>' : '<span class="badge muted">no</span>'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No demands.</td></tr>'}
        </tbody></table></div>
      </div>
      <div class="panel"><h2>Add demand</h2>
        <div class="field" style="margin-bottom:8px"><label>Customer</label><select id="dmCust">${customers.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field" style="margin-bottom:8px"><label>Product</label>
          <div data-pp><input data-pp-input placeholder="search product…" /><input type="hidden" data-pp-id /><div data-pp-results style="margin-top:6px;max-height:180px;overflow:auto"></div></div></div>
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
          <div class="field"><label>Quantity</label><input id="dmQty" type="number" value="100" /></div>
          <div class="field"><label>Target price</label><input id="dmTarget" type="number" step="0.01" /></div>
        </div>
        <button id="dmAdd" style="margin-top:12px">Add demand</button>
      </div>
    </div>`;
  mountProductPicker($('#view'));
  $('#dmAdd').addEventListener('click', async () => {
    const productId = $('[data-pp-id]', $('#view')).value;
    if (!productId) return toast('Pick a product', 'err');
    try {
      await POST('/demands', { customerId: Number($('#dmCust').value), productId, quantity: Number($('#dmQty').value), targetPrice: Number($('#dmTarget').value) || null });
      toast('Demand added', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  });
};

routes.quotes = async () => {
  const rows = await GET('/quotes');
  const customers = await loadCustomers();
  $('#view').innerHTML = `
    <div class="split">
      <div class="panel"><h2>Deals &amp; quotes</h2>
        <div class="table-wrap"><table><thead><tr><th>Customer</th><th>Product</th><th>Supplier</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Margin</th><th class="num">Contribution</th><th class="num">ROI</th><th class="num">Capital</th><th>Cus due</th><th>Status</th></tr></thead>
        <tbody>${rows.map((q) => `<tr><td>${esc(q.customer_name)}</td><td>${esc((q.display_name || '').slice(0, 30))}</td><td>${q.supplier_code ? `<span class="badge info">${esc(q.supplier_code)}</span>` : '—'}</td><td class="num">${num(q.quantity)}</td><td class="num">${money(q.unit_price, q.currency)}</td><td class="num">${q.margin_pct != null ? `<span class="badge ${q.margin_pct >= 15 ? 'good' : 'bad'}">${pct(q.margin_pct)}</span>` : '—'}</td><td class="num">${q.contribution_total != null ? money(q.contribution_total, q.currency) : '—'}</td><td class="num">${q.roi_pct != null ? pct(q.roi_pct) : '—'}</td><td class="num">${q.capital_required != null ? money(q.capital_required, q.currency) : '—'}</td><td class="small">${esc(q.customer_due_date || '')}</td><td><span class="badge info">${esc(q.status)}</span></td></tr>`).join('') || '<tr><td colspan="11" class="muted">No deals yet.</td></tr>'}
        </tbody></table></div>
      </div>
      <div class="panel"><h2>Create quote</h2>
        <div class="field" style="margin-bottom:8px"><label>Customer</label><select id="qCust">${customers.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field" style="margin-bottom:8px"><label>Product</label>
          <div data-pp><input data-pp-input placeholder="search product…" /><input type="hidden" data-pp-id /><div data-pp-results style="margin-top:6px;max-height:170px;overflow:auto"></div></div></div>
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
          <div class="field"><label>Quantity</label><input id="qQty" type="number" value="100" /></div>
          <div class="field"><label>Unit price</label><input id="qPrice" type="number" step="0.01" /></div>
          <div class="field"><label>Landed unit cost</label><input id="qCost" type="number" step="0.01" /></div>
          <div class="field"><label>Validity</label><input id="qValid" type="date" /></div>
        </div>
        <button id="qAdd" style="margin-top:12px">Create quote</button>
        <div id="qOut" style="margin-top:10px"></div>
      </div>
    </div>`;
  mountProductPicker($('#view'));
  $('#qAdd').addEventListener('click', async () => {
    const productId = $('[data-pp-id]', $('#view')).value;
    if (!productId) return toast('Pick a product', 'err');
    try {
      const r = await POST('/quotes', { customerId: Number($('#qCust').value), productId, quantity: Number($('#qQty').value), unitPrice: Number($('#qPrice').value), landedUnitCost: Number($('#qCost').value) || null, validityDate: $('#qValid').value });
      $('#qOut').innerHTML = `<div class="badge ${r.marginPct >= 15 ? 'good' : 'bad'}">Created · margin ${pct(r.marginPct)}</div>`;
      toast('Quote created', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
};

routes.suppliers = async () => {
  const rows = await GET('/suppliers');
  $('#view').innerHTML = `<div class="panel"><h2>Suppliers &amp; commercial terms</h2>
    <div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Currency</th><th>Price type</th><th class="num">Trade disc %</th><th>Incoterm</th><th>Stock ctry</th><th>Origin</th><th class="num">Duty %</th><th class="num">Freight/u</th><th class="num">Ins %</th><th class="num">Brok/u</th><th class="num">Hand/u</th><th class="num">Other tax %</th><th></th></tr></thead>
    <tbody>${rows.map((s) => `
      <tr data-code="${esc(s.code)}">
        <td class="mono">${esc(s.code)}</td>
        <td><input data-f="name" value="${esc(s.name)}" style="width:120px" /></td>
        <td><input data-f="currency" value="${esc(s.currency)}" style="width:60px" /></td>
        <td><select data-f="price_type"><option value="cost" ${s.price_type === 'cost' ? 'selected' : ''}>cost</option><option value="rrp" ${s.price_type === 'rrp' ? 'selected' : ''}>rrp</option></select></td>
        <td class="num"><input data-f="default_discount_pct" type="number" value="${s.default_discount_pct || 0}" style="width:70px" /></td>
        <td><input data-f="incoterm" value="${esc(s.incoterm || '')}" style="width:80px" /></td>
        <td><input data-f="stock_country" value="${esc(s.stock_country || '')}" style="width:56px" /></td>
        <td><input data-f="originCountry" value="${esc(s.origin_country || '')}" style="width:56px" /></td>
        <td class="num"><input data-f="dutyPct" type="number" step="0.01" value="${s.duty_pct ?? ''}" style="width:64px" /></td>
        <td class="num"><input data-f="freightPerUnit" type="number" step="0.01" value="${s.freight_per_unit ?? ''}" style="width:64px" /></td>
        <td class="num"><input data-f="insurancePct" type="number" step="0.01" value="${s.insurance_pct ?? ''}" style="width:56px" /></td>
        <td class="num"><input data-f="brokeragePerUnit" type="number" step="0.01" value="${s.brokerage_per_unit ?? ''}" style="width:56px" /></td>
        <td class="num"><input data-f="handlingPerUnit" type="number" step="0.01" value="${s.handling_per_unit ?? ''}" style="width:56px" /></td>
        <td class="num"><input data-f="otherTaxPct" type="number" step="0.01" value="${s.other_tax_pct ?? ''}" style="width:64px" /></td>
        <td><button class="sm" data-save="${esc(s.code)}">Save</button></td>
      </tr>`).join('')}
    </tbody></table></div>
    <div class="muted small" style="margin-top:10px">Price type "rrp" means the supplier quotes retail; the trade discount converts it to our acquisition cost. Duty %, insurance % and other tax % are applied on the purchase cost; freight, brokerage and handling are per bottle. These feed the landed-cost engine (blank = unknown, shown as assumed).</div>
  </div>`;
  $$('#view [data-save]').forEach((b) => b.addEventListener('click', async () => {
    const tr = b.closest('tr');
    const body = {};
    $$('[data-f]', tr).forEach((i) => { body[i.dataset.f] = i.value; });
    body.defaultDiscount = body.default_discount_pct;
    body.priceType = body.price_type;
    body.stockCountry = body.stock_country;
    try { await POST('/suppliers/' + b.dataset.save, body); toast('Saved', 'ok'); await loadSettings(); }
    catch (e) { toast(e.message, 'err'); }
  }));
};

routes.settings = async () => {
  const s = await GET('/settings');
  const fx = await GET('/fx');
  $('#view').innerHTML = `
    <div class="split">
      <div class="panel"><h2>Platform settings</h2>
        ${Object.entries(s).map(([k, v]) => `<div class="field" style="margin-bottom:8px"><label>${esc(k)}</label><input data-k="${esc(k)}" value="${esc(v)}" /></div>`).join('')}
        <button id="setSave" style="margin-top:10px">Save settings</button>
      </div>
      <div class="panel"><h2>FX rates</h2>
        <div class="table-wrap"><table><thead><tr><th>Pair</th><th class="num">Rate</th><th>Date</th><th>Source</th></tr></thead>
        <tbody>${fx.map((r) => `<tr><td class="mono">${esc(r.base_currency)}→${esc(r.quote_currency)}</td><td class="num">${r.rate}</td><td class="small">${esc(r.rate_date)}</td><td class="small">${esc(r.source || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No rates.</td></tr>'}
        </tbody></table></div>
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:8px;margin-top:12px">
          <input id="fxBase" placeholder="EUR" /><input id="fxQuote" placeholder="USD" />
          <input id="fxRate" placeholder="rate" type="number" step="0.0001" /><button id="fxAdd">Add rate</button>
        </div>
      </div>
    </div>`;
  $('#setSave').addEventListener('click', async () => {
    const body = {};
    $$('#view [data-k]').forEach((i) => { body[i.dataset.k] = i.value; });
    try { await POST('/settings', body); toast('Saved', 'ok'); await loadSettings(); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#fxAdd').addEventListener('click', async () => {
    try { await POST('/fx', { base: $('#fxBase').value, quote: $('#fxQuote').value, rate: Number($('#fxRate').value) }); toast('Rate added', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
};

routes.audit = async () => {
  const rows = await GET('/audit');
  $('#view').innerHTML = `<div class="panel"><h2>Audit log</h2>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>ID</th><th>Detail</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td class="small">${dt(r.created_at)}</td><td>${esc(r.actor)}</td><td><span class="badge info">${esc(r.action)}</span></td><td>${esc(r.entity || '')}</td><td class="mono">${esc(r.entity_id || '')}</td><td class="small muted">${esc(r.detail || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Empty.</td></tr>'}
    </tbody></table></div></div>`;
};

routes.captures = async () => {
  const status = state._capStatus || '';
  const rows = await GET('/captures' + (status ? '?status=' + status : ''));
  const canPromote = can('buyer');
  const canIngest = can('analyst');
  const webhookCard = can('admin') ? `
    <div class="panel" style="margin-top:16px">
      <h2>Device webhook</h2>
      <div class="small muted">Point Plaud / reMarkable / Zapier at this endpoint to auto-ingest notes.</div>
      <div class="field" style="margin-top:8px"><label>URL</label><input readonly value="${esc(location.origin)}/api/captures/webhook" /></div>
      <div class="field" style="margin-top:8px"><label>Header x-capture-secret</label><input readonly value="${esc(state.settings.capture_secret || '')}" /></div>
    </div>` : '';

  const cards = rows.map((c) => {
    const p = c.parsed || {};
    const signals = [
      p.suggestedQuantity ? `<span class="badge info">${num(p.suggestedQuantity)} units</span>` : '',
      p.suggestedPrice ? `<span class="badge info">${money(p.suggestedPrice, p.suggestedCurrency || '')}</span>` : '',
      (p.barcodes || []).map((b) => `<span class="badge muted mono">${esc(b)}</span>`).join(' '),
      (p.intents || []).slice(0, 3).map((i) => `<span class="badge warn">${esc(i)}</span>`).join(' '),
    ].filter(Boolean).join(' ');
    return `
      <div class="panel" style="margin-bottom:12px" data-cap="${c.id}">
        <div class="row" style="justify-content:space-between">
          <div>
            <span class="badge ${c.source === 'plaud' ? 'info' : (c.source === 'remarkable' ? 'good' : 'muted')}">${esc(c.source)}</span>
            <strong style="margin-left:8px">${esc(c.title || '(untitled)')}</strong>
            <span class="muted small" style="margin-left:8px">${dt(c.captured_at)} · by ${esc(c.created_by || '')}</span>
          </div>
          <span class="badge ${c.status === 'new' ? 'warn' : (c.status === 'promoted' ? 'good' : 'muted')}">${esc(c.status)}</span>
        </div>
        <div style="margin:10px 0">${signals || '<span class="muted small">No signals detected</span>'}</div>
        <details class="small"><summary class="muted">Raw note</summary><pre class="mono" style="white-space:pre-wrap;margin-top:6px">${esc(c.raw_text)}</pre></details>
        ${(p.customerHint || (p.productHints || []).length) ? `<div class="small muted" style="margin-top:6px">Guess → customer: <b>${esc(p.customerHint || '?')}</b> · product: <b>${esc((p.productHints || [])[0] || '?')}</b></div>` : ''}
        <div class="row" style="margin-top:10px">
          ${c.status !== 'promoted' && canPromote ? `<button class="sm" data-promote="${c.id}">Promote to demand</button>` : ''}
          ${c.status === 'promoted' ? `<span class="badge good">→ demand #${c.demand_id}</span>` : ''}
          ${canIngest && c.status !== 'ignored' ? `<button class="sm ghost" data-ignore="${c.id}">Ignore</button>` : ''}
          ${canPromote ? `<button class="sm ghost" data-del="${c.id}">Delete</button>` : ''}
        </div>
      </div>`;
  }).join('') || '<div class="panel muted">No captures yet.</div>';

  $('#view').innerHTML = `
    <div class="split">
      <div>
        <div class="panel" style="margin-bottom:12px">
          <div class="row" style="justify-content:space-between">
            <h2 style="margin:0">Capture inbox</h2>
            <select id="capFilter">
              <option value="">All</option>
              ${['new', 'promoted', 'ignored'].map((s) => `<option ${status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
        </div>
        ${cards}
      </div>
      <div>
        ${canIngest ? `
        <div class="panel">
          <h2>Add a note</h2>
          <div class="field" style="margin-bottom:8px"><label>Source</label>
            <select id="capSource"><option value="manual">manual</option><option value="plaud">plaud</option><option value="remarkable">remarkable</option></select></div>
          <div class="field" style="margin-bottom:8px"><label>Title</label><input id="capTitle" /></div>
          <div class="field" style="margin-bottom:8px"><label>Text / transcript</label><textarea id="capText" rows="6" placeholder="Paste a Plaud transcript or reMarkable note…"></textarea></div>
          <button id="capAdd">Capture</button>
        </div>` : '<div class="panel muted">View-only. Analyst role required to add notes.</div>'}
        ${webhookCard}
      </div>
    </div>`;

  $('#capFilter').addEventListener('change', (e) => { state._capStatus = e.target.value; render(); });
  if ($('#capAdd')) $('#capAdd').addEventListener('click', async () => {
    if (!$('#capText').value.trim()) return toast('Note text required', 'err');
    try {
      await POST('/captures', { source: $('#capSource').value, title: $('#capTitle').value, text: $('#capText').value });
      toast('Captured', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('#view [data-ignore]').forEach((b) => b.addEventListener('click', async () => {
    try { await POST('/captures/' + b.dataset.ignore + '/ignore'); toast('Ignored', 'ok'); render(); } catch (e) { toast(e.message, 'err'); }
  }));
  $$('#view [data-del]').forEach((b) => b.addEventListener('click', async () => {
    try { await DEL('/captures/' + b.dataset.del); toast('Deleted', 'ok'); render(); } catch (e) { toast(e.message, 'err'); }
  }));
  $$('#view [data-promote]').forEach((b) => b.addEventListener('click', () => promoteCapture(Number(b.dataset.promote), rows.find((r) => r.id === Number(b.dataset.promote)))));
};

async function promoteCapture(capId, cap) {
  const customers = await GET('/customers');
  const p = cap.parsed || {};
  modal('Promote capture to demand', `
    <div class="field" style="margin-bottom:10px"><label>Customer</label><select id="prCust">${customers.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
    <div class="field" style="margin-bottom:10px"><label>Product</label>
      <div data-pp><input data-pp-input placeholder="search product…" /><input type="hidden" data-pp-id /><div data-pp-results style="margin-top:6px;max-height:180px;overflow:auto"></div></div></div>
    <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
      <div class="field"><label>Quantity</label><input id="prQty" type="number" value="${p.suggestedQuantity || 0}" /></div>
      <div class="field"><label>Target price</label><input id="prPrice" type="number" step="0.01" value="${p.suggestedPrice || ''}" /></div>
    </div>
    <button id="prGo" style="margin-top:12px;width:100%">Create demand</button>`, (bg) => {
    mountProductPicker(bg);
    bg.querySelector('#prGo').addEventListener('click', async () => {
      const productId = bg.querySelector('[data-pp-id]').value;
      if (!productId) return toast('Pick a product', 'err');
      try {
        const r = await POST('/captures/' + capId + '/promote', {
          customerId: Number(bg.querySelector('#prCust').value), productId,
          quantity: Number(bg.querySelector('#prQty').value), targetPrice: Number(bg.querySelector('#prPrice').value) || null,
          currency: p.suggestedCurrency || 'USD',
        });
        bg.remove(); toast('Demand #' + r.demandId + ' created', 'ok'); render();
      } catch (e) { toast(e.message, 'err'); }
    });
  });
}

routes.alerts = async () => {
  const d = await GET('/alerts');
  const unread = (d.rows||[]).filter(r=>r.read===0).length;
  $('#view').innerHTML = `
    <div class="panel">
      <div class="row" style="justify-content:space-between">
        <div><h2>Alerts</h2><div class="small muted">${unread} unread · ${d.counts.total||0} total</div></div>
        <div class="row"><button id="alRefresh">Refresh</button><button id="alAll" class="ghost">Mark all read</button></div>
      </div>
      <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Severity</th><th>Type</th><th>Title</th><th>Product</th><th>Supplier</th><th>When</th><th></th></tr></thead><tbody>
        ${(d.rows||[]).map(a=>'<tr><td>'+sev(a.severity)+'</td><td class="mono small">'+esc(a.type)+'</td><td>'+esc(a.title)+'</td><td class="small">'+esc(a.display_name||'')+'</td><td class="mono">'+esc(a.supplier_code||'')+'</td><td class="small muted">'+dt(a.created_at)+'</td><td>'+(a.read?'<span class="badge muted">read</span>':'<button class="sm ghost" data-read="'+a.id+'">Mark read</button>')+'</td></tr>').join('')||'<tr><td colspan="7" class="muted">No alerts.</td></tr>'}
      </tbody></table></div>
    </div>`;
  function sev(x){ return '<span class="badge '+(x==='critical'?'bad':x==='warning'?'warn':'info')+'">'+esc(x)+'</span>'; }
  $('#alRefresh').addEventListener('click', async ()=>{ try{ await POST('/alerts/refresh'); toast('Alerts refreshed','ok'); render(); }catch(e){ toast(e.message,'err'); } });
  $('#alAll').addEventListener('click', async ()=>{ try{ await POST('/alerts/read-all'); toast('All marked read','ok'); render(); }catch(e){ toast(e.message,'err'); } });
  $$('#view [data-read]').forEach(b=>b.addEventListener('click', async ()=>{ try{ await POST('/alerts/'+b.dataset.read+'/read'); toast('Marked read','ok'); render(); }catch(e){ toast(e.message,'err'); } }));
};


routes.users = async () => {
  const users = await GET('/users');
  $('#view').innerHTML = `
    <div class="split">
      <div class="panel"><h2>Users</h2>
        <div class="table-wrap"><table><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Active</th><th>Last login</th><th></th></tr></thead>
        <tbody>${users.map((u) => `
          <tr data-id="${u.id}">
            <td class="mono">${esc(u.username)}</td>
            <td><input data-f="display_name" value="${esc(u.display_name || '')}" style="width:130px" /></td>
            <td><select data-f="role">${['viewer', 'analyst', 'buyer', 'admin'].map((r) => `<option ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
            <td><input type="checkbox" data-f="active" ${u.active ? 'checked' : ''} /></td>
            <td class="small muted">${dt(u.last_login)}</td>
            <td><button class="sm" data-save="${u.id}">Save</button> <button class="sm ghost" data-pw="${u.id}">Reset pw</button></td>
          </tr>`).join('')}
        </tbody></table></div>
      </div>
      <div class="panel"><h2>Add user</h2>
        <div class="field" style="margin-bottom:8px"><label>Username</label><input id="uName" /></div>
        <div class="field" style="margin-bottom:8px"><label>Display name</label><input id="uDisplay" /></div>
        <div class="field" style="margin-bottom:8px"><label>Password</label><input id="uPass" type="text" /></div>
        <div class="field" style="margin-bottom:8px"><label>Role</label><select id="uRole">${['viewer', 'analyst', 'buyer', 'admin'].map((r) => `<option value="${r}">${r}</option>`).join('')}</select></div>
        <button id="uAdd" style="width:100%">Create user</button>
      </div>
    </div>`;
  $('#uAdd').addEventListener('click', async () => {
    try {
      await POST('/users', { username: $('#uName').value, displayName: $('#uDisplay').value, password: $('#uPass').value, role: $('#uRole').value });
      toast('User created', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('#view [data-save]').forEach((b) => b.addEventListener('click', async () => {
    const tr = b.closest('tr');
    const body = {
      displayName: $('[data-f="display_name"]', tr).value,
      role: $('[data-f="role"]', tr).value,
      active: $('[data-f="active"]', tr).checked,
    };
    try { await POST('/users/' + b.dataset.save, body); toast('Saved', 'ok'); if (Number(b.dataset.save) === state.user.id) { const me = await GET('/auth/me'); state.user = me.user; updateUserUI(); } }
    catch (e) { toast(e.message, 'err'); }
  }));
  $$('#view [data-pw]').forEach((b) => b.addEventListener('click', () => {
    modal('Reset password', `<div class="field"><label>New password</label><input id="rpPass" type="text" /></div><button id="rpGo" style="margin-top:12px;width:100%">Set password</button>`, (bg) => {
      bg.querySelector('#rpGo').addEventListener('click', async () => {
        try { await POST('/users/' + b.dataset.pw, { password: bg.querySelector('#rpPass').value }); bg.remove(); toast('Password reset', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      });
    });
  }));
};

/* ============================ router / boot ============================ */
const TITLES = {
  dashboard: ['Dashboard', 'Cross-supplier arbitrage, exceptions and performance'],
  imports: ['Import Lists', 'Ingest supplier price lists and see data quality'],
  offers: ['Supplier Offers', 'Every imported offer, with normalization basis'],
  products: ['Products & Matching', 'Product master resolved by barcode'],
  exceptions: ['Exceptions', 'Rows needing human review'],
  compare: ['Price Comparison', 'Normalise and rank offers for a barcode'],
  lowest: ['Lowest Landed Cost', 'Cheapest executable supplier for an exact SKU and quantity'],
  pricing: ['Deal Calculator', 'Landed cost, margin, markup and ROI'],
  inventory: ['Inventory', 'Lots, reservations and in-transit stock'],
  customers: ['Customers', 'Buyers and commercial terms'],
  demands: ['Demand Book', 'Customer requests to match against supply'],
  quotes: ['Deals & Quotes', 'Saved deals with contribution, ROI and cash flow'],
  suppliers: ['Suppliers & Terms', 'Price type, trade discount and Incoterms'],
  settings: ['Settings & FX', 'Policy thresholds and currency rates'],
  captures: ['Capture Inbox', 'Notes from Plaud / reMarkable turned into demand signals'],
  alerts: ['Alerts', 'Price movements, expiring offers and stock alerts'],
  users: ['Users & Roles', 'Accounts and role-based access'],
  audit: ['Audit Log', 'Who did what, when'],
};

function updateUserUI() {
  if (!state.user) { $('#userChip').textContent = ''; return; }
  $('#userChip').textContent = `${state.user.display_name || state.user.username} · ${state.user.role}`;
  $('#userChip').title = state.user.username;
  $$('#nav a').forEach((a) => {
    const min = ROUTE_MIN[a.dataset.route] || 'viewer';
    a.classList.toggle('hidden', !can(min));
  });
}

async function render() {
  if (!state.user) { showLogin(); return; }
  let route = state.route;
  if (!routes[route] || !can(ROUTE_MIN[route] || 'viewer')) route = 'dashboard';
  state.route = route;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
  const t = TITLES[route] || ['', ''];
  $('#pageTitle').textContent = t[0];
  $('#pageSub').textContent = t[1];
  $('#view').innerHTML = '<div class="muted">Loading…</div>';
  try {
    await routes[route]();
  } catch (e) {
    $('#view').innerHTML = `<div class="panel"><span class="badge bad">Error</span> ${esc(e.message)}</div>`;
  }
}

function go(route) {
  state.route = route;
  if (location.hash.slice(1) !== route) location.hash = route;
  render();
}

window.addEventListener('hashchange', () => {
  const r = location.hash.slice(1) || 'dashboard';
  if (r !== state.route && routes[r]) { state.route = r; render(); }
});

$$('#nav a').forEach((a) => a.addEventListener('click', () => go(a.dataset.route)));
$('#refreshBtn').addEventListener('click', () => { loadSettings().then(render); });

async function doLogin() {
  const username = $('#loginUser').value.trim();
  const password = $('#loginPass').value;
  try {
    const r = await POST('/auth/login', { username, password });
    state.user = r.user;
    $('#loginErr').textContent = '';
    hideLogin();
    await loadSettings();
    updateUserUI();
    go('dashboard');
  } catch (e) { $('#loginErr').textContent = e.message; }
}
$('#loginGo').addEventListener('click', doLogin);
$('#loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('#loginUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginPass').focus(); });

$('#logoutBtn').addEventListener('click', async () => {
  try { await POST('/auth/logout'); } catch (e) { /* ignore */ }
  state.user = null;
  updateUserUI();
  showLogin();
});

$('#pwBtn').addEventListener('click', () => {
  if (!state.user) return;
  modal('Change password', `
    <div class="field" style="margin-bottom:10px"><label>Current password</label><input id="cpCur" type="password" /></div>
    <div class="field" style="margin-bottom:10px"><label>New password</label><input id="cpNew" type="password" /></div>
    <button id="cpGo" style="width:100%">Update</button>`, (bg) => {
    bg.querySelector('#cpGo').addEventListener('click', async () => {
      try {
        await POST('/auth/password', { currentPassword: bg.querySelector('#cpCur').value, newPassword: bg.querySelector('#cpNew').value });
        bg.remove(); toast('Password updated', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
  });
});

(async function boot() {
  try {
    const me = await GET('/auth/me');
    state.user = me.user;
  } catch (e) { state.user = null; }
  if (!state.user) { showLogin(); return; }
  await loadSettings();
  updateUserUI();
  const r = location.hash.slice(1) || 'dashboard';
  state.route = (routes[r] && can(ROUTE_MIN[r] || 'viewer')) ? r : 'dashboard';
  render();
})();
