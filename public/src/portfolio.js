/**
 * portfolio.js — Editable portfolio list for the StockScanner PWA.
 * GET/PUT /api/stocks/portfolio?list=Portfolio
 */
import { authHeaders, getActiveBase } from './localBridge.js';
import { CONFIG } from './config.js';

const LIST = 'Portfolio';

let _loaded = false;
let _dirty  = false;

// ── DOM refs (populated after initPortfolio) ──────────────────────────────
let $body, $toast, $toolbar;

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

// ── Table rendering ───────────────────────────────────────────────────────
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
    td.addEventListener('input', () => { _dirty = true; });
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
    _dirty = true;
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

// ── Search dropdown ───────────────────────────────────────────────────────
let _searchTimer = null;

function getExistingTickers() {
  return new Set(collectRows().map(e => e.ticker.toUpperCase()));
}

function hideResults() {
  const $results = document.getElementById('pf-search-results');
  if ($results) $results.hidden = true;
}

function renderResults(items) {
  const $results = document.getElementById('pf-search-results');
  if (!$results) return;
  $results.innerHTML = '';
  if (!items.length) { $results.hidden = true; return; }

  items.forEach(item => {
    const li = document.createElement('li');
    li.className = 'pf-result-item';
    li.textContent = `${item.symbol} — ${item.name}${item.exchange ? ' · ' + item.exchange : ''}`;
    li.addEventListener('mousedown', e => {
      e.preventDefault();   // prevent input blur before click fires
      addFromSearch(item);
    });
    $results.appendChild(li);
  });
  $results.hidden = false;
}

function addFromSearch(item) {
  const existing = getExistingTickers();
  if (existing.has(item.symbol.toUpperCase())) {
    toast('Schon in der Liste: ' + item.symbol, false);
    hideResults();
    const $input = document.getElementById('pf-search-input');
    if ($input) $input.value = '';
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
  _dirty = true;

  hideResults();
  const $input = document.getElementById('pf-search-input');
  if ($input) $input.value = '';
}

function initSearch() {
  const $input = document.getElementById('pf-search-input');
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

  $input.addEventListener('blur', () => {
    // Delay so mousedown on a result item fires first
    setTimeout(hideResults, 150);
  });

  document.addEventListener('click', e => {
    if (!$input.contains(e.target) && !$results.contains(e.target)) {
      hideResults();
    }
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
    const items = await r.json();
    renderResults(items);
  } catch (e) {
    hideResults();
  }
}

// ── API ───────────────────────────────────────────────────────────────────
async function load() {
  $body.innerHTML = '<span class="hint">Lade…</span>';
  try {
    const r = await fetch(
      getActiveBase() + CONFIG.STOCKS_PORTFOLIO_PATH + '?list=' + LIST,
      { headers: authHeaders(), cache: 'no-store', credentials: 'omit' },
    );
    if (r.status === 401) { toast('Token abgelehnt — Info-Tab öffnen.', false); $body.innerHTML = ''; return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const entries = await r.json();
    $body.innerHTML = '';
    $body.appendChild(buildTable(entries));
    _dirty  = false;
    _loaded = true;
  } catch (e) {
    toast('Ladefehler: ' + e.message, false);
    $body.innerHTML = '<span class="hint">Fehler beim Laden.</span>';
  }
}

async function save() {
  const entries = collectRows();
  try {
    const r = await fetch(
      getActiveBase() + CONFIG.STOCKS_PORTFOLIO_PATH + '?list=' + LIST,
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
    _dirty = false;
  } catch (e) {
    toast('Speicherfehler: ' + e.message, false);
  }
}

// ── Toolbar ────────────────────────────────────────────────────────────────
function buildToolbar() {
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
    _dirty = true;
  });

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn'; saveBtn.textContent = 'Speichern';
  saveBtn.addEventListener('click', save);

  const reloadBtn = document.createElement('button');
  reloadBtn.className = 'btn'; reloadBtn.textContent = 'Neu laden';
  reloadBtn.addEventListener('click', load);

  $toolbar.appendChild(addBtn);
  $toolbar.appendChild(saveBtn);
  $toolbar.appendChild(reloadBtn);
}

// ── Init ──────────────────────────────────────────────────────────────────
export function initPortfolio() {
  $body    = document.getElementById('portfolio-body');
  $toast   = document.getElementById('pf-toast');
  $toolbar = document.getElementById('portfolio-toolbar');

  if (!$body) return;

  buildToolbar();
  initSearch();

  window.addEventListener('pwa:tab', e => {
    if (e.detail === 'portfolio' && !_loaded) load();
  });

  // Handle beforeunload warning when dirty
  window.addEventListener('beforeunload', e => {
    if (_dirty) { e.preventDefault(); e.returnValue = ''; }
  });
}
