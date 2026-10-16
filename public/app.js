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
  bg.innerHTML = `<div class="modal"><div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(title)}</h2><button class="ghost sm" data-close aria-label="Close">&#10005;</button></div><div style="margin-top:14px" data-body></div></div>`;
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
  dashboard: 'viewer', offers: 'viewer', products: 'viewer', compare: 'viewer', lowest: 'viewer', pricing: 'viewer', builder: 'viewer', lists: 'analyst',
  inventory: 'viewer', customers: 'viewer', demands: 'viewer', quotes: 'viewer', suppliers: 'viewer',
  exceptions: 'viewer', imports: 'buyer', captures: 'analyst', alerts: 'viewer', trends: 'viewer', orders: 'viewer', placements: 'viewer', shipments: 'viewer', buying: 'viewer', forecast: 'viewer', performance: 'viewer', reports: 'viewer', settings: 'admin', users: 'admin', audit: 'admin',
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
    ['Orders', num(o.orders), `${o.ordersOpen} open`],
    ['Realised margin', money(o.realisedMargin), 'from settled orders'],
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
        <div class="table-wrap"><table><thead><tr><th>File</th><th>Supplier</th><th>Sheet</th><th class="num">Rows</th><th class="num">Matched</th><th class="num">Blank</th><th class="num">Invalid</th><th>Cleaned</th><th>Date</th></tr></thead><tbody>
        ${uploads.map((u) => `<tr><td class="mono">${esc(u.filename)}</td><td>${esc(u.supplier_code)}</td><td class="small">${esc(u.sheet || '')}</td><td class="num">${u.rows_total}</td><td class="num">${u.rows_imported}</td><td class="num">${u.rows_blank_barcode}</td><td class="num">${u.rows_invalid_barcode}</td><td class="small"><a class="btn quiet" style="padding:2px 8px" href="/api/export/cleaned/${u.id}.xlsx" title="Standard-template snapshot${u.cleaned_at ? ` · ${u.cleaned_rows} rows · ${dt(u.cleaned_at)}` : ' (rebuilt on demand)'}">Template${u.cleaned_at ? '' : ' •'}</a></td><td class="small">${dt(u.uploaded_at)}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No uploads yet.</td></tr>'}
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
            <li>After every import, a cleaned copy is written onto the system
              <strong>standard supplier template</strong> (auto-pilot) and offered
              as the "Template" download above.</li>
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
          </div>
          ${r.cleaned && !r.cleaned.error ? `<div class="small muted" style="margin-top:8px">Cleaned to the standard template: ${r.cleaned.rows} rows — <a href="/api/export/cleaned/${r.uploadId}.xlsx">download</a></div>` : ''}`;
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
    <div class="grid cards" style="margin-bottom:16px">
      <div class="card"><div class="k">Awaiting review</div><div class="v">${num((data.approvals || {}).review)}</div><div class="s">staff sign-off pending</div></div>
      <div class="card"><div class="k">Approved</div><div class="v">${num((data.approvals || {}).approved)}</div><div class="s">tradeable</div></div>
      <div class="card"><div class="k">Rejected</div><div class="v">${num((data.approvals || {}).rejected)}</div></div>
      <div class="card"><div class="k">Approval enforced</div><div class="v">${data.approvalRequired ? 'ON' : 'off'}</div><div class="s">${data.approvalRequired ? 'unapproved offers cannot be traded' : 'review state is recorded only'}</div></div>
    </div>
    <div class="panel">
      <div class="row" style="margin-bottom:12px">
        <input id="ofQ" placeholder="Search description / barcode / SKU" value="${esc(params.q || '')}" style="min-width:260px" />
        <select id="ofSupplier"><option value="">All suppliers</option>${supOpts}</select>
        <select id="ofStatus"><option value="">All status</option>${['matched', 'exception', 'new'].map((s) => `<option ${params.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <select id="ofApproval"><option value="">All approvals</option>${['review', 'approved', 'rejected', 'expired'].map((s) => `<option ${params.approval === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <select id="ofCategory"><option value="">All categories</option>${catOpts}</select>
        <button id="ofGo" class="sm">Apply</button>
        <span class="spacer"></span>
        <span class="muted small">${num(data.total)} offers</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Supplier</th><th>Barcode</th><th>Product</th><th>Cat</th><th class="num">Size</th><th class="num">Price</th><th>Basis</th><th>Match</th><th>Approval</th><th></th></tr></thead>
        <tbody>${data.rows.map((o) => {
          const appr = o.approval_status || 'review';
          const apprBadge = appr === 'approved'
            ? `<span class="badge good" title="${esc(o.approved_by || '')}${o.approved_at ? ' · ' + esc(o.approved_at) : ''}">approved</span>`
            : appr === 'rejected'
              ? `<span class="badge bad" title="${esc(o.review_note || '')}">rejected</span>`
              : appr === 'expired' ? '<span class="badge muted">expired</span>'
              : '<span class="badge warn">in review</span>';
          return `
          <tr>
            <td><span class="badge info">${esc(o.supplier_code)}</span></td>
            <td class="mono">${esc(o.gtin_source || '')} ${o.gtin_valid ? '' : '<span class="badge bad">!</span>'}</td>
            <td>${esc((o.description || '').slice(0, 52))}</td>
            <td class="small muted">${esc(o.category || '')}</td>
            <td class="num">${o.size_ml ? num(o.size_ml) + 'ml' : '—'}</td>
            <td class="num pill-price">${money(o.price, o.currency)}</td>
            <td class="small">${esc(o.price_basis || '')}${o.units_per_case ? ' ×' + o.units_per_case : ''}</td>
            <td>${o.status === 'exception' ? '<span class="badge warn">exception</span>' : (o.status === 'matched' ? '<span class="badge good">matched</span>' : '<span class="badge muted">new</span>')}</td>
            <td>${apprBadge}</td>
            <td class="nowrap">${can('buyer') && appr !== 'approved' ? `<button class="btn sm" data-approve="${o.id}">Approve</button> <button class="btn sm ghost" data-reject="${o.id}">Reject</button>` : ''}</td>
          </tr>`;
        }).join('') || '<tr><td colspan="10" class="muted">No offers.</td></tr>'}
        </tbody>
      </table></div>
      <div class="row" style="margin-top:12px">
        <button class="ghost sm" id="ofPrev" ${params.offset <= 0 ? 'disabled' : ''}>‹ Prev</button>
        <span class="muted small">${params.offset + 1}–${Math.min(params.offset + params.limit, data.total)} of ${num(data.total)}</span>
        <button class="ghost sm" id="ofNext" ${params.offset + params.limit >= data.total ? 'disabled' : ''}>Next ›</button>
      </div>
    </div>`;
  const apply = () => { params.q = $('#ofQ').value.trim(); params.supplier = $('#ofSupplier').value; params.status = $('#ofStatus').value; params.approval = $('#ofApproval').value; params.category = $('#ofCategory').value; params.offset = 0; render(); };
  $('#ofGo').addEventListener('click', apply);
  $('#ofQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  $('#ofPrev').addEventListener('click', () => { params.offset = Math.max(0, params.offset - params.limit); render(); });
  $('#ofNext').addEventListener('click', () => { params.offset += params.limit; render(); });
  for (const [attr, verb] of [['approve', 'approve'], ['reject', 'reject']]) {
    $$(`#view [data-${attr}]`).forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset[attr];
      const note = verb === 'reject' ? (prompt('Why reject this offer? (optional)') || '') : '';
      try { await POST(`/offers/${id}/${verb}`, { note }); toast(`Offer ${verb}d`, 'ok'); render(); }
      catch (e) { toast(e.message, 'err'); }
    }));
  }
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
  'units-per-case-unknown': ['bad', 'pack size unknown — cannot price per bottle'],
  'not-approved': ['bad', 'not approved by staff'],
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
          <div class="field"><label>Outbound cost / unit</label><input id="dcOutbound" type="number" step="0.01" value="0" title="Delivery, handling and other per-unit deal costs" /></div>
          <div class="field"><label>Commission %</label><input id="dcCommission" type="number" step="0.1" value="0" title="Of net revenue" /></div>
          <div class="field"><label>Expected credit loss %</label><input id="dcCreditLoss" type="number" step="0.1" value="0" title="Of net revenue" /></div>
          <div class="field"><label>Supplier advance %</label><input id="dcAdvance" type="number" step="0.1" placeholder="0" title="Paid to the supplier on the order date" /></div>
          <div class="field"><label>Customer deposit %</label><input id="dcDeposit" type="number" step="0.1" placeholder="0" title="Received from the customer on the order date" /></div>
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
    outboundPerUnit: numOrU($('#dcOutbound').value),
    commissionPct: numOrU($('#dcCommission').value),
    expectedCreditLossPct: numOrU($('#dcCreditLoss').value),
    supplierAdvancePct: numOrU($('#dcAdvance').value),
    customerDepositPct: numOrU($('#dcDeposit').value),
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
      <div class="item"><div class="k">Deal costs</div><div class="v">${money((r.deal.contribution && r.deal.contribution.dealCostsTotal) || 0, r.baseCurrency)}</div></div>
      <div class="item"><div class="k">ROI %</div><div class="v">${pct(m.roiPct)}</div></div>
      <div class="item"><div class="k">Annualised ROI</div><div class="v">${cf.annualisedRoiPct != null ? pct(cf.annualisedRoiPct) : '—'}</div></div>
      <div class="item"><div class="k">Capital required</div><div class="v">${money(cf.peakCapital, r.baseCurrency)}</div>${cf.recoverableTax ? `<div class="s">incl. ${money(cf.recoverableTax, r.baseCurrency)} recoverable tax (cash, not cost)</div>` : ''}</div>
      <div class="item"><div class="k">Deployed capital</div><div class="v">${money((r.deal.return && r.deal.return.deployedCapital) || cf.peakCapital, r.baseCurrency)}</div></div>
      <div class="item"><div class="k">Deal return</div><div class="v">${r.deal.return && r.deal.return.simpleReturnPct != null ? pct(r.deal.return.simpleReturnPct) : '—'}</div></div>
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
    </div>
    ${(r.deal.scenarios || []).length ? `<h2 style="font-size:13px;margin-top:14px">Scenarios <span class="muted small">— conservative / base / upside and stress cases (not a forecast)</span></h2>
    <div class="table-wrap"><table><thead><tr><th>Case</th><th>Assumption</th><th class="num">Contribution</th><th class="num">Margin</th><th>Policy</th></tr></thead>
    <tbody>${r.deal.scenarios.map((s) => `<tr><td><span class="badge ${s.kind === 'base' ? 'info' : s.kind.startsWith('stress') ? (s.survives ? 'warn' : 'bad') : s.survives ? 'good' : 'bad'}">${esc(s.label)}</span></td><td class="small muted">${esc(s.description)}</td><td class="num ${s.contributionTotal < 0 ? 'muted' : ''}">${money(s.contributionTotal, r.baseCurrency)}</td><td class="num">${pct(s.marginPct)}</td><td>${s.passesPolicy ? '<span class="badge good">pass</span>' : '<span class="badge bad">fail</span>'}</td></tr>`).join('')}
    </tbody></table></div>` : ''}`;
}

/* ================= cost price -> selling price (offer builder) ================= */
let builderLast = null;
let builderPickOffer = () => {};

routes.builder = async () => {
  const customers = await loadCustomers().catch(() => []);
  const base = (state.settings.base_currency) || 'USD';
  const minMargin = Number(state.settings.min_margin_pct != null ? state.settings.min_margin_pct : 15);
  $('#view').innerHTML = `
    <div class="split">
      <div class="panel">
        <h2>Cost price → selling price <span class="muted small">— build an offer from a target margin</span></h2>
        <div class="field" style="margin-bottom:8px"><label>Product (optional)</label>
          <div data-pp><input data-pp-input placeholder="search product…" /><input type="hidden" data-pp-id /><div data-pp-results style="margin-top:6px;max-height:170px;overflow:auto"></div></div>
        </div>
        <div class="field" style="margin-bottom:8px"><label>Auto-fill from supplier offer</label>
          <select id="obOffer"><option value="">— enter a cost price manually —</option></select>
        </div>
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
          <div class="field"><label>Cost price / bottle</label><input id="obCost" type="number" step="0.01" placeholder="0.00" /></div>
          <div class="field"><label>Cost currency</label><input id="obCur" value="${esc(base)}" style="width:80px" /></div>
          <div class="field"><label>FX rate <span class="muted small">1 cost = ? ${esc(base)}</span></label><input id="obFx" type="number" step="0.0001" placeholder="auto" /></div>
          <div class="field"><label>Freight / bottle</label><input id="obFreight" type="number" step="0.01" placeholder="0" /></div>
          <div class="field"><label>Duty %</label><input id="obDuty" type="number" step="0.01" placeholder="0" /></div>
          <div class="field"><label>Insurance / bottle</label><input id="obInsurance" type="number" step="0.01" placeholder="0" /></div>
          <div class="field"><label>Brokerage / bottle</label><input id="obBrokerage" type="number" step="0.01" placeholder="0" /></div>
          <div class="field"><label>Handling / bottle</label><input id="obHandling" type="number" step="0.01" placeholder="0" /></div>
          <div class="field"><label>Other taxes / bottle</label><input id="obOther" type="number" step="0.01" placeholder="0" /></div>
          <div class="field"><label>Target margin %</label><input id="obMargin" type="number" step="0.1" value="${minMargin}" /></div>
          <div class="field"><label>Quantity</label><input id="obQty" type="number" value="100" /></div>
        </div>
        <div class="row" style="margin-top:12px"><button id="obGo">Calculate selling price</button></div>
      </div>
      <div class="panel" id="obOut"><div class="muted small">Enter a cost price (or pick a product and offer), set a target margin, and calculate. Both margin conventions are shown side by side.</div></div>
    </div>`;
  mountProductPicker($('#view'), async (pid) => {
    try {
      const r = await GET(`/products/${pid}/compare`);
      const offers = (r.offers || []).filter((o) => !o.isRetail && o.perBottleBase != null);
      $('#obOffer').innerHTML = `<option value="">— enter a cost price manually —</option>` + offers.map((o) =>
        `<option value="${o.offerId}" data-ppb="${o.perBottleBase}" data-cur="${esc(o.currency || base)}">${esc(o.supplier)} · ${money(o.perBottleBase, base)} / bottle${o.incoterm ? ' · ' + esc(o.incoterm) : ''}</option>`
      ).join('');
      builderLast = { productId: pid, offers };
      if (offers[0]) $('#obOffer').value = String(offers[0].offerId);
      pickOffer();
    } catch (e) { toast(e.message, 'err'); }
  });
  function pickOffer() {
    const sel = $('#obOffer');
    const o = builderLast && builderLast.offers ? builderLast.offers.find((x) => String(x.offerId) === sel.value) : null;
    if (o) { $('#obCost').value = o.perBottleBase; $('#obCur').value = base; $('#obFx').value = ''; }
  }
  builderPickOffer = pickOffer;
  $('#obOffer').addEventListener('change', pickOffer);
  $('#obGo').addEventListener('click', async () => {
    const numOrU = (v) => (v === '' || v == null ? undefined : Number(v));
    const body = {
      offerId: $('#obOffer').value || undefined,
      costPrice: $('#obCost').value === '' ? undefined : Number($('#obCost').value),
      costCurrency: $('#obCur').value.trim() || base,
      fxRate: numOrU($('#obFx').value),
      freightPerUnit: numOrU($('#obFreight').value),
      dutyPct: numOrU($('#obDuty').value),
      insurancePerUnit: numOrU($('#obInsurance').value),
      brokeragePerUnit: numOrU($('#obBrokerage').value),
      handlingPerUnit: numOrU($('#obHandling').value),
      otherTaxesPerUnit: numOrU($('#obOther').value),
      targetMarginPct: numOrU($('#obMargin').value),
      quantity: numOrU($('#obQty').value),
      baseCurrency: base,
    };
    if (!body.offerId && !(body.costPrice > 0)) return toast('Enter a cost price or pick an offer', 'err');
    try { const r = await POST('/pricing/offer', body); renderBuilderResult(r, customers); }
    catch (e) { toast(e.message, 'err'); }
  });
};

function renderBuilderResult(r, customers) {
  const cur = r.baseCurrency;
  const opts = [r.options.markupOnCost, r.options.marginOnSelling];
  const card = (o) => `
    <div class="card" style="border:1px solid var(--border);padding:12px" data-basis="${o.basis}">
      <div class="row" style="justify-content:space-between">
        <label class="row" style="gap:6px;cursor:pointer"><input type="radio" name="obBasis" value="${o.basis}" ${o.basis === 'margin_on_selling' ? 'checked' : ''} style="width:auto" />
          <span style="font-weight:600">${o.basis === 'markup_on_cost' ? 'Markup on cost' : 'Margin on selling price'}</span></label>
        <span class="badge ${o.passesPolicy ? 'good' : 'bad'}">${o.passesPolicy ? 'meets policy' : 'below policy'}</span>
      </div>
      <div class="muted small" style="margin:6px 0 8px">${o.basis === 'markup_on_cost' ? 'SP = cost × (1 + m)' : 'SP = cost ÷ (1 − m)'}</div>
      <div class="kpi-inline">
        <div class="item"><div class="k">Selling price</div><div class="v best">${o.valid ? money(o.sellingUnitPrice, cur) : '—'}</div></div>
        <div class="item"><div class="k">Margin %</div><div class="v">${o.marginPctOnSell != null ? pct(o.marginPctOnSell) : '—'}</div></div>
        <div class="item"><div class="k">Markup / unit</div><div class="v">${o.markupPerUnit != null ? money(o.markupPerUnit, cur) : '—'}</div></div>
        <div class="item"><div class="k">Profit (${num(r.quantity)} u)</div><div class="v">${o.marginTotal != null ? money(o.marginTotal, cur) : '—'}</div></div>
      </div>
      ${o.valid ? '' : `<div class="badge warn" style="margin-top:8px">${esc(o.reason || 'not computable')}</div>`}
    </div>`;
  const landedRows = [
    ['Cost / bottle', money(r.acquisition.perBottle, r.acquisition.currency) + (r.acquisition.currency !== cur ? ` → ${money(r.acquisition.perBottleBase, cur)}` : '')],
    ['Duty', money(r.landed.duty, cur)],
    ['Freight', money(r.landed.freight, cur)],
    ['Insurance', money(r.landed.insurance, cur)],
    ['Brokerage', money(r.landed.brokerage, cur)],
    ['Handling', money(r.landed.handling, cur)],
    ['Other taxes', money(r.landed.otherTaxes, cur)],
    ['Landed / bottle', `<b>${money(r.landed.total, cur)}</b>`],
  ];
  const supplierRows = builderLast && builderLast.productId ? (builderLast.offers || []).map((o) => {
    const extras = (Number(r.landed.freight) + Number(r.landed.insurance) + Number(r.landed.brokerage) + Number(r.landed.handling) + Number(r.landed.otherTaxes));
    const est = o.perBottleBase + o.perBottleBase * (r.landed.purchase > 0 ? (r.landed.duty / r.landed.purchase) : 0) + extras;
    const sp = est / (1 - r.targetMarginPct / 100);
    return { ...o, est, sp };
  }).sort((a, b) => a.est - b.est) : [];
  const bestId = supplierRows[0] ? supplierRows[0].offerId : null;
  $('#obOut').innerHTML = `
    <h2>Selling price at ${pct(r.targetMarginPct)}</h2>
    <div class="muted small" style="margin:4px 0 12px">Cost ${money(r.acquisition.perBottle, r.acquisition.currency)}${r.acquisition.currency !== cur ? ` × FX ${r.fxRate} = ${money(r.acquisition.perBottleBase, cur)}` : ''} · landed ${money(r.landed.total, cur)} / bottle · qty ${num(r.quantity)}</div>
    <div class="grid cards" style="grid-template-columns:1fr 1fr">${opts.map(card).join('')}</div>
    <div class="row" style="margin-top:14px;gap:10px;align-items:flex-end">
      <div class="field" style="flex:1"><label>Customer (to save as a quote)</label>
        <select id="obCust"><option value="">— none —</option>${(customers || []).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <button id="obSave">Save as quote</button>
    </div>
    <div style="margin-top:14px;max-width:420px"><div class="muted small" style="margin-bottom:4px">Landed cost build-up / bottle (${esc(cur)})</div>
      <table>${landedRows.map((l) => `<tr><td class="muted">${l[0]}</td><td class="num">${l[1]}</td></tr>`).join('')}</table></div>
    ${supplierRows.length ? `<h2 style="font-size:13px;margin-top:16px">Suppliers for this product <span class="muted small">— ranked by landed cost, SP at your target margin</span></h2>
      <div class="table-wrap"><table><thead><tr><th>Supplier</th><th class="num">Cost / bottle</th><th class="num">Est. landed</th><th class="num">SP @ ${pct(r.targetMarginPct)}</th><th></th></tr></thead>
      <tbody>${supplierRows.map((o) => `<tr ${o.offerId === bestId ? 'style="background:rgba(79,206,155,.08)"' : ''}>
        <td><span class="badge ${o.offerId === bestId ? 'good' : 'info'}">${esc(o.supplier)}</span></td>
        <td class="num">${money(o.perBottleBase, cur)}</td>
        <td class="num">${money(o.est, cur)}</td>
        <td class="num pill-price ${o.offerId === bestId ? 'best' : ''}">${money(o.sp, cur)}</td>
        <td>${builderLast.productId ? `<button class="btn sm" data-offer="${o.offerId}">Use this supplier</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="muted small" style="margin-top:6px">Estimated landed applies the freight/duty inputs above to each supplier's quoted cost; open the Deal Calculator for a full per-supplier costing.</div>` : ''}`;
  const save = async () => {
    if (!can('buyer')) return toast('Buyer role required to save', 'err');
    if (!builderLast || !builderLast.productId) return toast('Pick a product first', 'err');
    const cust = $('#obCust') ? $('#obCust').value : '';
    if (!cust) return toast('Pick a customer', 'err');
    const basis = (document.querySelector('input[name="obBasis"]:checked') || {}).value;
    const chosen = r.options[basis === 'markup_on_cost' ? 'markupOnCost' : 'marginOnSelling'];
    if (!chosen || !chosen.valid) return toast('That convention is not computable', 'err');
    try {
      const res = await POST('/quotes', {
        customerId: Number(cust), productId: builderLast.productId, quantity: r.quantity,
        unitPrice: chosen.sellingUnitPrice, landedUnitCost: r.landed.total, currency: cur,
      });
      toast('Quote saved (#' + res.id + ') · margin ' + pct(res.marginPct), 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#obSave').addEventListener('click', save);
  $$('#obOut [data-basis]').forEach((el) => el.addEventListener('click', (ev) => {
    if (ev.target.tagName !== 'INPUT') { const r = el.querySelector('input'); if (r) r.checked = true; }
  }));
  $$('#obOut [data-offer]').forEach((el) => el.addEventListener('click', () => {
    $('#obOffer').value = el.dataset.offer;
    builderPickOffer();
  }));
}

/* ================= compare two uploaded price lists ================= */
routes.lists = async () => {
  $('#view').innerHTML = `
    <div class="panel">
      <h2>Compare two price lists <span class="muted small">— diff by barcode or description</span></h2>
      <div class="muted small" style="margin:6px 0 12px">Upload a baseline list (A) and a new list (B). Rows are matched by barcode (EAN/UPC/GTIN) where present, otherwise by description. Nothing is imported or saved.</div>
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:12px">
        <div class="field"><label>Baseline list (A)</label><input id="ldA" type="file" accept=".xls,.xlsx,.csv" /></div>
        <div class="field"><label>New list (B)</label><input id="ldB" type="file" accept=".xls,.xlsx,.csv" /></div>
      </div>
      <div class="row" style="margin-top:12px"><button id="ldGo">Compare</button></div>
    </div>
    <div id="ldOut" style="margin-top:16px"><div class="muted small">Pick two files and compare.</div></div>`;
  $('#ldGo').addEventListener('click', async () => {
    const a = $('#ldA').files[0];
    const b = $('#ldB').files[0];
    if (!a || !b) return toast('Choose both files', 'err');
    const fd = new FormData();
    fd.append('fileA', a);
    fd.append('fileB', b);
    $('#ldOut').innerHTML = '<div class="muted small">Comparing…</div>';
    try {
      const r = await api('POST', '/compare-files', fd, true);
      renderListDiff($('#ldOut'), r);
    } catch (e) { $('#ldOut').innerHTML = `<div class="badge bad">${esc(e.message)}</div>`; }
  });
};

function renderListDiff(el, r) {
  const s = r.summary;
  const rows = (arr, cells) => arr.map(cells).join('') || '<tr><td colspan="9" class="muted">None.</td></tr>';
  el.innerHTML = `
    <div class="grid cards">
      <div class="card"><div class="k">Added (in B)</div><div class="v best">${num(s.added)}</div></div>
      <div class="card"><div class="k">Removed (gone)</div><div class="v">${num(s.removed)}</div></div>
      <div class="card"><div class="k">Price changes</div><div class="v">${num(s.priceChanges)}</div><div class="s">${num(s.priceUp)} up · ${num(s.priceDown)} down</div></div>
      <div class="card"><div class="k">Quantity changes</div><div class="v">${num(s.quantityChanges)}</div></div>
      <div class="card"><div class="k">Matched</div><div class="v">${num(s.matched)}</div><div class="s">A ${num(s.aRows)} · B ${num(s.bRows)}</div></div>
    </div>
    <div class="muted small" style="margin:10px 0">A: ${esc(r.a.name)} → sheet "${esc(r.a.sheet || '?')}", header row ${r.a.headerRow}, ${num(r.a.rowCount)} rows. B: ${esc(r.b.name)} → sheet "${esc(r.b.sheet || '?')}", header row ${r.b.headerRow}, ${num(r.b.rowCount)} rows.${s.truncated ? ' Showing first 500 per section.' : ''}</div>

    ${s.priceChanges ? `<div class="panel" style="margin-top:14px"><h2 style="font-size:13px">Price changes</h2>
      <div class="table-wrap"><table><thead><tr><th>Barcode</th><th>Description</th><th class="num">From</th><th class="num">To</th><th class="num">Change</th><th class="num">%</th></tr></thead>
      <tbody>${rows(r.priceChanges, (c) => `<tr><td class="mono small">${esc(c.barcode || '—')}</td><td class="small">${esc((c.description || '').slice(0, 44))}</td><td class="num">${num(c.from)}</td><td class="num">${num(c.to)}</td><td class="num ${c.diff > 0 ? 'muted' : 'best'}">${c.diff > 0 ? '+' : ''}${num(c.diff)}</td><td class="num"><span class="badge ${c.diff > 0 ? 'bad' : 'good'}">${c.pct != null ? pct(c.pct) : '—'}</span></td></tr>`)}</tbody></table></div></div>` : ''}

    ${s.quantityChanges ? `<div class="panel" style="margin-top:14px"><h2 style="font-size:13px">Quantity changes</h2>
      <div class="table-wrap"><table><thead><tr><th>Barcode</th><th>Description</th><th class="num">From</th><th class="num">To</th><th class="num">Δ</th></tr></thead>
      <tbody>${rows(r.quantityChanges, (c) => `<tr><td class="mono">${esc(c.barcode || '')}</td><td class="small">${esc((c.description || '').slice(0, 48))}</td><td class="num">${num(c.from)}</td><td class="num">${num(c.to)}</td><td class="num ${c.diff < 0 ? 'muted' : ''}">${num(c.diff)}</td></tr>`)}</tbody></table></div></div>` : ''}

    <div class="split" style="margin-top:14px">
      <div class="panel"><h2 style="font-size:13px">Added in B <span class="badge good">${num(s.added)}</span></h2>
        <div class="table-wrap"><table><thead><tr><th>Barcode</th><th>Description</th><th class="num">Price</th><th class="num">Qty</th></tr></thead>
        <tbody>${rows(r.added, (c) => `<tr><td class="mono">${esc(c.barcode || '')}</td><td class="small">${esc((c.description || '').slice(0, 40))}</td><td class="num">${c.price != null ? money(c.price) : '—'}</td><td class="num">${c.quantity != null ? num(c.quantity) : '—'}</td></tr>`)}</tbody></table></div>
      </div>
      <div class="panel"><h2 style="font-size:13px">Removed <span class="badge bad">${num(s.removed)}</span></h2>
        <div class="table-wrap"><table><thead><tr><th>Barcode</th><th>Description</th><th class="num">Last price</th><th class="num">Qty</th></tr></thead>
        <tbody>${rows(r.removed, (c) => `<tr><td class="mono">${esc(c.barcode || '')}</td><td class="small">${esc((c.description || '').slice(0, 40))}</td><td class="num">${c.price != null ? money(c.price) : '—'}</td><td class="num">${c.quantity != null ? num(c.quantity) : '—'}</td></tr>`)}</tbody></table></div>
      </div>
    </div>
    ${s.descriptionChanges ? `<div class="panel" style="margin-top:14px"><h2 style="font-size:13px">Description changes</h2>
      <div class="table-wrap"><table><thead><tr><th>Barcode</th><th>From</th><th>To</th></tr></thead>
      <tbody>${rows(r.descriptionChanges, (c) => `<tr><td class="mono">${esc(c.barcode || '')}</td><td class="small">${esc(c.from)}</td><td class="small">${esc(c.to)}</td></tr>`)}</tbody></table></div></div>` : ''}`;
}


/* ================= supplier order placement ================= */
let plLines = [];
let plOffers = [];
let plPickedProduct = null;

function plCalc(l) {
  const upc = Number(l.unitsPerCase) > 0 ? Number(l.unitsPerCase) : 1;
  const boxes = Math.max(0, Math.floor(Number(l.boxes) || 0));
  const units = boxes * upc;
  const cost = l.unitCost != null && l.unitCost !== '' ? Number(l.unitCost) : null;
  const total = cost != null ? Math.round(units * cost * 10000) / 10000 : 0;
  return { upc, boxes, units, cost, total };
}

routes.placements = async () => {
  const suppliers = (state.suppliers && state.suppliers.length) ? state.suppliers : await GET('/suppliers').catch(() => []);
  plLines = [];
  plOffers = [];
  plPickedProduct = null;
  const today = new Date().toISOString().slice(0, 10);

  const renderLines = () => {
    const cur = $('#plCur') ? $('#plCur').value : 'EUR';
    if (!plLines.length) {
      $('#plLines').innerHTML = '<div class="muted small">No lines yet — load the purchase plan or pick a product and add a line.</div>';
    } else {
      $('#plLines').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Units/case</th><th class="num">Full boxes</th><th class="num">Units</th><th class="num">Unit cost</th><th class="num">Line total</th><th></th></tr></thead><tbody>
        ${plLines.map((l, i) => { const c = plCalc(l); return `<tr>
          <td>${esc((l.description || '').slice(0, 46))}${l.warn ? `<div class="muted small">${esc(l.warn)}</div>` : ''}<div class="muted small mono">${esc(l.barcode || '')}</div></td>
          <td class="num">${num(c.upc)}</td>
          <td class="num"><input data-i="${i}" data-f="boxes" type="number" min="0" step="1" value="${c.boxes}" style="width:72px" /></td>
          <td class="num" data-units="${i}">${num(c.units)}</td>
          <td class="num"><input data-i="${i}" data-f="unitCost" type="number" step="0.0001" value="${c.cost != null ? c.cost : ''}" style="width:92px" /></td>
          <td class="num" data-total="${i}">${money(c.total, cur)}</td>
          <td><button class="ghost sm" data-del="${i}" type="button" aria-label="Remove">&#10005;</button></td>
        </tr>`; }).join('')}
      </tbody></table></div>`;
    }
    renderTotals();
    $$('#plLines [data-f]').forEach((inp) => inp.addEventListener('input', () => {
      const i = Number(inp.dataset.i);
      plLines[i][inp.dataset.f] = inp.value;
      const c = plCalc(plLines[i]);
      const u = $(`#plLines [data-units="${i}"]`);
      const t = $(`#plLines [data-total="${i}"]`);
      if (u) u.textContent = num(c.units);
      if (t) t.textContent = money(c.total, $('#plCur').value);
      renderTotals();
    }));
    $$('#plLines [data-del]').forEach((b) => b.addEventListener('click', () => {
      plLines.splice(Number(b.dataset.del), 1);
      renderLines();
    }));
  };

  const renderTotals = () => {
    const cur = $('#plCur') ? $('#plCur').value : 'EUR';
    const boxes = plLines.reduce((s, l) => s + plCalc(l).boxes, 0);
    const units = plLines.reduce((s, l) => s + plCalc(l).units, 0);
    const total = plLines.reduce((s, l) => s + plCalc(l).total, 0);
    $('#plTotals').innerHTML = `<span class="muted small">${num(plLines.length)} lines · ${num(boxes)} boxes · ${num(units)} units</span>
      <span><strong>${money(Math.round(total * 10000) / 10000, cur)}</strong></span>`;
  };

  const loadList = async () => {
    const data = await GET('/placements').catch(() => ({ rows: [] }));
    const rows = data.rows || [];
    $('#plList').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Ref</th><th>Supplier</th><th class="num">Lines</th><th class="num">Total</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="mono">${esc(r.ref)}</td><td>${esc(r.supplier_code || '')}<div class="muted small">${esc(r.order_date || '')}</div></td><td class="num">${num(r.line_count)}</td><td class="num">${r.total != null ? money(r.total, r.currency) : '—'}</td><td><span class="badge info">${esc(r.status)}</span></td><td><a class="btn sm" href="/api/export/placement/${r.id}.xlsx">Export</a></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="muted small">No placements saved yet.</div>';
  };

  $('#view').innerHTML = `
    <div class="split">
      <div class="panel">
        <h2>New order placement <span class="muted small">— cost price + full-box quantities</span></h2>
        <div class="muted small" style="margin:6px 0 12px">Pick the supplier, load the lines from the purchase plan (or add products), set whole boxes, then save the placement or export it to send.</div>
        <div class="grid" style="grid-template-columns:1.4fr 1fr 1fr 1fr;gap:10px">
          <div class="field"><label>Supplier</label><select id="plSupplier"><option value="">— pick —</option>${suppliers.map((s) => `<option value="${esc(s.code)}">${esc(s.code)}${s.name ? ' · ' + esc(s.name) : ''}</option>`).join('')}</select></div>
          <div class="field"><label>Currency</label><input id="plCur" value="EUR" /></div>
          <div class="field"><label>Incoterm</label><input id="plInco" placeholder="FOB" /></div>
          <div class="field"><label>Order date</label><input id="plDate" type="date" value="${today}" /></div>
        </div>
        <div class="row" style="margin-top:8px"><button id="plPlan" class="ghost" type="button">Load from purchase plan</button></div>
        <div class="row" style="gap:10px;margin-top:14px;align-items:flex-end">
          <div class="field" style="flex:2"><label>Add a product</label>
            <div>
              <input data-pp-input id="plPP" placeholder="Search a product…" />
              <input data-pp-id type="hidden" />
              <div data-pp-results></div>
            </div>
          </div>
          <div class="field" style="flex:2"><label>Offer / supplier</label><select id="plOffer"><option value="">— pick a product first —</option></select></div>
          <button id="plAdd" class="ghost" type="button">Add line</button>
        </div>
        <div id="plLines" style="margin-top:14px"></div>
        <div id="plTotals" class="row" style="justify-content:space-between;margin-top:10px"></div>
        <div class="field" style="margin-top:10px"><label>Notes</label><input id="plNotes" placeholder="Payment terms, reference, etc." /></div>
        <div class="row" style="margin-top:12px;gap:10px"><button id="plSave">Save placement</button>${can('buyer') ? '' : '<span class="muted small">Buyer role needed to save</span>'}</div>
      </div>
      <div class="panel">
        <h2>Saved placements</h2>
        <div id="plList"><div class="muted small">Loading…</div></div>
      </div>
    </div>`;

  mountProductPicker($('#view'), async (pid) => {
    plPickedProduct = pid;
    try {
      const r = await GET(`/products/${pid}/compare`);
      plOffers = (r.offers || []).filter((o) => !o.isRetail && o.perBottle != null);
      $('#plOffer').innerHTML = plOffers.length ? plOffers.map((o) =>
        `<option value="${o.offerId}">${esc(o.supplier)} · ${money(o.perBottle, o.currency)}/btl${o.unitsPerCase > 1 ? ' · ' + o.unitsPerCase + '/case' : ''}</option>`
      ).join('') : '<option value="">— no priced offers —</option>';
    } catch (e) { toast(e.message, 'err'); }
  });

  $('#plPlan').addEventListener('click', async () => {
    const code = $('#plSupplier').value;
    if (!code) return toast('Pick a supplier first', 'err');
    try {
      const plan = await GET('/placements/plan?supplier=' + encodeURIComponent(code));
      if (!plan.lines.length) return toast('No purchase-plan lines for that supplier', 'err');
      plLines = plan.lines.map((l) => ({
        productId: l.productId, offerId: l.offerId, description: l.description, barcode: l.barcode,
        unitsPerCase: l.unitsPerCase,
        boxes: l.suggestedBoxes != null ? l.suggestedBoxes : (l.suggestedUnits || 1),
        unitCost: l.unitCost, moq: l.moq, orderMultiple: l.orderMultiple,
        warn: l.moq && l.unitsPerCase && (l.suggestedBoxes * l.unitsPerCase) < l.moq ? `below MOQ (${l.moq})` : '',
      }));
      if (plan.lines[0].currency) $('#plCur').value = plan.lines[0].currency;
      renderLines();
      toast('Loaded ' + plLines.length + ' line(s) from the plan', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });

  $('#plAdd').addEventListener('click', () => {
    const offerId = $('#plOffer').value;
    if (!plPickedProduct || !offerId) return toast('Pick a product then an offer', 'err');
    const o = plOffers.find((x) => String(x.offerId) === offerId);
    if (!o) return;
    plLines.push({ productId: plPickedProduct, offerId: o.offerId, description: o.description, barcode: null, unitsPerCase: o.unitsPerCase, boxes: 1, unitCost: o.perBottle, currency: o.currency });
    if (o.currency) $('#plCur').value = o.currency;
    renderLines();
  });

  $('#plCur').addEventListener('input', renderTotals);

  $('#plSave').addEventListener('click', async () => {
    if (!can('buyer')) return toast('Buyer role required to save', 'err');
    const supplierCode = $('#plSupplier').value;
    if (!supplierCode) return toast('Pick a supplier', 'err');
    if (!plLines.length) return toast('Add at least one line', 'err');
    const body = {
      supplierCode,
      currency: $('#plCur').value.trim() || 'EUR',
      incoterm: $('#plInco').value.trim() || undefined,
      orderDate: $('#plDate').value || undefined,
      notes: $('#plNotes').value.trim() || undefined,
      lines: plLines.map((l) => ({ productId: l.productId, offerId: l.offerId, description: l.description, unitsPerCase: l.unitsPerCase, boxes: Number(l.boxes) || 0, unitCost: l.unitCost })),
    };
    try {
      const r = await POST('/placements', body);
      toast('Placement saved (' + r.ref + ')', 'ok');
      plLines = [];
      renderLines();
      loadList();
    } catch (e) { toast(e.message, 'err'); }
  });

  renderLines();
  loadList();
};

routes.inventory = async () => {
  const [d, res] = await Promise.all([GET('/inventory'), GET('/reservations')]);
  const avail = {};
  for (const l of res.lots || []) avail[l.lotId] = l;
  $('#view').innerHTML = `
    <div class="grid cards" style="margin-bottom:16px">
      <div class="card"><div class="k">On hand</div><div class="v">${num(d.totals.on_hand)}</div></div>
      <div class="card"><div class="k">Reserved</div><div class="v">${num(d.totals.reserved)}</div></div>
      <div class="card"><div class="k">Available to sell</div><div class="v">${num((res.lots || []).reduce((s, l) => s + l.availableToSell, 0))}</div><div class="s">on hand − quarantined − reserved</div></div>
      <div class="card"><div class="k">In transit</div><div class="v">${num(d.totals.in_transit)}</div><div class="s">not yet sellable</div></div>
      <div class="card"><div class="k">Quarantined</div><div class="v">${num(d.totals.quarantined)}</div></div>
    </div>
    <div class="split">
      <div class="panel"><h2>Lots</h2>
        <div class="muted small" style="margin:6px 0 10px">Reserve stock for a demand or order so two traders cannot sell the same bottle. Reservations can never exceed usable stock (on hand minus quarantined).</div>
        <div class="table-wrap"><table><thead><tr><th>Product</th><th>Warehouse</th><th>Lot</th><th class="num">On hand</th><th class="num">Quar.</th><th class="num">Reserved</th><th class="num">Available</th><th class="num">In transit</th><th class="num">Unit cost</th><th>Expiry</th><th></th></tr></thead>
        <tbody>${d.rows.map((r) => {
          const a = avail[r.id] || { availableToSell: 0, reserved: r.reserved };
          return `<tr><td>${esc((r.display_name || '').slice(0, 40))}</td><td>${esc(r.warehouse || '')}</td><td class="mono">${esc(r.lot_reference || '')}</td><td class="num">${num(r.on_hand)}</td><td class="num">${num(r.quarantined)}</td><td class="num">${num(a.reserved)}</td><td class="num"><b>${num(a.availableToSell)}</b></td><td class="num">${num(r.in_transit)}</td><td class="num">${money(r.unit_cost)}</td><td class="small">${esc(r.expiry_date || '')}</td><td>${can('buyer') && a.availableToSell > 0 ? `<button class="btn sm" data-reserve="${r.id}">Reserve</button>` : ''}</td></tr>`;
        }).join('') || '<tr><td colspan="11" class="muted">No inventory.</td></tr>'}
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
    </div>
    <div class="panel" style="margin-top:16px"><h2>Reservations</h2>
      <div class="table-wrap"><table><thead><tr><th>Product</th><th>Lot</th><th class="num">Qty</th><th>Customer</th><th>Status</th><th>Created</th><th></th></tr></thead>
      <tbody>${(res.rows || []).map((r) => `<tr><td>${esc((r.display_name || '').slice(0, 32))}</td><td class="mono small">${esc(r.lot_reference || '')}</td><td class="num">${num(r.quantity)}</td><td class="small">${esc(r.customer_name || '—')}</td><td><span class="badge ${r.status === 'active' ? 'info' : 'good'}">${esc(r.status)}</span></td><td class="small muted">${esc(r.created_at || '')}</td><td>${r.status === 'active' && can('buyer') ? `<button class="btn sm" data-release="${r.id}">Release</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No reservations yet.</td></tr>'}
      </tbody></table></div>
    </div>`;
  for (const b of document.querySelectorAll('[data-reserve]')) {
    b.addEventListener('click', async () => {
      const qty = Number(prompt('Quantity to reserve', '1'));
      if (!(qty > 0)) return;
      try { await POST('/reservations', { lotId: Number(b.dataset.reserve), quantity: qty }); toast('Stock reserved', 'ok'); render(); }
      catch (e) { toast(e.message, 'err'); }
    });
  }
  for (const b of document.querySelectorAll('[data-release]')) {
    b.addEventListener('click', async () => {
      try { await POST(`/reservations/${b.dataset.release}/release`, {}); toast('Reservation released', 'ok'); render(); }
      catch (e) { toast(e.message, 'err'); }
    });
  }
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
        <div class="muted small" style="margin:6px 0 10px">Revising a demand creates a new version — the old one is kept, never overwritten. Once a demand is on an order it is locked and must not be rewritten.</div>
        <div class="table-wrap"><table><thead><tr><th>Customer</th><th>Product</th><th class="num">Qty</th><th>Status</th><th>Needed by</th><th>Approved</th><th></th></tr></thead>
        <tbody>${rows.filter((d) => d.status !== 'superseded').map((d) => `<tr><td>${esc(d.customer_name)}</td><td>${esc((d.display_name || '').slice(0, 40))}</td><td class="num">${num(d.quantity)}</td><td><span class="badge info">${esc(d.status)}</span></td><td class="small">${esc(d.needed_by || '')}</td><td>${d.approved ? '<span class="badge good">yes</span>' : '<span class="badge muted">no</span>'}</td><td class="nowrap"><button class="btn sm ghost" data-hist="${d.id}">History</button> ${can('buyer') ? `<button class="btn sm" data-revise="${d.id}">Revise</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No demands.</td></tr>'}
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
  for (const b of $$('#view [data-revise]')) {
    b.addEventListener('click', async () => {
      const id = b.dataset.revise;
      const d = rows.find((x) => String(x.id) === String(id));
      modal('Revise demand', `
        <div class="muted small" style="margin-bottom:8px">Current quantity <b>${num(d.quantity)}</b>. Saving creates a new version and keeps this one.</div>
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
          <div class="field"><label>New quantity</label><input id="rvQty" type="number" value="${d.quantity}" /></div>
          <div class="field"><label>Target price</label><input id="rvTarget" type="number" step="0.01" value="${d.target_price || ''}" /></div>
        </div>
        <div class="field" style="margin-bottom:8px"><label>Note</label><input id="rvNote" placeholder="why it changed" /></div>
        <button id="rvGo" style="width:100%">Save as new version</button>`, (bg) => {
        bg.querySelector('#rvGo').addEventListener('click', async () => {
          try {
            await POST(`/demands/${id}/revise`, {
              quantity: Number(bg.querySelector('#rvQty').value),
              target_price: bg.querySelector('#rvTarget').value === '' ? null : Number(bg.querySelector('#rvTarget').value),
              notes: bg.querySelector('#rvNote').value,
            });
            bg.remove(); toast('New version created', 'ok'); render();
          } catch (e) { toast(e.message, 'err'); }
        });
      });
    });
  }
  for (const b of $$('#view [data-hist]')) {
    b.addEventListener('click', async () => {
      try {
        const h = await GET(`/demands/${b.dataset.hist}/history`);
        modal('Demand history', `
          <div class="muted small" style="margin-bottom:8px">Every version, oldest first.</div>
          <div class="table-wrap"><table><thead><tr><th>Id</th><th class="num">Qty</th><th class="num">Target</th><th>Status</th><th>Created</th><th>Note</th></tr></thead>
          <tbody>${(h.versions || []).map((v) => `<tr><td class="mono">${v.id}${v.current ? ' <span class="badge info">current</span>' : ''}${v.locked ? ' <span class="badge warn">locked</span>' : ''}</td><td class="num">${num(v.quantity)}</td><td class="num">${v.target_price == null ? '—' : money(v.target_price)}</td><td>${esc(v.status)}</td><td class="small muted">${esc(v.captured_at || '')}</td><td class="small">${esc(v.notes || '')}</td></tr>`).join('')}</tbody></table></div>`, null);
      } catch (e) { toast(e.message, 'err'); }
    });
  }
};

routes.quotes = async () => {
  const rows = await GET('/quotes');
  const customers = await loadCustomers();
  $('#view').innerHTML = `
    <div class="split">
      <div class="panel"><h2>Deals &amp; quotes</h2>
        <div class="table-wrap"><table><thead><tr><th>Customer</th><th>Product</th><th>Supplier</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Margin</th><th class="num">Contribution</th><th class="num">ROI</th><th class="num">Capital</th><th>Cus due</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((q) => `<tr><td>${esc(q.customer_name)}</td><td>${esc((q.display_name || '').slice(0, 30))}</td><td>${q.supplier_code ? `<span class="badge info">${esc(q.supplier_code)}</span>` : '—'}</td><td class="num">${num(q.quantity)}</td><td class="num">${money(q.unit_price, q.currency)}</td><td class="num">${q.margin_pct != null ? `<span class="badge ${q.margin_pct >= 15 ? 'good' : 'bad'}">${pct(q.margin_pct)}</span>` : '—'}</td><td class="num">${q.contribution_total != null ? money(q.contribution_total, q.currency) : '—'}</td><td class="num">${q.roi_pct != null ? pct(q.roi_pct) : '—'}</td><td class="num">${q.capital_required != null ? money(q.capital_required, q.currency) : '—'}</td><td class="small">${esc(q.customer_due_date || '')}</td><td><span class="badge info">${esc(q.status)}</span></td><td><a class="btn sm" href="/api/export/quote/${q.id}.xlsx" download title="Customer quote (no costs)">Quote</a></td></tr>`).join('') || '<tr><td colspan="12" class="muted">No deals yet.</td></tr>'}
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
    <div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Currency</th><th>Price type</th><th class="num">Trade disc %</th><th>Incoterm</th><th>Stock ctry</th><th>Origin</th><th class="num">Duty %</th><th class="num">Freight/u</th><th class="num">Ins %</th><th class="num">Brok/u</th><th class="num">Hand/u</th><th class="num">Other tax %</th><th class="num">Recoverable tax %</th><th></th></tr></thead>
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
        <td class="num"><input data-f="recoverableTaxPct" type="number" step="0.01" value="${s.recoverable_tax_pct ?? ''}" style="width:64px" /></td>
        <td><button class="sm" data-save="${esc(s.code)}">Save</button></td>
      </tr>`).join('')}
    </tbody></table></div>
    <div class="muted small" style="margin-top:10px">Price type "rrp" means the supplier quotes retail; the trade discount converts it to our acquisition cost. Duty %, insurance % and other tax % are applied on the purchase cost; freight, brokerage and handling are per bottle. <b>Recoverable tax %</b> (VAT/IVA you get back) is deliberately NOT part of landed cost — it is cash you front and recover, so it only raises the capital you need. These feed the landed-cost engine (blank = unknown, shown as assumed).</div>
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
        <div class="muted small" style="margin-bottom:10px"><b>require_offer_approval</b> = <code>1</code> makes staff sign-off mandatory: an offer that has not been approved cannot win a sourcing comparison or drive a buying recommendation. Left as <code>0</code>, the review state is still recorded and shown on the Supplier Offers page but does not block trading. <b>followup_days</b> sets how long a captured lead has before its follow-up task is overdue.</div>
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
  const [rows, taskData] = await Promise.all([
    GET('/captures' + (status ? '?status=' + status : '')),
    GET('/tasks'),
  ]);
  const canPromote = can('buyer');
  const canIngest = can('analyst');
  const ts = taskData.summary || {};
  const openTasks = (taskData.rows || []).filter((t) => t.status === 'open');
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
    ${canIngest ? `
    <div class="panel" style="margin-bottom:12px">
      <div class="row" style="justify-content:space-between;align-items:center">
        <h2 style="margin:0">Follow-up tasks</h2>
        <div class="row">
          <span class="badge ${ts.overdue ? 'bad' : 'muted'}">${num(ts.overdue)} overdue</span>
          <span class="badge ${ts.dueToday ? 'warn' : 'muted'}">${num(ts.dueToday)} due today</span>
          <span class="badge info">${num(ts.open)} open</span>
        </div>
      </div>
      <div class="muted small" style="margin:6px 0 10px">Every captured note that looks like a lead gets a task automatically, so nothing rots in the inbox.</div>
      <div class="table-wrap"><table><thead><tr><th>Task</th><th>Due</th><th>Priority</th><th>Source</th><th></th></tr></thead>
      <tbody>${openTasks.map((t) => `<tr><td>${esc(t.title)}${t.detail ? `<div class="small muted">${esc(t.detail)}</div>` : ''}</td><td>${t.overdue ? `<span class="badge bad">${esc(t.due_date)}</span>` : `<span class="small">${esc(t.due_date || '—')}</span>`}</td><td><span class="badge ${t.priority === 'high' ? 'warn' : 'muted'}">${esc(t.priority)}</span></td><td class="small muted">${esc(t.capture_source || '')}</td><td>${canIngest ? `<button class="btn sm" data-task-done="${t.id}">Done</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No open follow-ups.</td></tr>'}
      </tbody></table></div>
    </div>` : ''}
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
  $$('#view [data-task-done]').forEach((b) => b.addEventListener('click', async () => {
    try { await POST('/tasks/' + b.dataset.taskDone + '/done', {}); toast('Follow-up done', 'ok'); render(); } catch (e) { toast(e.message, 'err'); }
  }));
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

routes.shipments = async () => {
  const [rows, drivers] = await Promise.all([GET('/shipments'), GET('/shipments/drivers')]);
  const canEdit = can('analyst');
  const totalCost = rows.reduce((s, r) => s + (Number(r.total_cost) || 0), 0);
  const unreconciled = rows.filter((r) => r.line_count > 0 && !r.reconciled).length;
  const draft = rows.filter((r) => r.line_count === 0).length;
  $('#view').innerHTML = `
    <div class="grid cards" style="margin-bottom:16px">
      <div class="card"><div class="k">Shipments</div><div class="v">${num(rows.length)}</div></div>
      <div class="card"><div class="k">Allocated cost</div><div class="v">${money(totalCost)}</div></div>
      <div class="card"><div class="k">Unreconciled</div><div class="v">${num(unreconciled)}</div><div class="s">allocations must tie to the shipment</div></div>
      <div class="card"><div class="k">Awaiting allocation</div><div class="v">${num(draft)}</div></div>
    </div>
    <div class="split">
      <div class="panel"><h2>Shipments</h2>
        <div class="muted small" style="margin:6px 0 10px">Each shipment's cost is split across its lines by one documented driver (chargeable weight, volume or declared value). The allocations always reconcile back to the shipment total.</div>
        <div class="table-wrap"><table><thead><tr><th>Ref</th><th>Dir</th><th>Cost type</th><th>Driver</th><th class="num">Total</th><th class="num">Allocated</th><th class="num">Diff</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="mono small">${esc(r.ref)}</td><td>${esc(r.direction)}</td><td>${esc(r.cost_type)}</td><td class="small muted">${esc(r.driver)}</td><td class="num">${money(r.total_cost, r.currency)}</td><td class="num">${money(r.allocated_total, r.currency)}</td><td class="num">${r.line_count ? (r.reconciled ? '<span class="badge good">0.00</span>' : `<span class="badge bad">${money(r.difference, r.currency)}</span>`) : '—'}</td><td><span class="badge ${r.status === 'reconciled' ? 'good' : (r.status === 'allocated' ? 'warn' : 'muted')}">${esc(r.status)}</span></td><td>${canEdit && r.line_count ? `<button class="btn sm" data-allocate="${r.id}">Allocate</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No shipments yet.</td></tr>'}
        </tbody></table></div>
      </div>
      ${canEdit ? `
      <div class="panel"><h2>Declare a shipment</h2>
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
          <div class="field"><label>Direction</label><select id="shpDir"><option value="inbound">inbound</option><option value="outbound">outbound</option></select></div>
          <div class="field"><label>Cost type</label><select id="shpType"><option>freight</option><option>duty</option><option>insurance</option><option>brokerage</option><option>handling</option><option>other</option></select></div>
          <div class="field"><label>Total cost</label><input id="shpCost" type="number" step="0.01" value="0" /></div>
          <div class="field"><label>Allocation driver</label><select id="shpDriver">${drivers.map((d) => `<option value="${esc(d.key)}">${esc(d.label)}</option>`).join('')}</select></div>
          <div class="field"><label>Currency</label><input id="shpCcy" value="USD" /></div>
          <div class="field"><label>Shipped date</label><input id="shpDate" type="date" /></div>
        </div>
        <div class="muted small" style="margin:10px 0 6px">Lines — one basis amount per line for the chosen driver. Format: <code>productId,qty,basis</code> (one per line).</div>
        <textarea id="shpLines" rows="5" class="mono" placeholder="1,120,4800&#10;2,60,2200"></textarea>
        <button id="shpAdd" style="margin-top:12px">Create shipment</button>
      </div>` : '<div class="panel muted">Analyst role required to declare shipments.</div>'}
    </div>`;

  if ($('#shpAdd')) $('#shpAdd').addEventListener('click', async () => {
    const lines = ($('#shpLines').value || '').split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => {
        const [productId, quantity, basisValue] = l.split(',').map((x) => Number(x.trim()));
        return { productId, quantity, basisValue };
      });
    try {
      await POST('/shipments', {
        direction: $('#shpDir').value, costType: $('#shpType').value,
        totalCost: Number($('#shpCost').value), driver: $('#shpDriver').value,
        currency: $('#shpCcy').value, shippedDate: $('#shpDate').value || undefined, lines,
      });
      toast('Shipment created', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('#view [data-allocate]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await POST(`/shipments/${b.dataset.allocate}/allocate`, {});
      toast(r.reconciled ? `Allocated — reconciles to ${money(r.allocatedTotal)}` : `Difference ${money(r.difference)}`, r.reconciled ? 'ok' : 'err');
      render();
    } catch (e) { toast(e.message, 'err'); }
  }));
};

routes.orders = async () => {
  const rows = await GET('/orders');
  const customers = await loadCustomers();
  const canEdit = can('buyer');
  const totalRealised = rows.filter(o => o.realised.settled).reduce((s, o) => s + o.realised.realisedMargin, 0);
  const open = rows.filter(o => !o.realised.settled).length;
  $('#view').innerHTML = `
    <div class="panel">
      <div class="row" style="justify-content:space-between">
        <div><h2>Orders &amp; payments</h2><div class="small muted">${rows.length} orders · ${open} open · realised margin ${money(totalRealised)}</div></div>
      </div>
      <div class="table-wrap" style="margin-top:12px"><table><thead><tr>
        <th>Ref</th><th>Customer</th><th>Product</th><th>Supplier</th><th>Status</th><th class="num">Qty</th>
        <th class="num">Forecast margin</th><th class="num">Realised</th><th class="num">Paid out/in</th><th class="num">Outstanding</th>
        <th class="num">XIRR</th><th></th>
      </tr></thead><tbody>
        ${rows.map((o) => {
          const r = o.realised;
          const marginCell = r.forecastMarginPct != null ? `<span class="badge ${r.forecastMarginPct >= 15 ? 'good' : 'bad'}">${money(r.forecastMargin)} / ${pct(r.forecastMarginPct)}</span>` : '—';
          const realCell = r.settled ? `<span class="badge good">${money(r.realisedMargin)}${r.marginVariance != null ? ` (${r.marginVariance >= 0 ? '+' : ''}${money(r.marginVariance)})` : ''}</span>` : '<span class="badge muted">open</span>';
          const outstanding = (!r.costSettled || !r.revenueSettled) ? `${money(r.costOutstanding)} / ${money(r.revenueOutstanding)}` : '<span class="badge good">settled</span>';
          const xirrCell = r.xirrPct != null
            ? `<span class="badge info" title="Money-weighted annualised return on the actual dated payments">${pct(r.xirrPct)}</span><div class="small muted">${num(r.daysFunded)}d funded</div>`
            : `<span class="badge muted" title="${esc(r.xirrReason || '')}">n/a</span>`;
          return `<tr>
            <td class="mono">${esc(o.ref || '')}</td>
            <td>${esc(o.customer_name || '')}</td>
            <td class="small">${esc((o.display_name || '').slice(0, 26))}</td>
            <td class="mono small">${esc(o.supplier_code || '')}</td>
            <td><select data-status="${o.id}" ${canEdit ? '' : 'disabled'} style="width:110px">${['draft','placed','received','shipped','delivered','closed','cancelled'].map((s) => `<option ${o.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
            <td class="num">${num(o.quantity)}</td>
            <td class="num">${marginCell}</td>
            <td class="num">${realCell}</td>
            <td class="num small">${money(r.paidOut)} / ${money(r.paidIn)}</td>
            <td class="num small">${outstanding}</td>
            <td class="num small">${xirrCell}</td>
            <td class="nowrap">${canEdit ? `<button class="sm" data-pay="${o.id}">Record payment</button>` : ''}</td>
          </tr>`;
        }).join('') || '<tr><td colspan="12" class="muted">No orders yet.</td></tr>'}
      </tbody></table></div>
    </div>
    ${canEdit ? `<div class="split" style="margin-top:14px">
      <div class="panel"><h2>New order</h2>
        <div class="field" style="margin-bottom:8px"><label>Customer</label><select id="orCust">${customers.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field" style="margin-bottom:8px"><label>Product</label>
          <div data-pp><input data-pp-input placeholder="search product…" /><input type="hidden" data-pp-id /><div data-pp-results style="margin-top:6px;max-height:150px;overflow:auto"></div></div></div>
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
          <div class="field"><label>Quantity</label><input id="orQty" type="number" value="100" /></div>
          <div class="field"><label>Currency</label><input id="orCur" value="USD" /></div>
          <div class="field"><label>Unit cost (forecast)</label><input id="orCost" type="number" step="0.01" /></div>
          <div class="field"><label>Unit price (forecast)</label><input id="orPrice" type="number" step="0.01" /></div>
        </div>
        <button id="orAdd" style="margin-top:12px">Create order</button>
        <div class="muted small" style="margin-top:8px">Create from a saved deal on the Deals page to prefill cost/price.</div>
      </div>
      <div class="panel"><h2>How realised margin works</h2>
        <div class="small muted">Each order carries a forecast cost and price. As payments are booked — outbound to the supplier, inbound from the customer — the platform recomputes the <b>realised</b> margin from cash actually moved, and compares it to the forecast once both sides are settled.</div>
      </div>
    </div>` : ''}`;
  if (canEdit) mountProductPicker($('#view'));
  if (canEdit) $('#orAdd').addEventListener('click', async () => {
    const productId = $('[data-pp-id]', $('#view')).value;
    if (!productId) return toast('Pick a product', 'err');
    try {
      await POST('/orders', {
        customerId: Number($('#orCust').value), productId, quantity: Number($('#orQty').value),
        currency: $('#orCur').value, unitCost: Number($('#orCost').value) || null, unitPrice: Number($('#orPrice').value) || null,
      });
      toast('Order created', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('#view [data-status]').forEach((sel) => sel.addEventListener('change', async () => {
    try { await POST('/orders/' + sel.dataset.status + '/status', { status: sel.value }); toast('Status updated', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  }));
  $$('#view [data-pay]').forEach((b) => b.addEventListener('click', () => {
    modal('Record payment', `
      <div class="field" style="margin-bottom:8px"><label>Direction</label><select id="payDir"><option value="inbound">Inbound — customer paid us</option><option value="outbound">Outbound — we paid supplier</option></select></div>
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
        <div class="field"><label>Amount</label><input id="payAmt" type="number" step="0.01" /></div>
        <div class="field"><label>Date</label><input id="payDate" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
      </div>
      <div class="field" style="margin-bottom:8px"><label>Method</label><input id="payMethod" placeholder="Transfer" /></div>
      <div class="field" style="margin-bottom:8px"><label>Reference</label><input id="payRef" /></div>
      <button id="payGo" style="margin-top:6px;width:100%">Record payment</button>`, (bg) => {
      bg.querySelector('#payGo').addEventListener('click', async () => {
        try {
          await POST('/orders/' + b.dataset.pay + '/payments', {
            direction: bg.querySelector('#payDir').value, amount: Number(bg.querySelector('#payAmt').value),
            paidDate: bg.querySelector('#payDate').value, method: bg.querySelector('#payMethod').value, reference: bg.querySelector('#payRef').value,
          });
          bg.remove(); toast('Payment recorded', 'ok'); render();
        } catch (e) { toast(e.message, 'err'); }
      });
    });
  }));
};

routes.trends = async () => {
  $('#view').innerHTML = `
    <div class="panel">
      <div class="row" style="justify-content:space-between">
        <div><h2>Price trends</h2><div class="small muted">Observed supplier price history. Date gaps are shown, never invented.</div></div>
        <div class="row"><button id="trRefresh" class="ghost">Refresh alerts</button></div>
      </div>
      <div class="field" style="margin:12px 0"><label>Product</label>
        <div data-pp><input data-pp-input placeholder="search product…" /><input type="hidden" data-pp-id /><div data-pp-results style="margin-top:6px;max-height:180px;overflow:auto"></div></div>
      </div>
      <div id="trOut" class="muted small">Pick a product to see every supplier that has quoted it, with the 7/30/90/180-day price movement where history supports it.</div>
    </div>`;
  function windowCell(w) {
    if (!w) return '<span class="badge muted">no data</span>';
    const cls = w.changePct > 0.01 ? 'bad' : (w.changePct < -0.01 ? 'good' : 'info');
    return `<span class="badge ${cls}">${w.changePct > 0 ? '+' : ''}${pct(w.changePct)}</span>`;
  }
  function spark(points) {
    if (points.length < 2) return '<span class="muted small">single observation</span>';
    const vals = points.map((p) => Number(p.unitCostBase));
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min || 1;
    return `<span class="spark">` + points.map((p, i) => {
      const prev = i > 0 ? Number(points[i - 1].unitCostBase) : Number(p.unitCostBase);
      const cls = Number(p.unitCostBase) > prev ? 'up' : (Number(p.unitCostBase) < prev ? 'down' : '');
      return `<i class="${cls}" title="${esc(p.observedAt.slice(0, 10))}: ${money(p.unitCostBase)}" style="height:${8 + Math.round((Number(p.unitCostBase) - min) / span * 20)}px"></i>`;
    }).join('') + `</span>`;
  }
  function renderTrends(d) {
    const series = d.series || [];
    if (!series.length) { $('#trOut').innerHTML = '<div class="badge muted">No price history for this product yet.</div>'; return; }
    $('#trOut').innerHTML = series.map((s) => {
      const obs = (s.points || []).map((p, i) => {
        const gap = i > 0 ? Math.round((Date.parse(p.observedAt) - Date.parse(s.points[i - 1].observedAt)) / 86400000) : null;
        return `<tr><td class="small">${esc(p.observedAt.slice(0, 10))}</td><td class="small muted">${esc(p.listDate || '')}</td><td class="num">${money(p.unitCostBase)}</td><td class="small muted">${p.fromImport ? 'import' : 'seeded'}</td><td class="small muted">${gap != null ? `+${gap}d` : '—'}</td></tr>`;
      }).join('');
      return `<div class="panel" style="margin-top:12px">
        <div class="row" style="justify-content:space-between;align-items:center">
          <div><span class="badge info mono">${esc(s.supplierCode)}</span> <span class="small muted">${s.observations} observation(s)</span></div>
          ${spark(s.points || [])}
        </div>
        <div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>7-day</th><th>30-day</th><th>90-day</th><th>180-day</th></tr></thead>
          <tbody><tr><td>${windowCell(s.windows.d7)}</td><td>${windowCell(s.windows.d30)}</td><td>${windowCell(s.windows.d90)}</td><td>${windowCell(s.windows.d180)}</td></tr></tbody></table></div>
        <div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Observed</th><th>List date</th><th class="num">Base/bottle</th><th>Source</th><th>Gap</th></tr></thead>
          <tbody>${obs}</tbody></table></div>
      </div>`;
    }).join('');
  }
  mountProductPicker($('#view'), async (pid) => {
    try { const d = await GET('/trends?productId=' + pid); renderTrends(d); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#trRefresh').addEventListener('click', async () => { try { await POST('/alerts/refresh'); toast('Alerts refreshed', 'ok'); } catch (e) { toast(e.message, 'err'); } });
};

routes.reports = async () => {
  const d = await GET('/reports');
  const integ = await GET('/integrations');
  const o = d.overview || {};
  const wins = Object.entries(d.wins || {});
  const maxWin = Math.max(1, ...wins.map((w) => w[1]));
  const exports = [
    ['opportunities', 'Cross-supplier opportunities', 'Cheapest vs dearest for the same barcode'],
    ['lowest', 'Lowest landed cost', 'Cheapest executable supplier per product'],
    ['deals', 'Deals & quotes', 'Saved deals with margin, ROI and capital'],
    ['orders', 'Orders & realised margin', 'Forecast vs actual cash margin'],
    ['alerts', 'Alerts', 'Price movements, expiry and stock alerts'],
    ['gl', 'GL journal (accounting)', 'Cash-basis double-entry from payments'],
    ['stock', 'Stock snapshot (warehouse)', 'Lots, on-hand, reserved, valuation'],
  ];
  $('#view').innerHTML = `
    <div class="grid cards">
      <div class="card"><div class="k">Realised margin</div><div class="v">${money(o.realisedMargin)}</div><div class="s">from settled orders</div></div>
      <div class="card"><div class="k">Open orders</div><div class="v">${num(o.ordersOpen)}</div><div class="s">${num(o.orders)} total</div></div>
      <div class="card"><div class="k">Overlap products</div><div class="v">${num(o.overlapProducts)}</div><div class="s">sourced from 2+ suppliers</div></div>
      <div class="card"><div class="k">Open exceptions</div><div class="v">${num(o.openExceptions)}</div><div class="s">need review</div></div>
    </div>
    <div class="split" style="margin-top:16px">
      <div class="panel"><h2>Excel exports</h2>
        <div class="table-wrap"><table><thead><tr><th>Report</th><th>Contents</th><th></th></tr></thead><tbody>
          ${exports.map(([k, t, s]) => `<tr><td>${esc(t)}</td><td class="muted small">${esc(s)}</td><td><a class="btn sm" href="/api/export/${k}.xlsx" download>Download .xlsx</a></td></tr>`).join('')}
        </tbody></table></div>
      </div>
      <div class="panel"><h2>Cheapest-supplier wins</h2>
        ${wins.map(([k, v]) => `<div class="row" style="align-items:center;gap:10px;margin-bottom:6px"><div style="width:90px" class="small mono">${esc(k)}</div><div class="progress" style="flex:1"><i style="width:${(v / maxWin) * 100}%"></i></div><div class="small num" style="width:44px">${v}</div></div>`).join('') || '<div class="muted">No overlap yet.</div>'}
      </div>
    </div>
    <div class="panel" style="margin-top:16px"><h2>Supplier performance</h2>
      <div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Currency</th><th>Price type</th><th class="num">Offers</th><th class="num">Unmatched</th><th class="num">Invalid barcodes</th></tr></thead>
      <tbody>${(d.suppliers || []).map((s) => `<tr><td class="mono">${esc(s.code)}</td><td>${esc(s.name)}</td><td>${esc(s.currency)}</td><td>${esc(s.price_type)}</td><td class="num">${num(s.offers)}</td><td class="num">${num(s.unmatched)}</td><td class="num">${num(s.invalid_barcodes)}</td></tr>`).join('')}
      </tbody></table></div>
    </div>
    <div class="panel" style="margin-top:16px"><h2>Integrations</h2>
      <div class="muted small" style="margin:6px 0 10px">Machine-readable contract for pulling data into accounting, a WMS, or a lab system. These are live endpoints on this instance.</div>
      <div class="table-wrap"><table><thead><tr><th>Direction</th><th>What</th><th>Endpoint</th><th>Auth</th></tr></thead><tbody>
        ${(integ.exports || []).map((e) => `<tr><td><span class="badge info">export</span></td><td>${esc(e.kind)}</td><td class="mono small">GET ${esc(e.url)}</td><td class="small muted">${esc(e.auth)}</td></tr>`).join('')}
        <tr><td><span class="badge info">export</span></td><td>Customer quote (cost-masked)</td><td class="mono small">GET ${esc(integ.quote.url)}</td><td class="small muted">${esc(integ.quote.auth)}</td></tr>
        <tr><td><span class="badge ok">webhook</span></td><td>Inbound capture</td><td class="mono small">POST ${esc(integ.webhook.url)}</td><td class="small muted">${esc(integ.webhook.auth)}</td></tr>
      </tbody></table></div>
    </div>`;
};

routes.forecast = async () => {
  const d = await GET('/forecast');
  const rows = d.byProduct || [];
  const ok = rows.filter((r) => r.sufficient);
  const no = rows.filter((r) => !r.sufficient);
  const spark = (obs) => {
    if (!obs || obs.length < 2) return '';
    const q = obs.map((o) => o.quantity);
    const max = Math.max(...q, 1);
    const w = 160, h = 28, step = obs.length > 1 ? w / (obs.length - 1) : w;
    const pts = q.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`).join(' ');
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" /></svg>`;
  };
  $('#view').innerHTML = `
    <div class="grid cards">
      <div class="card"><div class="k">Products with history</div><div class="v">${num(rows.length)}</div><div class="s">delivered orders</div></div>
      <div class="card"><div class="k">Forecastable</div><div class="v">${num(ok.length)}</div><div class="s">≥ ${num(d.minObservations)} months of deliveries</div></div>
      <div class="card"><div class="k">Insufficient history</div><div class="v">${num(no.length)}</div><div class="s">no forecast produced</div></div>
      <div class="card"><div class="k">Open demands</div><div class="v">${num((d.demands || []).length)}</div><div class="s">for context</div></div>
    </div>
    <div class="panel" style="margin-top:16px"><h2>Demand baseline (30-day)</h2>
      <div class="muted small" style="margin:6px 0 10px">A simple moving average of delivered quantity. Products with fewer than ${num(d.minObservations)} delivery months are listed but <strong>not</strong> forecast — we refuse to extrapolate noise.</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Product</th><th>Monthly history</th><th class="num">Months</th><th class="num">Avg/month</th><th class="num">Avg/week</th><th class="num">30-day</th><th>Confidence</th></tr></thead>
        <tbody>
          ${ok.map((r) => `<tr>
            <td>${esc(r.productName)}</td>
            <td>${spark(r.observations)}</td>
            <td class="num">${num(r.months)}</td>
            <td class="num">${num(r.avgPerMonth, 1)}</td>
            <td class="num">${num(r.avgPerWeek, 2)}</td>
            <td class="num">${num(r.forecastQty30d)}</td>
            <td><span class="badge ok">${esc(r.confidence)}</span></td>
          </tr>`).join('') || '<tr><td colspan="7" class="muted">No product has enough delivery history yet.</td></tr>'}
        </tbody></table></div>
    </div>
    <div class="panel" style="margin-top:16px"><h2>Insufficient history</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Product</th><th class="num">Months observed</th><th>Why no forecast</th></tr></thead>
        <tbody>${no.map((r) => `<tr><td>${esc(r.productName)}</td><td class="num">${num(r.months)}</td><td class="small muted">${esc(r.reason || '')}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">—</td></tr>'}
        </tbody></table></div>
    </div>`;
};

routes.performance = async () => {
  const k = await GET('/kpis');
  const s = k.summary || {};
  const c = k.cash || {};
  const st = k.stock || {};
  const b = k.buying || {};
  const q = k.quality || {};
  const alertTotals = (q.alerts && q.alerts.total) || 0;
  const card = (label, value, sub) => `<div class="card"><div class="k">${esc(label)}</div><div class="v">${value}</div><div class="s">${sub || ''}</div></div>`;
  $('#view').innerHTML = `
    <div class="panel"><h2>Profitability</h2>
      <div class="grid cards">
        ${card('Revenue (collected)', money(s.revenue, k.baseCurrency), 'from settled orders')}
        ${card('Cost paid', money(s.costPaid, k.baseCurrency), 'cash out')}
        ${card('Gross profit', money(s.grossProfit, k.baseCurrency), 'revenue − cost')}
        ${card('Gross margin', pct(s.grossMarginPct), `${num(s.ordersSettled)} settled · ${num(s.ordersOpen)} open`)}
      </div>
    </div>
    <div class="panel" style="margin-top:16px"><h2>Cash &amp; capital</h2>
      <div class="grid cards">
        ${card('Receivable (AR)', money(c.ar, k.baseCurrency), 'owed by customers')}
        ${card('Payable (AP)', money(c.ap, k.baseCurrency), 'owed to suppliers')}
        ${card('Working capital', money(c.workingCapital, k.baseCurrency), 'AR − AP')}
        ${card('Capital required', money(c.capitalRequired, k.baseCurrency), `limit ${money(c.capitalLimit)} · ${c.overCapital ? '<span class="badge bad">over</span>' : '<span class="badge ok">within</span>'}`)}
      </div>
    </div>
    <div class="split" style="margin-top:16px">
      <div class="panel"><h2>Stock</h2>
        <div class="grid cards">
          ${card('Units on hand', num(st.inventoryUnits), 'across all lots')}
          ${card('Stock at cost', money(st.inventoryCost, k.baseCurrency), 'valued at lot cost')}
          ${card('Days inventory', st.daysInventory != null ? num(st.daysInventory, 1) : '—', 'at current run-rate')}
          ${card('Write-down risk', money(st.writeDownRisk, k.baseCurrency), 'expired lots (est. 10%)')}
        </div>
      </div>
      <div class="panel"><h2>Buying &amp; quality</h2>
        <div class="grid cards">
          ${card('Open demands', num(b.openDemands), `${num(b.planItems)} in plan`)}
          ${card('Actionable buys', num(b.recsActionable), `of ${num(b.recsTotal)} recommendations`)}
          ${card('Open exceptions', num(q.openExceptions), 'rows needing review')}
          ${card('Unread alerts', num(alertTotals), `${num(q.priceMovers)} price movers`)}
        </div>
      </div>
    </div>`;
};

routes.buying = async () => {
  const only = state._recActionable ? '?actionable=1' : '';
  const d = await GET('/recommendations' + only);
  state._recs = d.rows || [];
  const s = d.summary || {};
  const recStatus = (r) => {
    if (!r.supplier) return ['bad', 'No supplier'];
    if (!r.executable) return ['warn', 'Not executable'];
    if (r.meetsPolicy === false) return ['bad', 'Below margin policy'];
    if (r.withinCapitalLimit === false) return ['warn', 'Over capital limit'];
    if (r.missing && r.missing.length) return ['warn', 'Missing inputs'];
    if (!r.approved) return ['info', 'Needs approval'];
    return ['ok', 'Ready'];
  };
  $('#view').innerHTML = `
    <div class="grid cards">
      <div class="card"><div class="k">Open demands</div><div class="v">${num(s.count)}</div><div class="s">products with live demand</div></div>
      <div class="card"><div class="k">Actionable now</div><div class="v">${num(s.actionable)}</div><div class="s">executable &amp; within policy</div></div>
      <div class="card"><div class="k">Total contribution</div><div class="v">${money(s.totalContribution)}</div><div class="s">if all recommended</div></div>
      <div class="card"><div class="k">Capital required</div><div class="v">${money(s.totalCapital)}</div><div class="s">peak cash at these volumes</div></div>
    </div>
    <div class="panel" style="margin-top:16px">
      <div class="row" style="justify-content:space-between;align-items:center">
        <h2 style="margin:0">Buying recommendations</h2>
        <label class="small"><input type="checkbox" id="recOnly" ${state._recActionable ? 'checked' : ''}/> actionable only</label>
      </div>
      <div class="muted small" style="margin:6px 0 10px">Match live customer demand to the cheapest executable supplier, rounded to the supplier's MOQ/order multiple, priced against margin policy and your capital limit.</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Product</th><th class="num">Order qty</th><th>Supplier</th><th class="num">Landed/unit</th><th class="num">Sell</th><th class="num">Margin</th><th class="num">Contribution</th><th class="num">Capital</th><th>Collect</th><th>Status</th><th></th></tr></thead>
        <tbody>${state._recs.map((r) => {
          const [k, label] = recStatus(r);
          return `<tr data-rec="${r.productId}">
            <td>${esc(r.product.displayName)}<div class="muted small mono">${esc(r.product.canonicalGtin || '')}</div></td>
            <td class="num">${num(r.orderQuantity)}<div class="muted small">demand ${num(r.demandQuantity)}</div></td>
            <td>${r.supplier ? esc(r.supplier.code) : '<span class="muted">—</span>'}</td>
            <td class="num">${money(r.landedUnitCost)}</td>
            <td class="num">${money(r.suggestedSell)}<div class="muted small">${esc(r.sellSource || '')}</div></td>
            <td class="num">${pct(r.marginPct)}</td>
            <td class="num">${money(r.contribution)}</td>
            <td class="num">${money(r.cashRequirement)}</td>
            <td class="small">${r.expectedCollection ? esc(r.expectedCollection) : '—'}</td>
            <td><span class="badge ${k}">${esc(label)}</span></td>
            <td class="nowrap">
              <button class="sm ghost" data-recdetail="${r.productId}">Why</button>
              ${can('buyer') && r.supplier && r.suggestedSell ? `<button class="sm" data-recquote="${r.productId}">Quote</button>` : ''}
            </td>
          </tr>`;
        }).join('') || '<tr><td colspan="11" class="muted">No open demand to recommend against.</td></tr>'}
        </tbody></table></div>
    </div>`;
  if ($('#recOnly')) $('#recOnly').addEventListener('change', (e) => { state._recActionable = e.target.checked; render(); });
  $$('#view [data-recdetail]').forEach((b) => b.addEventListener('click', () => showRecDetail(Number(b.dataset.recdetail))));
  $$('#view [data-recquote]').forEach((b) => b.addEventListener('click', () => quoteFromRec(Number(b.dataset.recquote))));
};

function showRecDetail(productId) {
  const r = (state._recs || []).find((x) => x.productId === productId);
  if (!r) return;
  modal(`Recommendation — ${r.product.displayName}`, `
    <div class="grid cards" style="grid-template-columns:repeat(2,1fr)">
      <div class="card"><div class="k">Order quantity</div><div class="v">${num(r.orderQuantity)}</div><div class="s">demand ${num(r.demandQuantity)}${r.neededBy ? ', needed by ' + esc(r.neededBy) : ''}</div></div>
      <div class="card"><div class="k">Suggested sell</div><div class="v">${money(r.suggestedSell)}</div><div class="s">${esc(r.sellSource || '')}${r.policyFloor != null ? ' · policy floor ' + money(r.policyFloor) : ''}</div></div>
      <div class="card"><div class="k">Contribution</div><div class="v">${money(r.contribution)}</div><div class="s">margin ${pct(r.marginPct)} · markup ${money(r.markup)}</div></div>
      <div class="card"><div class="k">Capital</div><div class="v">${money(r.cashRequirement)}</div><div class="s">limit ${money(r.capitalLimit)} · ${r.withinCapitalLimit ? 'within' : 'over'}</div></div>
    </div>
    <h2 style="margin-top:16px">Customers</h2>
    <div class="table-wrap"><table><thead><tr><th>Customer</th><th>Region</th><th class="num">Qty</th><th class="num">Target</th><th>Needed by</th><th>Status</th></tr></thead>
      <tbody>${r.customers.map((c) => `<tr><td>${esc(c.customerName)}</td><td>${esc(c.region || '')}</td><td class="num">${num(c.quantity)}</td><td class="num">${c.targetPrice != null ? money(c.targetPrice) : '—'}</td><td>${esc(c.neededBy || '—')}</td><td>${esc(c.status)}${c.approved ? ' · approved' : ''}</td></tr>`).join('')}</tbody></table></div>
    <h2 style="margin-top:16px">Supplier candidates</h2>
    <div class="table-wrap"><table><thead><tr><th>Supplier</th><th class="num">Landed/unit</th><th>Executable</th><th>Notes</th></tr></thead>
      <tbody>${r.candidates.map((c) => `<tr><td class="mono">${esc(c.supplier)}</td><td class="num">${money(c.landedUnitCost)}</td><td>${c.executable ? '<span class="badge ok">yes</span>' : '<span class="badge warn">no</span>'}</td><td class="small muted">${esc((c.reasons || []).join('; ') || (c.complete ? 'complete' : 'incomplete inputs'))}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No priced supplier.</td></tr>'}</tbody></table></div>
    ${r.warnings && r.warnings.length ? `<h2 style="margin-top:16px">Warnings</h2><ul class="small muted">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    ${r.missing && r.missing.length ? `<h2 style="margin-top:16px">Missing assumptions</h2><div class="small">${r.missing.map((m) => `<span class="badge warn">${esc(m)}</span>`).join(' ')}</div>` : ''}
  `);
}

function quoteFromRec(productId) {
  const r = (state._recs || []).find((x) => x.productId === productId);
  if (!r) return;
  const cust = r.customers[0] || {};
  modal('Create quote from recommendation', `
    <div class="muted small" style="margin-bottom:10px">${esc(r.product.displayName)} — ${esc(r.supplier.code)} @ ${money(r.landedUnitCost)} landed</div>
    <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
      <div class="field"><label>Customer</label><input id="recCust" value="${esc(cust.customerName || '')}" disabled /></div>
      <div class="field"><label>Quantity</label><input id="recQty" type="number" value="${r.orderQuantity}" /></div>
      <div class="field"><label>Unit price</label><input id="recPrice" type="number" step="0.01" value="${r.suggestedSell}" /></div>
      <div class="field"><label>Validity</label><input id="recValid" type="date" /></div>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button id="recGo">Create quote</button></div>
  `, (bg) => {
    bg.querySelector('#recGo').addEventListener('click', async () => {
      try {
        const res = await POST('/quotes', {
          customerId: cust.customerId,
          productId: r.productId,
          demandId: cust.demandId,
          quantity: Number(bg.querySelector('#recQty').value),
          unitPrice: Number(bg.querySelector('#recPrice').value),
          landedUnitCost: r.landedUnitCost,
          currency: r.baseCurrency,
          validityDate: bg.querySelector('#recValid').value || null,
          terms: 'From demand recommendation',
        });
        toast('Quote created (margin ' + res.marginPct + '%)');
        bg.remove();
        render();
      } catch (e) { toast(e.message, 'bad'); }
    });
  });
}

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
  builder: ['Offer Builder', 'Cost price → selling price at a target margin'],
  lists: ['Compare Lists', 'Diff two uploaded price lists by barcode or description'],
  inventory: ['Inventory', 'Lots, reservations and in-transit stock'],
  customers: ['Customers', 'Buyers and commercial terms'],
  demands: ['Demand Book', 'Customer requests to match against supply'],
  quotes: ['Deals & Quotes', 'Saved deals with contribution, ROI and cash flow'],
  suppliers: ['Suppliers & Terms', 'Price type, trade discount and Incoterms'],
  settings: ['Settings & FX', 'Policy thresholds and currency rates'],
  captures: ['Capture Inbox', 'Notes from Plaud / reMarkable turned into demand signals'],
  alerts: ['Alerts', 'Price movements, expiring offers and stock alerts'],
  trends: ['Price Trends', 'Observed supplier price history with date gaps shown'],
  buying: ['Buying', 'Match live demand to the cheapest executable supplier'],
  forecast: ['Demand Forecast', 'Moving-average baseline, honest about thin history'],
  reports: ['Reports & Exports', 'Supplier performance and one-click Excel exports'],
  performance: ['Performance', 'Profitability, cash, capital and stock KPIs'],
  orders: ['Orders & Payments', 'Purchase/sales orders, payments and realised vs forecast margin'],
  placements: ['Order Placement', 'Supplier order with cost price and full-box quantities, ready to send'],
  shipments: ['Shipment Costs', 'Allocate freight, duty and handling across the lines they belong to'],
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
