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
  reports: ['Reports & Exports', 'Supplier performance and one-click Excel / PDF exports'],
  performance: ['Performance', 'Profitability, cash, capital and stock KPIs'],
  orders: ['Orders & Payments', 'Purchase/sales orders, payments and realised vs forecast margin'],
  placements: ['Order Placement', 'Supplier order with cost price and full-box quantities, ready to send'],
  shipments: ['Shipment Costs', 'Allocate freight, duty and handling across the lines they belong to'],
  users: ['Users & Roles', 'Accounts and role-based access'],
  audit: ['Audit Log', 'Who did what, when'],
  'ai-chat': ['AI Assistant', 'A copilot that can read the whole system and prepare drafts for you to confirm'],
};

function updateUserUI() {
  decorateNav();
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
    wireView();
  } catch (e) {
    $('#view').innerHTML = `<div class="panel"><span class="badge bad">Error</span> ${esc(e.message)}</div>`;
  }
}

function go(route) {
  state.route = route;
  viewSearch = '';
  if (location.hash.slice(1) !== route) location.hash = route;
  render();
}

window.addEventListener('hashchange', () => {
  const r = location.hash.slice(1) || 'dashboard';
  if (r !== state.route && routes[r]) { state.route = r; viewSearch = ''; render(); }
});

$$('#nav a').forEach((a) => a.addEventListener('click', () => {
  go(a.dataset.route);
}));
$('#refreshBtn').addEventListener('click', () => { loadSettings().then(render); });
(function initDensity() {
  const btn = $('#densityBtn');
  const apply = (compact) => {
    document.body.classList.toggle('density-compact', compact);
    if (btn) btn.textContent = compact ? 'Comfortable' : 'Compact';
    try { localStorage.setItem('perfumes.density', compact ? 'compact' : 'comfortable'); } catch (_) {}
  };
  apply(localStorage.getItem('perfumes.density') === 'compact');
  if (btn) btn.addEventListener('click', () => apply(!document.body.classList.contains('density-compact')));
})();

// Inline form validation: mark empty/invalid fields before submit.
function markField(input, ok, msg) {
  const field = input && input.closest('.field');
  if (!field) return ok;
  let err = field.querySelector('.errmsg');
  if (!err) {
    err = document.createElement('div');
    err.className = 'errmsg';
    field.appendChild(err);
  }
  field.classList.toggle('err', !ok);
  err.textContent = ok ? '' : (msg || 'Required');
  return ok;
}
function validateRequired(form) {
  let good = true;
  $$('[data-req]', form).forEach((inp) => {
    const bad = !String(inp.value || '').trim();
    if (!markField(inp, !bad)) good = false;
  });
  if (!good) { $$('.field.err input', form)[0]?.focus(); toast('Fix the highlighted fields', 'err'); }
  return good;
}

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
    initAssistant();
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

/* ============================ AI assistant ============================ */
// A chat panel that reads the system through server-side tools and prepares
// drafts (quotes, placements, demands, orders, tasks). It never saves on its
// own: a proposal card has an Apply button that runs the normal, role-checked
// API under the user. Replies stream in over SSE; the transcript is kept in
// localStorage so a reload does not lose the conversation.
const chat = { messages: [], enabled: null, model: '', models: [], streaming: false, controller: null };
const CONVOS_KEY = 'perfumes.chat.convos.v1';
const LEGACY_CHAT_KEY = 'perfumes.chat.v1';
let convos = [];
let activeConvoId = null;
let pendingFiles = [];
const TOOL_LABELS = {
  search_products: 'looking up products',
  product_prices: 'checking supplier prices',
  lowest_cost: 'calculating landed cost',
  list_suppliers: 'reading suppliers',
  supplier_scorecards: 'scoring suppliers',
  rank_opportunities: 'ranking opportunities',
  aging_report: 'checking stock aging',
  customer_kpis: 'checking customer KPIs',
  forecast_backtest: 'backtesting the forecast',
  list_customers: 'reading customers',
  list_demands: 'reading the demand book',
  get_settings: 'reading settings',
  dashboard_overview: 'reading the dashboard',
  list_alerts: 'checking alerts',
  list_orders: 'checking orders',
  get_order: 'reading that order',
  list_inventory: 'checking stock',
  list_exceptions: 'checking exceptions',
  list_captures: 'checking the capture inbox',
  list_tasks: 'checking tasks',
  purchase_plan: 'consolidating the purchase plan',
  price_movers: 'checking price movers',
  product_history: 'reading price history',
  compare_quotes: 'comparing quotes',
  demand_forecast: 'running the forecast',
  export_info: 'checking export options',
  draft_offer: 'preparing an offer draft',
  draft_placement: 'preparing a placement draft',
  draft_demand: 'preparing a demand draft',
  draft_order: 'preparing an order draft',
  draft_task: 'preparing a task draft',
  list_quotes: 'reading quotes',
  auto_purchase_preview: 'previewing auto-purchase',
  list_placements: 'reading supplier orders',
  list_shipments: 'reading shipments',
  list_reservations: 'checking reservations',
  get_kpis: 'reading performance KPIs',
  list_uploads: 'reading import history',
  list_audit: 'reading the audit log',
  list_fx: 'reading FX rates',
  list_users: 'reading users',
  list_pfi: 'reading PFIs',
  get_recommendations: 'checking buying recommendations',
  price_calculate: 'running the pricing calculator',
  deal_compute: 'computing deal economics',
  compare_uploads: 'comparing supplier lists',
  draft_reservation: 'preparing a reservation draft',
  draft_shipment: 'preparing a shipment draft',
  draft_exception: 'preparing an exception resolution',
  ai_diagnose: 'checking AI provider health',
};

// ---- conversations: start a new chat and switch back to previous ones ----
function newConvoId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function convTitle(messages) {
  const firstUser = (messages || []).find((m) => m && m.role === 'user' && m.content);
  if (!firstUser) return 'New chat';
  const t = String(firstUser.content).replace(/\s+/g, ' ').trim();
  return t.length > 42 ? t.slice(0, 42) + '…' : (t || 'New chat');
}

function slimMessages(messages) {
  return (messages || [])
    .filter((m) => m && (m.role === 'user' || (m.role === 'assistant' && m.content) || m.role === 'proposal'))
    .slice(-60)
    .map((m) => {
      if (m.role === 'proposal') return { role: 'proposal', proposal: m.proposal };
      const o = { role: m.role, content: m.content };
      if (m.send) o.send = m.send;
      if (m.files && m.files.length) o.files = m.files;
      return o;
    });
}

function loadChatHistory() {
  try {
    const raw = localStorage.getItem(CONVOS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) convos = arr.filter((c) => c && c.id && Array.isArray(c.messages));
    }
  } catch (_) { /* corrupt history is not worth an error */ }
  // Migrate a legacy single conversation, so nothing is lost on upgrade.
  if (!convos.length) {
    try {
      const raw = localStorage.getItem(LEGACY_CHAT_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr) && arr.length) {
        convos = [{ id: newConvoId(), title: convTitle(arr), updatedAt: Date.now(), messages: arr }];
      }
    } catch (_) { /* ignore */ }
  }
  if (!convos.length) convos = [{ id: newConvoId(), title: 'New chat', updatedAt: Date.now(), messages: [] }];
  convos.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  activeConvoId = convos[0].id;
  chat.messages = convos[0].messages;
  pendingFiles = [];
  renderChatHistory();
  renderAttachments();
}

function saveChatHistory() {
  try {
    const active = convos.find((c) => c.id === activeConvoId);
    if (active) {
      active.messages = slimMessages(chat.messages);
      active.title = convTitle(chat.messages);
      active.updatedAt = Date.now();
    }
    localStorage.setItem(CONVOS_KEY, JSON.stringify(convos));
    try { localStorage.removeItem(LEGACY_CHAT_KEY); } catch (_) { /* ignore */ }
  } catch (_) { /* storage full or blocked: keep chatting without history */ }
  renderChatHistory();
}

function renderChatHistory() {
  const sel = $('#chatHistory');
  if (!sel) return;
  const sorted = convos.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  sel.innerHTML = sorted.map((c) => `<option value="${esc(c.id)}">${esc(c.title || 'New chat')}</option>`).join('');
  if (activeConvoId) sel.value = activeConvoId;
}

function newChat() {
  if (chat.streaming) stopChat();
  saveChatHistory();
  const c = { id: newConvoId(), title: 'New chat', updatedAt: Date.now(), messages: [] };
  convos.unshift(c);
  activeConvoId = c.id;
  chat.messages = c.messages;
  pendingFiles = [];
  renderAttachments();
  const input = $('#chatInput');
  if (input) { input.value = ''; input.focus(); }
  renderChat();
  renderChatHistory();
}

function openChat(id) {
  if (!id || id === activeConvoId) return;
  if (chat.streaming) stopChat();
  saveChatHistory();
  const c = convos.find((x) => x.id === id);
  if (!c) return;
  activeConvoId = id;
  chat.messages = c.messages;
  pendingFiles = [];
  renderAttachments();
  renderChat();
  renderChatHistory();
}

async function openAssistant() {
  if (!$('#chatLauncher')) await initAssistant();
  const panel = $('#chatPanel');
  if (panel) {
    panel.classList.remove('hidden');
    const input = $('#chatInput');
    if (input) input.focus();
  }
}

// ---- attachments: any file type; text files are read into the prompt ----
const TEXT_EXT = ['txt', 'csv', 'tsv', 'md', 'json', 'xml', 'html', 'htm', 'js', 'ts', 'log', 'yaml', 'yml', 'ini', 'sql', 'rtf'];

function humanSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function isTextFile(f) {
  const type = (f.type || '').toLowerCase();
  const ext = (String(f.name).split('.').pop() || '').toLowerCase();
  return type.startsWith('text/') || type === 'application/json' || type === 'application/xml' || TEXT_EXT.includes(ext);
}

async function addFiles(fileList) {
  const arr = Array.from(fileList || []);
  const totalTextBudget = 60000; // keep the request under the server's 5 MB body limit
  let used = pendingFiles.reduce((n, f) => n + (f.text ? f.text.length : 0), 0);
  for (const f of arr) {
    const item = { name: f.name, size: f.size, type: f.type || '' };
    try {
      if (isTextFile(f) && f.size <= 512 * 1024 && used < totalTextBudget) {
        const text = await f.text();
        const room = totalTextBudget - used;
        item.text = text.length > room ? text.slice(0, room) + '\n…[truncated]' : text;
        used += item.text.length;
      }
    } catch (_) { /* unreadable file: attach by name only */ }
    pendingFiles.push(item);
  }
  renderAttachments();
}

function attachmentsPrompt(files) {
  if (!files || !files.length) return '';
  const parts = files.map((f) => {
    let s = `- ${f.name} (${humanSize(f.size)}${f.type ? ', ' + f.type : ''})`;
    if (f.text) s += `\n\`\`\`\n${f.text}\n\`\`\``;
    return s;
  });
  return '\n\nAttached files:\n' + parts.join('\n');
}

function renderAttachments() {
  for (const id of ['chatAttach', 'chatAttachPage']) {
    const box = document.getElementById(id);
    if (!box) continue;
    if (!pendingFiles.length) { box.classList.add('hidden'); box.innerHTML = ''; continue; }
    box.classList.remove('hidden');
    box.innerHTML = pendingFiles.map((f, i) => `<span class="chat-file" title="${esc(f.name)}">${icon('paperclip', 12)} ${esc(f.name)} <span class="muted">${humanSize(f.size)}</span> <button class="chat-file-x" data-file-rm="${i}" aria-label="Remove attachment">×</button></span>`).join('');
    box.querySelectorAll('[data-file-rm]').forEach((b) => b.addEventListener('click', () => {
      pendingFiles.splice(Number(b.dataset.fileRm), 1);
      renderAttachments();
    }));
  }
}

// Minimal, safe markdown: text is escaped first, then only these constructs
// are turned into tags — bold, inline code, http(s) links, bullet/numbered
// lists. Enough for the assistant's style; no raw HTML ever passes through.
function md(s) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = h.split('\n');
  let out = '';
  let inUl = false;
  let inOl = false;
  const closeLists = () => {
    if (inUl) { out += '</ul>'; inUl = false; }
    if (inOl) { out += '</ol>'; inOl = false; }
  };
  let inTable = false;
  const tableCells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const closeTable = () => { if (inTable) { out += '</tbody></table>'; inTable = false; } };
  for (const line of lines) {
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const isTableRow = /^\s*\|.*\|\s*$/.test(line);
    const isTableSep = /^\s*\|[\s:|-]+\|\s*$/.test(line);
    if (isTableSep) continue;
    if (isTableRow) {
      closeLists();
      const cells = tableCells(line).map((c) => c.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'));
      if (!inTable) { out += '<table><tbody>'; inTable = true; }
      const tag = out.includes('<tbody>') && out.lastIndexOf('<tr>') === -1 ? 'th' : 'td';
      out += '<tr>' + cells.map((c) => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
      continue;
    }
    closeTable();
    if (ul) { if (!inUl) { closeLists(); out += '<ul>'; inUl = true; } out += '<li>' + ul[1] + '</li>'; }
    else if (ol) { if (!inOl) { closeLists(); out += '<ol>'; inOl = true; } out += '<li>' + ol[1] + '</li>'; }
    else { closeLists(); out += line + '<br>'; }
  }
  closeLists();
  closeTable();
  return out;
}

const PROPOSAL_MIN_ROLE = { quote: 'buyer', placement: 'buyer', demand: 'buyer', order: 'buyer', task: 'analyst', reservation: 'buyer', shipment: 'analyst', exception: 'analyst', setting: 'admin' };
function proposalCard(p, idx) {
  const rows = (p.fields || []).map((f) => `<div class="cf"><span class="k">${esc(f.label)}</span><span class="v">${esc(String(f.value))}</span></div>`).join('');
  const need = PROPOSAL_MIN_ROLE[p.type] || 'buyer';
  const applyBtn = can(need)
    ? `<button class="sm" data-apply="${idx}">${esc((p.apply && p.apply.label) || 'Apply')}</button>`
    : `<span class="badge warn">${need} role required to save</span>`;
  return `<div class="chat-proposal">
    <div class="cp-title">${esc(p.title || 'Draft')}</div>
    ${p.summary ? `<div class="small muted">${esc(p.summary)}</div>` : ''}
    <div class="cp-fields">${rows}</div>
    ${p.note ? `<div class="small" style="color:var(--warn);margin-top:6px">${esc(p.note)}</div>` : ''}
    <div class="row" style="margin-top:10px">${applyBtn}<button class="ghost sm" data-copy="${idx}" title="Copy the draft details">Copy</button></div>
  </div>`;
}

function chatBubble(m, idx) {
  if (m.role === 'proposal') return proposalCard(m.proposal, idx);
  if (m.role === 'user') {
    const chips = (m.files && m.files.length)
      ? `<div class="chat-files">${m.files.map((f) => `<span class="chat-file">${icon('paperclip', 12)} ${esc(f.name)}</span>`).join('')}</div>`
      : '';
    return `<div class="chat-msg user">${esc(m.content)}${chips}<div class="chat-actions"><button class="ghost sm" data-copy="${idx}" title="Copy this message">Copy</button></div></div>`;
  }
  if (m.streaming && !m.content) {
    const tool = m.tool ? `<span class="chat-tool">${esc(TOOL_LABELS[m.tool] || m.tool)}</span>` : '';
    return `<div class="chat-msg bot">${tool}<span class="chat-typing"><i></i><i></i><i></i></span></div>`;
  }
  const tool = m.tool ? `<div class="chat-tool">${esc(TOOL_LABELS[m.tool] || m.tool)}</div>` : '';
  const caret = m.streaming ? '<span class="chat-caret"></span>' : '';
  const copyBtn = m.streaming ? '' : `<div class="chat-actions"><button class="ghost sm" data-copy="${idx}" title="Copy this message">Copy</button></div>`;
  return `<div class="chat-msg bot">${tool}<div class="chat-md">${md(m.content)}</div>${caret}${copyBtn}</div>`;
}

async function copyText(text, btn) {
  const done = () => {
    if (btn) { const old = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = old; }, 1600); }
    toast('Copied to clipboard', 'ok');
  };
  try {
    await navigator.clipboard.writeText(text);
    done();
    return;
  } catch (_) { /* clipboard API needs focus/permission: fall back */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand('copy'); done(); }
  catch (_) { toast('Copy failed — select the text manually', 'err'); }
  ta.remove();
}

function messageCopyText(m) {
  if (!m) return '';
  if (m.role === 'proposal' && m.proposal) {
    const p = m.proposal;
    const lines = [p.title || 'Draft'];
    if (p.summary) lines.push(p.summary);
    (p.fields || []).forEach((f) => lines.push(`${f.label}: ${f.value}`));
    if (p.note) lines.push(p.note);
    return lines.join('\n');
  }
  return String(m.content || '');
}

function renderChatInto(body) {
  if (!body) return;
  const note = chat.enabled === false
    ? `<div class="chat-note">The assistant is not configured. On the server set <span class="mono">AI_BASE_URL</span>, <span class="mono">AI_API_KEY</span> and <span class="mono">AI_MODEL</span>, then restart.</div>`
    : '';
  const msgs = chat.messages.map((m, i) => chatBubble(m, i)).join('');
  const emptyTpl = `<div class="chat-empty">I can read the whole system and prepare drafts for you to confirm — prices, landed cost, what to buy, open exceptions, orders, stock, shipments, quotes and exports. Tap a prompt or type your own:</div>
    <div class="chat-chips">
      <button class="chat-chip" data-prompt="What needs my attention today?">What needs attention?</button>
      <button class="chat-chip" data-prompt="What should we buy? Show the purchase plan.">What should we buy?</button>
      <button class="chat-chip" data-prompt="List open exceptions by supplier">Open exceptions</button>
      <button class="chat-chip" data-prompt="Show the latest supplier uploads">Latest uploads</button>
      <button class="chat-chip" data-prompt="Show performance KPIs">Performance KPIs</button>
      <button class="chat-chip" data-prompt="Find products by name">Find a product</button>
      <button class="chat-chip" data-prompt="Prepare a quote of Versace Dylan Blue 100ml, 24 bottles, at 35% margin for our first customer, cost 12.50">Draft a quote</button>
      <button class="chat-chip" data-prompt="Prepare a supplier placement for Alcodis: 2 boxes of Versace Dylan Blue EDT 100ml">Draft a placement</button>
    </div>`;
  body.innerHTML = note + (msgs || emptyTpl);
  body.scrollTop = body.scrollHeight;
  const sel = body.id === 'aiBody' ? '#aiBody' : '#chatBody';
  $$(sel + ' [data-apply]').forEach((b) => b.addEventListener('click', () => applyProposal(Number(b.dataset.apply))));
  $$(sel + ' [data-copy]').forEach((b) => b.addEventListener('click', () => copyText(messageCopyText(chat.messages[Number(b.dataset.copy)]), b)));
  $$(sel + ' [data-prompt]').forEach((b) => b.addEventListener('click', () => {
    const main = $('#chatInput');
    const page = $('#aiInput');
    if (page && state.route === 'ai-chat') { page.value = b.dataset.prompt; page.focus(); } else if (main) { main.value = b.dataset.prompt; main.focus(); }
    if (!chat.streaming) sendChat();
  }));
}

function renderChat() {
  renderChatInto($('#chatBody'));
  renderChatInto($('#aiBody'));
  renderChatSidebar();
}

function renderChatSidebar() {
  const list = $('#aiList');
  if (!list) return;
  const sorted = convos.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  list.innerHTML = sorted.map((c) => `
    <button class="ai-item ${c.id === activeConvoId ? 'active' : ''}" data-ai-open="${esc(c.id)}">
      <span class="t">${esc(c.title || 'New chat')}</span>
      <span class="s">${c.messages.length} message(s) · ${new Date(c.updatedAt || Date.now()).toLocaleDateString()}</span>
    </button>`).join('') || '<div class="muted small" style="padding:8px">No chats yet — start one.</div>';
  $$('#aiList [data-ai-open]').forEach((b) => b.addEventListener('click', () => openChat(b.dataset.aiOpen)));
  const del = $('#aiDelete');
  if (del) del.style.display = convos.length > 1 ? '' : 'none';
}

function deleteChat() {
  if (convos.length <= 1) return;
  if (!confirm('Delete this chat? This removes it from your browser only.')) return;
  convos = convos.filter((c) => c.id !== activeConvoId);
  activeConvoId = convos[0].id;
  chat.messages = convos[0].messages;
  pendingFiles = [];
  renderAttachments();
  saveChatHistory();
  renderChat();
}

// Re-render only the streaming bubble so token updates stay cheap.
let chatRaf = 0;
function renderChatStream() {
  if (chatRaf) return;
  chatRaf = requestAnimationFrame(() => {
    chatRaf = 0;
    const bodies = [$('#chatBody'), $('#aiBody')].filter(Boolean);
    if (!bodies.length) return;
    const last = chat.messages[chat.messages.length - 1];
    if (!last || last.role !== 'assistant' || !last.streaming) { renderChat(); return; }
    const tool = last.tool ? `<div class="chat-tool">${esc(TOOL_LABELS[last.tool] || last.tool)}</div>` : '';
    bodies.forEach((body) => {
      const bubbles = body.querySelectorAll('.chat-msg.bot');
      const el = bubbles[bubbles.length - 1];
      if (!el) { renderChat(); return; }
      el.innerHTML = `${tool}<div class="chat-md">${md(last.content)}</div><span class="chat-caret"></span>`;
      body.scrollTop = body.scrollHeight;
    });
  });
}

async function applyProposal(idx) {
  const m = chat.messages[idx];
  if (!m || !m.proposal || !m.proposal.apply) return;
  const a = m.proposal.apply;
  const btn = $$('[data-apply]').find((b) => Number(b.dataset.apply) === idx);
  if (btn) btn.disabled = true;
  try {
    const out = await api(m.proposal.apply.method || 'POST', m.proposal.apply.url, m.proposal.apply.body);
    const label = m.proposal.apply.label || 'record';
    chat.messages.push({ role: 'assistant', content: `Done — ${String(label).toLowerCase()} saved${out && out.id ? ' (id ' + out.id + ')' : ''}.` });
    toast(label + ' saved', 'ok');
    saveChatHistory();
    renderChat();
    render();
  } catch (e) {
    toast(e.message, 'err');
    if (btn) btn.disabled = false;
  }
}

// POST the turn and consume the SSE reply: tool = a tool is running,
// delta = a text fragment, done = reply + proposals, error = failure.
// Falls back to the plain /ai/chat turn if the stream endpoint is missing.
async function sendChat() {
  const page = $('#aiInput');
  const input = (page && state.route === 'ai-chat') ? page : $('#chatInput');
  const text = (input ? (input.value || '') : '').trim();
  if ((!text && !pendingFiles.length) || chat.streaming) return;
  if (input) input.value = '';
  const floating = $('#chatInput');
  if (floating && floating !== input) floating.value = '';
  const files = pendingFiles.slice();
  const display = text || '📎 ' + files.map((f) => f.name).join(', ');
  const send = (text || '(see the attached files)') + attachmentsPrompt(files);
  chat.messages.push({ role: 'user', content: display, send, files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })) });
  pendingFiles = [];
  renderAttachments();
  if (chat.enabled === false) {
    chat.messages.push({ role: 'assistant', content: 'The assistant is not configured on the server yet. Ask an admin to set AI_BASE_URL, AI_API_KEY and AI_MODEL, then restart.' });
    saveChatHistory();
    renderChat();
    return;
  }
  const turn = { role: 'assistant', content: '', streaming: true, tool: null };
  chat.messages.push(turn);
  chat.streaming = true;
  setChatSending(true);
  renderChat();

  const payload = chat.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.content || m.send))
    .map((m) => ({ role: m.role, content: m.send || m.content }));

  chat.controller = new AbortController();
  let sawDone = false;
  try {
    const r = await fetch('/api/ai/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: payload }),
      signal: chat.controller.signal,
    });
    if (!r.ok || !r.body) throw new Error('The assistant stream failed (HTTP ' + r.status + ').');
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const frame = (event, data) => {
      if (event === 'tool') { turn.tool = data.name; renderChatStream(); }
      else if (event === 'delta') { turn.content += data.text || ''; renderChatStream(); }
      else if (event === 'done') {
        sawDone = true;
        if (!turn.content && data.reply) turn.content = data.reply;
        (data.proposals || []).forEach((p) => chat.messages.push({ role: 'proposal', proposal: p }));
        if (data.model) { chat.model = data.model; setChatModelLabel(); }
      } else if (event === 'error') {
        const err = new Error(data.message || 'The assistant failed.');
        if (data.code) err.fatal = true; // provider/config problem: retrying the plain route cannot help
        throw err;
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = 'message';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let j;
        try { j = JSON.parse(data); } catch (_) { continue; }
        frame(event, j);
      }
    }
    if (!sawDone && !turn.content) throw new Error('The assistant stream ended unexpectedly.');
  } catch (e) {
    if (e.name === 'AbortError') {
      if (!turn.content) turn.content = '(stopped)';
    } else if (e.fatal) {
      turn.content = '**Assistant unavailable.** ' + e.message;
    } else {
      // Stream unavailable (older server, proxy): fall back to the plain turn.
      try {
        const out = await POST('/ai/chat', { messages: payload });
        turn.content = out.reply || '';
        (out.proposals || []).forEach((p) => chat.messages.push({ role: 'proposal', proposal: p }));
        if (out.model) { chat.model = out.model; setChatModelLabel(); }
        if (!turn.content && !(out.proposals || []).length) turn.content = '(no answer)';
      } catch (e2) {
        turn.content = '**Assistant unavailable.** ' + e2.message;
      }
    }
  } finally {
    turn.streaming = false;
    turn.tool = null;
    chat.streaming = false;
    chat.controller = null;
    setChatSending(false);
    saveChatHistory();
    renderChat();
  }
}

function setChatModelLabel() {
  const el = $('#chatModel');
  if (!el) return;
  const chain = chat.models || [];
  const extra = chain.length > 1 ? ' +' + (chain.length - 1) + ' fallback' : '';
  el.textContent = chat.enabled ? (chat.model || '') + extra : 'not configured';
}

function setChatSending(on) {
  const btn = $('#chatSend');
  if (!btn) return;
  btn.textContent = on ? 'Stop' : 'Send';
  btn.classList.toggle('danger', on);
}

function stopChat() {
  if (chat.controller) chat.controller.abort();
}

async function initAssistant() {
  if ($('#chatLauncher')) return;
  const btn = document.createElement('button');
  btn.id = 'chatLauncher';
  btn.className = 'chat-launcher';
  btn.title = 'Ask the assistant';
  btn.textContent = 'Ask AI';
  const panel = document.createElement('div');
  panel.id = 'chatPanel';
  panel.className = 'chat-panel hidden';
  panel.innerHTML = `
    <div class="chat-head">
      <div><strong>Assistant</strong> <span class="small muted" id="chatModel"></span></div>
      <div class="row" style="gap:6px">
        <select id="chatHistory" title="Previous chats" aria-label="Previous chats"></select>
        <button class="ghost sm" id="chatNew" title="Start a new chat">New</button>
        <button class="ghost sm" id="chatExpand" title="Make the window larger or smaller">&#8599;</button>
        <button class="ghost sm" id="chatClose" aria-label="Close">&#10005;</button>
      </div>
    </div>
    <div class="chat-body" id="chatBody"></div>
    <div class="chat-attach hidden" id="chatAttach"></div>
    <div class="chat-foot">
      <button id="chatAttachBtn" class="ghost sm" title="Attach files (any type)"></button>
      <input id="chatFile" type="file" accept="*/*" multiple hidden />
      <textarea id="chatInput" rows="1" placeholder="Ask or instruct… Paste with Ctrl+V, or attach any file" aria-label="Message the assistant"></textarea>
      <button id="chatSend">Send</button>
    </div>`;
  document.body.appendChild(btn);
  document.body.appendChild(panel);
  $('#chatAttachBtn').innerHTML = icon('paperclip', 17);
  btn.addEventListener('click', () => {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) $('#chatInput').focus();
  });
  $('#chatClose').addEventListener('click', () => panel.classList.add('hidden'));
  $('#chatExpand').addEventListener('click', () => {
    panel.classList.toggle('expanded');
    const input = $('#chatInput');
    if (input) input.focus();
  });
  $('#chatNew').addEventListener('click', newChat);
  $('#chatHistory').addEventListener('change', (e) => openChat(e.target.value));
  $('#chatAttachBtn').addEventListener('click', () => $('#chatFile').click());
  $('#chatFile').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('#chatSend').addEventListener('click', () => { if (chat.streaming) stopChat(); else sendChat(); });
  const fitInput = () => { const ta = $('#chatInput'); if (!ta) return; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 180) + 'px'; };
  $('#chatInput').addEventListener('input', fitInput);
  $('#chatInput').addEventListener('paste', () => setTimeout(fitInput, 0));
  $('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!chat.streaming) sendChat(); } });
  loadChatHistory();
  try {
    const s = await GET('/ai/status');
    chat.enabled = !!s.enabled;
    chat.model = s.model || '';
    chat.models = s.models || (s.model ? [s.model] : []);
    setChatModelLabel();
  } catch (e) { chat.enabled = false; }
  renderChat();
}

(async function boot() {
  decorateNav();
  try {
    const me = await GET('/auth/me');
    state.user = me.user;
  } catch (e) { state.user = null; }
  if (!state.user) { showLogin(); return; }
  await loadSettings();
  updateUserUI();
  initAssistant();
  const r = location.hash.slice(1) || 'dashboard';
  state.route = (routes[r] && can(ROUTE_MIN[r] || 'viewer')) ? r : 'dashboard';
  render();
})();
