/**
 * portfolio.js — Multi-list editable editor for the StockScanner PWA.
 * Manages Portfolio, Watchlist, and Watchlist+ (Screenlist_extended).
 * GET/PUT /api/stocks/portfolio?list=<name>
 * POST     /api/stocks/run?list=<name>
 * POST     /api/stocks/export?list=<name>
 */
import { authHeaders, getActiveBase } from './localBridge.js';
import { CONFIG } from './config.js';

const LISTS = [
  { key: 'Portfolio',           label: 'Portfolio'  },
  { key: 'Watchlist',           label: 'Watchlist'  },
  { key: 'Screenlist_extended', label: 'Watchlist+' },
];

let _activeList = LISTS[0].key;
// per-list state: { loaded: bool, dirty: bool }
const _state = {};
LISTS.forEach(l => { _state[l.key] = { loaded: false, dirty: false }; });

// ── DOM refs ──────────────────────────────────────────────────────────────
let $body, $toast, $toolbar, $filterInput;

// ── Toast ─────────────────────────────────────────────────────────────────
let _toastTimer = null;
function toast(msg, ok) {
  if (!$toast) return;
  clearTimeout(_toastTimer);
  $toast.textContent = msg;
  $toast.className = ok ? 'toast-ok' : 'toast-err';
  $toast.style.display = 'block';
  $toast.style.opacity = '1';
  _toastTimer = setTimeout(() => {
    $toast.style.opacity = '0';
    setTimeout(() => { $toast.style.display = 'none'; }, 400);
  }, 3000);
}

// ── Table ─────────────────────────────────────────────────────────────────
function buildTable(entries) {
  const tbl = document.createElement('table');
  tbl.className = 'pf-table';
  tbl.innerHTML = '<thead><tr><th>Ticker</th><th>Name</th><th></th></tr></thead>';
  const tbody = document.createElement('tbody');
  entries.forEach(e => tbody.appendChild(buildRow(e)));
  tbl.appendChild(tbody);
  return tbl;
}

function buildRow({ ticker = '', name = '' } = {}) {
  const tr = document.createElement('tr');
  ['ticker', 'name'].forEach(field => {
    const td = document.createElement('td');
    td.contentEditable = 'true';
    td.dataset.field = field;
    td.textContent = field === 'ticker' ? ticker : name;
    td.addEventListener('input', () => { _state[_activeList].dirty = true; });
    tr.appendChild(td);
  });
  const delTd = document.createElement('td');
  const delBtn = document.createElement('button');
  delBtn.className = 'del-btn';
  delBtn.textContent = '✕';
  delBtn.title = 'Zeile löschen';
  delBtn.addEventListener('click', () => {
    if (!confirm(`"${tr.querySelector('[data-field=name]').textContent}" löschen?`)) return;
    tr.remove();
    _state[_activeList].dirty = true;
  });
  delTd.appendChild(delBtn);
  tr.appendChild(delTd);
  return tr;
}

function collectRows() {
  if (!$body) return [];
  return [...$body.querySelectorAll('.pf-table tbody tr')].map(tr => ({
    ticker: tr.querySelector('[data-field=ticker]')?.textContent.trim() || '',
    name:   tr.querySelector('[data-field=name]')?.textContent.trim()   || '',
  })).filter(e => e.ticker);
}

// ── Filter ────────────────────────────────────────────────────────────────
function applyFilter(q) {
  if (!$body) return;
  const term = (q || '').toLowerCase();
  $body.querySelectorAll('.pf-table tbody tr').forEach(tr => {
    if (!term) { tr.style.display = ''; return; }
    const ticker = (tr.querySelector('[data-field=ticker]')?.textContent || '').toLowerCase();
    const name   = (tr.querySelector('[data-field=name]')?.textContent   || '').toLowerCase();
    tr.style.display = (ticker.includes(term) || name.includes(term)) ? '' : 'none';
  });
}

// ── Search dropdown ───────────────────────────────────────────────────────
let _searchTimer = null;

function getExistingTickers() {
  return new Set(collectRows().map(e => e.ticker.toUpperCase()));
}

function hideResults() {
  const $r = document.getElementById('pf-search-results');
  if ($r) $r.hidden = true;
}

function renderResults(items) {
  const $r = document.getElementById('pf-search-results');
  if (!$r) return;
  $r.innerHTML = '';
  if (!items.length) { $r.hidden = true; return; }
  items.forEach(item => {
    const li = document.createElement('li');
    li.className = 'pf-result-item';
    li.textContent = `${item.symbol} — ${item.name}${item.exchange ? ' · ' + item.exchange : ''}`;
    li.addEventListener('mousedown', e => { e.preventDefault(); addFromSearch(item); });
    $r.appendChild(li);
  });
  $r.hidden = false;
}

function addFromSearch(item) {
  if (getExistingTickers().has(item.symbol.toUpperCase())) {
    toast('Schon in der Liste: ' + item.symbol, false);
    hideResults();
    const $i = document.getElementById('pf-search-input');
    if ($i) $i.value = '';
    return;
  }
  let tbody = $body.querySelector('.pf-table tbody');
  if (!tbody) {
    $body.innerHTML = '';
    const tbl = buildTable([]);
    $body.appendChild(tbl);
    tbody = tbl.querySelector('tbody');
  }
  tbody.appendChild(buildRow({ ticker: item.symbol, name: item.name }));
  _state[_activeList].dirty = true;
  hideResults();
  const $i = document.getElementById('pf-search-input');
  if ($i) $i.value = '';
}

function initSearch() {
  const $input   = document.getElementById('pf-search-input');
  const $results = document.getElementById('pf-search-results');
  if (!$input || !$results) return;

  $input.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    const q = $input.value.trim();
    if (q.length < 2) { hideResults(); return; }
    _searchTimer = setTimeout(() => doSearch(q), 250);
  });
  $input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hideResults(); $input.value = ''; }
  });
  $input.addEventListener('blur', () => setTimeout(hideResults, 150));
  document.addEventListener('click', e => {
    if (!$input.contains(e.target) && !$results.contains(e.target)) hideResults();
  });
}

async function doSearch(q) {
  try {
    const r = await fetch(
      getActiveBase() + CONFIG.STOCKS_SEARCH_PATH + '?q=' + encodeURIComponent(q),
      { headers: authHeaders(), cache: 'no-store', credentials: 'omit' },
    );
    if (r.status === 401) { toast('Token abgelehnt — Info-Tab öffnen.', false); return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    renderResults(await r.json());
  } catch { hideResults(); }
}

// ── API ───────────────────────────────────────────────────────────────────
async function load(list) {
  list = list || _activeList;
  $body.innerHTML = '<span class="hint">Lade…</span>';
  if ($filterInput) { $filterInput.value = ''; }
  try {
    const r = await fetch(
      getActiveBase() + CONFIG.STOCKS_PORTFOLIO_PATH + '?list=' + list,
      { headers: authHeaders(), cache: 'no-store', credentials: 'omit' },
    );
    if (r.status === 401) { toast('Token abgelehnt — Info-Tab öffnen.', false); $body.innerHTML = ''; return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const entries = await r.json();
    $body.innerHTML = '';
    $body.appendChild(buildTable(entries));
    _state[list].dirty  = false;
    _state[list].loaded = true;
  } catch (e) {
    toast('Ladefehler: ' + e.message, false);
    $body.innerHTML = '<span class="hint">Fehler beim Laden.</span>';
  }
}

async function save() {
  const entries = collectRows();
  try {
    const r = await fetch(
      getActiveBase() + CONFIG.STOCKS_PORTFOLIO_PATH + '?list=' + _activeList,
      {
        method:  'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify(entries),
        credentials: 'omit',
      },
    );
    if (r.status === 401) { toast('Token abgelehnt — Info-Tab öffnen.', false); return; }
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'HTTP ' + r.status); }
    const d = await r.json();
    toast(`Gespeichert (${d.count} Einträge).`, true);
    _state[_activeList].dirty = false;
  } catch (e) {
    toast('Speicherfehler: ' + e.message, false);
  }
}

async function runNow() {
  try {
    const r = await fetch(
      getActiveBase() + CONFIG.STOCKS_RUN_PATH + '?list=' + _activeList,
      { method: 'POST', headers: authHeaders(), credentials: 'omit' },
    );
    if (r.status === 401) { toast('Token abgelehnt — Info-Tab öffnen.', false); return; }
    if (r.status === 409) { toast('Scan läuft bereits.', false); return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    toast('Scan gestartet (' + _activeList + ').', true);
  } catch (e) {
    toast('Scan-Fehler: ' + e.message, false);
  }
}

async function exportList() {
  try {
    const r = await fetch(
      getActiveBase() + CONFIG.STOCKS_EXPORT_PATH + '?list=' + _activeList,
      { method: 'POST', headers: authHeaders(), credentials: 'omit' },
    );
    if (r.status === 401) { toast('Token abgelehnt — Info-Tab öffnen.', false); return; }
    if (r.status === 409) { toast('Scan läuft bereits.', false); return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    toast('Excel-Export gestartet (' + _activeList + ').', true);
  } catch (e) {
    toast('Export-Fehler: ' + e.message, false);
  }
}

// ── Sub-tabs ──────────────────────────────────────────────────────────────
function buildListTabs() {
  const wrap = document.getElementById('pf-list-tabs');
  if (!wrap) return;
  wrap.innerHTML = '';
  LISTS.forEach(l => {
    const btn = document.createElement('button');
    btn.className = 'pf-list-tab' + (l.key === _activeList ? ' active' : '');
    btn.textContent = l.label;
    btn.dataset.list = l.key;
    btn.addEventListener('click', () => switchList(l.key));
    wrap.appendChild(btn);
  });
}

function switchList(key) {
  if (key === _activeList) return;
  if (_state[_activeList].dirty) {
    if (!confirm('Ungespeicherte Änderungen für ' + _activeList + ' verwerfen?')) return;
    _state[_activeList].dirty = false;
  }
  _activeList = key;
  document.querySelectorAll('.pf-list-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.list === key);
  });
  load(key);
}

// ── Toolbar ────────────────────────────────────────────────────────────────
function buildToolbar() {
  $toolbar.innerHTML = '';

  const addBtn = document.createElement('button');
  addBtn.className = 'btn'; addBtn.textContent = '+ Zeile';
  addBtn.addEventListener('click', () => {
    let tbody = $body.querySelector('.pf-table tbody');
    if (!tbody) {
      $body.innerHTML = '';
      const tbl = buildTable([]);
      $body.appendChild(tbl);
      tbody = tbl.querySelector('tbody');
    }
    tbody.appendChild(buildRow());
    _state[_activeList].dirty = true;
  });

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn'; saveBtn.textContent = 'Speichern';
  saveBtn.addEventListener('click', save);

  const reloadBtn = document.createElement('button');
  reloadBtn.className = 'btn'; reloadBtn.textContent = 'Neu laden';
  reloadBtn.addEventListener('click', () => load(_activeList));

  const runBtn = document.createElement('button');
  runBtn.className = 'btn'; runBtn.textContent = 'Jetzt scannen';
  runBtn.addEventListener('click', runNow);

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn'; exportBtn.textContent = 'Export';
  exportBtn.addEventListener('click', exportList);

  $toolbar.appendChild(addBtn);
  $toolbar.appendChild(saveBtn);
  $toolbar.appendChild(reloadBtn);
  $toolbar.appendChild(runBtn);
  $toolbar.appendChild(exportBtn);
}

// ── Init ──────────────────────────────────────────────────────────────────
export function initPortfolio() {
  $body        = document.getElementById('portfolio-body');
  $toast       = document.getElementById('pf-toast');
  $toolbar     = document.getElementById('portfolio-toolbar');
  $filterInput = document.getElementById('pf-filter-input');

  if (!$body) return;

  buildListTabs();
  buildToolbar();
  initSearch();

  if ($filterInput) {
    $filterInput.addEventListener('input', () => applyFilter($filterInput.value));
  }

  window.addEventListener('pwa:tab', e => {
    if (e.detail === 'portfolio' && !_state[_activeList].loaded) load();
  });

  window.addEventListener('beforeunload', e => {
    if (LISTS.some(l => _state[l.key].dirty)) { e.preventDefault(); e.returnValue = ''; }
  });
}
