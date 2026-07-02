/**
 * portfolio.js — Multi-list editable editor for the StockScanner PWA.
 * Lists are loaded dynamically from GET /api/stocks/lists.
 * GET/PUT  /api/stocks/portfolio?list=<name>
 * GET      /api/stocks/lists
 * POST     /api/stocks/lists       {key, label}
 * PATCH    /api/stocks/lists/:key  {label}
 * DELETE   /api/stocks/lists/:key
 * POST     /api/stocks/portfolio/move?from=X&to=Y  {ticker, name, copy?}
 * POST     /api/stocks/run?list=<name>
 * POST     /api/stocks/export?list=<name>
 */
import { authHeaders, getActiveBase } from './localBridge.js';
import { CONFIG } from './config.js';
import { loadLists as fetchLists } from './lists.js';

const BUILTIN_KEYS = new Set(['Portfolio', 'Watchlist']);

let LISTS = [];           // [{key, label, builtin, hasJson, count}]
let _activeList = 'Portfolio';
const _state = {};        // keyed by list key: {loaded, dirty}

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
  tbl.innerHTML = '<thead><tr><th>Ticker</th><th>Name</th><th>Exposure</th><th>Ccy</th><th></th><th></th></tr></thead>';
  const tbody = document.createElement('tbody');
  entries.forEach(e => tbody.appendChild(buildRow(e)));
  tbl.appendChild(tbody);
  return tbl;
}

function buildRow({ ticker = '', name = '', exposure = '', currency = '', 'as of': asOf = '' } = {}) {
  const tr = document.createElement('tr');
  // Store original as-of so collectRows can preserve it when exposure is unchanged
  tr.dataset.asOf = asOf || '';

  ['ticker', 'name'].forEach(field => {
    const td = document.createElement('td');
    td.contentEditable = 'true';
    td.dataset.field = field;
    td.textContent = field === 'ticker' ? ticker : name;
    td.addEventListener('input', () => { _state[_activeList].dirty = true; });
    tr.appendChild(td);
  });

  // Exposure — shown as label; double-click opens edit popup
  const expTd = document.createElement('td');
  expTd.className = 'pf-edit-cell';
  expTd.title = 'Doppelklick zum Bearbeiten';
  const expSpan = document.createElement('span');
  expSpan.dataset.field = 'exposure';
  const origExp = (exposure != null && exposure !== '') ? String(exposure) : '';
  expSpan.textContent = origExp;
  expSpan.dataset.origValue = origExp;
  expTd.appendChild(expSpan);
  expTd.addEventListener('dblclick', () => showEditPopup(tr));
  tr.appendChild(expTd);

  // Currency — shown as label; double-click opens edit popup
  const ccyTd = document.createElement('td');
  ccyTd.className = 'pf-edit-cell';
  ccyTd.title = 'Doppelklick zum Bearbeiten';
  const ccySpan = document.createElement('span');
  ccySpan.dataset.field = 'currency';
  ccySpan.textContent = currency || '';
  ccyTd.appendChild(ccySpan);
  ccyTd.addEventListener('dblclick', () => showEditPopup(tr));
  tr.appendChild(ccyTd);

  // ⇄ move/copy to another list
  const moveTd = document.createElement('td');
  const moveBtn = document.createElement('button');
  moveBtn.className = 'del-btn';
  moveBtn.textContent = '⇄';
  moveBtn.title = 'Verschieben / Kopieren';
  moveBtn.addEventListener('click', e => { e.stopPropagation(); showMoveMenu(tr, moveBtn); });
  moveTd.appendChild(moveBtn);
  tr.appendChild(moveTd);

  const delTd = document.createElement('td');
  const delBtn = document.createElement('button');
  delBtn.className = 'del-btn btn-danger';
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

function showEditPopup(tr) {
  const old = document.getElementById('pf-edit-popup');
  if (old) old.remove();

  const expSpan = tr.querySelector('[data-field=exposure]');
  const ccySpan = tr.querySelector('[data-field=currency]');

  const popup = document.createElement('div');
  popup.id = 'pf-edit-popup';

  const expLabel = document.createElement('label');
  expLabel.textContent = 'Exposure';
  const expInput = document.createElement('input');
  expInput.type = 'text'; expInput.inputMode = 'decimal';
  expInput.value = expSpan ? expSpan.textContent : '';
  expLabel.appendChild(expInput);

  const ccyLabel = document.createElement('label');
  ccyLabel.textContent = 'Währung';
  const ccySel = document.createElement('select');
  const currentCcy = ccySpan ? ccySpan.textContent : '';
  ['', 'CHF', 'EUR', 'USD', 'GBP', 'BTC'].forEach(opt => {
    const o = document.createElement('option');
    o.value = opt; o.textContent = opt || '—';
    if (opt === currentCcy) o.selected = true;
    ccySel.appendChild(o);
  });
  ccyLabel.appendChild(ccySel);

  const btns = document.createElement('div');
  btns.className = 'pf-ep-btns';
  const okBtn = document.createElement('button'); okBtn.textContent = 'OK'; okBtn.type = 'button';
  const cancelBtn = document.createElement('button'); cancelBtn.textContent = '✕'; cancelBtn.type = 'button';
  btns.appendChild(okBtn); btns.appendChild(cancelBtn);

  popup.appendChild(expLabel); popup.appendChild(ccyLabel); popup.appendChild(btns);

  const rect = tr.getBoundingClientRect();
  popup.style.position = 'fixed';
  popup.style.top = (rect.bottom + 4) + 'px';
  popup.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 220)) + 'px';
  document.body.appendChild(popup);
  expInput.focus(); expInput.select();

  function confirm() {
    if (expSpan) {
      const newVal = expInput.value.trim();
      if (newVal !== (expSpan.dataset.origValue || '')) expSpan.dataset.changed = '1';
      expSpan.textContent = newVal;
    }
    if (ccySpan) ccySpan.textContent = ccySel.value;
    _state[_activeList].dirty = true;
    cleanup();
  }
  function cleanup() { popup.remove(); document.removeEventListener('click', outsideHandler); }
  function outsideHandler(e) { if (!popup.contains(e.target)) cleanup(); }

  okBtn.addEventListener('click', confirm);
  cancelBtn.addEventListener('click', cleanup);
  expInput.addEventListener('keydown', e => { if(e.key==='Enter') confirm(); if(e.key==='Escape') cleanup(); });
  setTimeout(() => document.addEventListener('click', outsideHandler), 0);
}

function collectRows() {
  if (!$body) return [];
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return [...$body.querySelectorAll('.pf-table tbody tr')].map(tr => {
    const ticker   = tr.querySelector('[data-field=ticker]')?.textContent.trim() || '';
    const name     = tr.querySelector('[data-field=name]')?.textContent.trim()   || '';
    const expEl    = tr.querySelector('[data-field=exposure]');
    const expRaw   = expEl ? expEl.textContent.trim() : '';
    const currency = tr.querySelector('[data-field=currency]')?.textContent.trim() || '';
    const exposure = expRaw !== '' ? expRaw : '';
    // Stamp as-of today only when exposure was changed via popup; otherwise preserve original
    let asOf = '';
    if(exposure !== ''){
      asOf = (expEl && expEl.dataset.changed) ? today : (tr.dataset.asOf || today);
    }
    return { ticker, name, exposure, currency, 'as of': asOf };
  }).filter(e => e.ticker);
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
    // Normalize keys to lowercase so CSV rows with capitalized headers
    // (Ticker, Name, Exposure, Currency, as of) map correctly to buildRow.
    const _lc = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
    const entries = (await r.json()).map(e => { const n = _lc(e); return {
      ticker:   n.ticker   || '',
      name:     n.name     || '',
      exposure: n.exposure != null ? n.exposure : '',
      currency: n.currency || '',
      'as of':  n['as of'] || '',
    }; });
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

// ── Move / Copy ────────────────────────────────────────────────────────────
function dismissMenu(id) {
  const m = document.getElementById(id); if (m) m.remove();
}

function showMoveMenu(tr, anchor) {
  dismissMenu('pf-move-menu');
  dismissMenu('pf-list-menu');
  const ticker = tr.querySelector('[data-field=ticker]')?.textContent.trim() || '';
  const name   = tr.querySelector('[data-field=name]')?.textContent.trim()   || '';
  if (!ticker) return;
  const others = LISTS.filter(l => l.key !== _activeList);
  if (!others.length) { toast('Keine anderen Listen.', false); return; }

  const menu = document.createElement('div');
  menu.id = 'pf-move-menu';
  menu.className = 'pf-action-sheet';

  for (const target of others) {
    const mv = document.createElement('button');
    mv.textContent = '→ ' + target.label + ' (verschieben)';
    mv.addEventListener('click', async () => { menu.remove(); await moveCopyTicker(ticker, name, target.key, false); });
    const cp = document.createElement('button');
    cp.textContent = '⊕ ' + target.label + ' (kopieren)';
    cp.addEventListener('click', async () => { menu.remove(); await moveCopyTicker(ticker, name, target.key, true); });
    menu.appendChild(mv);
    menu.appendChild(cp);
  }

  const rect = anchor.getBoundingClientRect();
  menu.style.top  = (rect.bottom + 4) + 'px';
  menu.style.left = Math.max(4, rect.right - 220) + 'px';
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

async function moveCopyTicker(ticker, name, targetKey, copy) {
  if (_state[_activeList]?.dirty) {
    if (!confirm('Ungespeicherte Änderungen — erst speichern?')) return;
  }
  try {
    const r = await fetch(
      getActiveBase() + CONFIG.STOCKS_MOVE_PATH + '?from=' + _activeList + '&to=' + targetKey,
      {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, name, copy }),
        credentials: 'omit',
      },
    );
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'HTTP ' + r.status); }
    const d = await r.json();
    toast(`${copy ? 'Kopiert' : 'Verschoben'}: ${ticker} → ${targetKey} (${d.to.count}).`, true);
    if (!copy) {
      _state[_activeList].loaded = false;
      load(_activeList);
    }
  } catch (e) {
    toast('Fehler: ' + e.message, false);
  }
}

// ── List management ────────────────────────────────────────────────────────
async function loadLists() {
  LISTS = await fetchLists();
  for (const l of LISTS) {
    if (!_state[l.key]) _state[l.key] = { loaded: false, dirty: false };
  }
  if (!LISTS.find(l => l.key === _activeList)) {
    _activeList = LISTS[0]?.key || 'Portfolio';
  }
  buildListTabs();
}

function showListMenu(list, anchor) {
  dismissMenu('pf-list-menu');
  dismissMenu('pf-move-menu');
  const menu = document.createElement('div');
  menu.id = 'pf-list-menu';
  menu.className = 'pf-action-sheet';

  const renBtn = document.createElement('button');
  renBtn.textContent = 'Umbenennen';
  renBtn.addEventListener('click', () => { menu.remove(); renameList(list); });
  const delBtn = document.createElement('button');
  delBtn.textContent = 'Löschen';
  delBtn.style.color = 'var(--sell)';
  delBtn.addEventListener('click', () => { menu.remove(); deleteList(list); });

  menu.appendChild(renBtn);
  menu.appendChild(delBtn);
  const rect = anchor.getBoundingClientRect();
  menu.style.top  = (rect.bottom + 4) + 'px';
  menu.style.left = rect.left + 'px';
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

async function createList() {
  const raw = prompt('Name der neuen Liste:');
  if (!raw || !raw.trim()) return;
  const label = raw.trim().slice(0, 60);
  const key   = label.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50);
  if (!key) { toast('Ungültiger Name.', false); return; }
  try {
    const r = await fetch(
      getActiveBase() + CONFIG.STOCKS_LISTS_PATH,
      {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, label }),
        credentials: 'omit',
      },
    );
    if (r.status === 409) { toast('Liste existiert bereits.', false); return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    _state[d.key] = { loaded: true, dirty: false };
    _activeList = d.key;
    await loadLists();
    $body.innerHTML = '';
    $body.appendChild(buildTable([]));
  } catch (e) { toast('Erstellen fehlgeschlagen: ' + e.message, false); }
}

async function renameList(list) {
  const nl = prompt('Neuer Name:', list.label);
  if (!nl || !nl.trim() || nl.trim() === list.label) return;
  try {
    const r = await fetch(
      getActiveBase() + CONFIG.STOCKS_LISTS_PATH + '/' + list.key,
      {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: nl.trim().slice(0, 60) }),
        credentials: 'omit',
      },
    );
    if (!r.ok) throw new Error('HTTP ' + r.status);
    await loadLists();
  } catch (e) { toast('Umbenennen fehlgeschlagen: ' + e.message, false); }
}

async function deleteList(list) {
  if (!confirm(`Liste "${list.label}" wirklich löschen?`)) return;
  try {
    const r = await fetch(
      getActiveBase() + CONFIG.STOCKS_LISTS_PATH + '/' + list.key,
      { method: 'DELETE', headers: authHeaders(), credentials: 'omit' },
    );
    if (!r.ok) throw new Error('HTTP ' + r.status);
    delete _state[list.key];
    _activeList = LISTS.find(l => l.key !== list.key)?.key || 'Portfolio';
    await loadLists();
    if (!_state[_activeList]?.loaded) load(_activeList);
  } catch (e) { toast('Löschen fehlgeschlagen: ' + e.message, false); }
}

// ── Sub-tabs ──────────────────────────────────────────────────────────────
function buildListTabs() {
  const wrap = document.getElementById('pf-list-tabs');
  if (!wrap) return;
  wrap.innerHTML = '';

  LISTS.forEach(l => {
    const isActive = l.key === _activeList;
    const btn = document.createElement('button');
    btn.className = 'pf-list-tab' + (isActive ? ' active' : '');
    btn.textContent = l.label;
    btn.dataset.list = l.key;
    btn.addEventListener('click', () => switchList(l.key));
    wrap.appendChild(btn);

    if (isActive && !l.builtin) {
      const more = document.createElement('button');
      more.className = 'pf-list-tab pf-list-more';
      more.textContent = '⋯';
      more.title = 'Umbenennen / Löschen';
      more.addEventListener('click', e => { e.stopPropagation(); showListMenu(l, more); });
      wrap.appendChild(more);
    }
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'pf-list-tab pf-list-add';
  addBtn.textContent = '+';
  addBtn.title = 'Neue Liste';
  addBtn.addEventListener('click', createList);
  wrap.appendChild(addBtn);
}

function switchList(key) {
  if (key === _activeList) return;
  if (_state[_activeList]?.dirty) {
    if (!confirm('Ungespeicherte Änderungen für ' + _activeList + ' verwerfen?')) return;
    _state[_activeList].dirty = false;
  }
  _activeList = key;
  buildListTabs();
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
  runBtn.className = 'btn btn-primary'; runBtn.textContent = 'Jetzt scannen';
  runBtn.addEventListener('click', runNow);

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn'; exportBtn.textContent = 'Export';
  exportBtn.addEventListener('click', exportList);

  const moreBtn = document.createElement('button');
  moreBtn.className = 'btn'; moreBtn.textContent = '⋯'; moreBtn.title = 'Weitere Aktionen';
  moreBtn.addEventListener('click', () => {
    dismissMenu('pf-more-menu');
    const menu = document.createElement('div');
    menu.id = 'pf-more-menu'; menu.className = 'pf-action-sheet';

    const rBtn = document.createElement('button');
    rBtn.textContent = 'Neu laden';
    rBtn.addEventListener('click', () => { menu.remove(); load(_activeList); });

    const sBtn = document.createElement('button');
    sBtn.textContent = 'Jetzt scannen'; sBtn.className = 'btn-primary';
    sBtn.addEventListener('click', () => { menu.remove(); runNow(); });

    const xBtn = document.createElement('button');
    xBtn.textContent = 'Export';
    xBtn.addEventListener('click', () => { menu.remove(); exportList(); });

    menu.appendChild(rBtn); menu.appendChild(sBtn); menu.appendChild(xBtn);
    const rect = moreBtn.getBoundingClientRect();
    menu.style.top  = (rect.bottom + 4) + 'px';
    menu.style.left = Math.max(8, rect.right - 180) + 'px';
    document.body.appendChild(menu);
    const outside = ev => {
      if (!menu.contains(ev.target) && ev.target !== moreBtn) {
        menu.remove(); document.removeEventListener('click', outside, true);
      }
    };
    setTimeout(() => document.addEventListener('click', outside, true), 0);
  });

  $toolbar.appendChild(addBtn);
  $toolbar.appendChild(saveBtn);
  $toolbar.appendChild(moreBtn);
}

// ── Init ──────────────────────────────────────────────────────────────────
export function initPortfolio() {
  $body        = document.getElementById('portfolio-body');
  $toast       = document.getElementById('pf-toast');
  $toolbar     = document.getElementById('portfolio-toolbar');
  $filterInput = document.getElementById('pf-filter-input');

  if (!$body) return;

  buildToolbar();
  initSearch();

  if ($filterInput) {
    $filterInput.addEventListener('input', () => applyFilter($filterInput.value));
  }

  window.addEventListener('pwa:tab', e => {
    if (e.detail === 'portfolio' && !_state[_activeList]?.loaded) load();
  });

  window.addEventListener('beforeunload', e => {
    if (Object.values(_state).some(s => s.dirty)) { e.preventDefault(); e.returnValue = ''; }
  });

  // Load lists dynamically; auto-trigger if portfolio is already the active page
  loadLists().then(() => {
    if (document.getElementById('page-portfolio')?.classList.contains('active') &&
        !_state[_activeList]?.loaded) {
      load();
    }
  });
}
