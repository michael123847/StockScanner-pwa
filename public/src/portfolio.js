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

// Research lists (Input/research/*.csv) -- hidden by default, revealed via
// the "…" chip appended after "+" in buildListTabs(). Fetched once, cached.
let _researchLists = null;   // [{key,label}] or null (not yet fetched)
let _showResearch = false;

// Today's holding value per ticker, read from the SAME source the Übersicht's
// "Value" column uses -- the report JSON's per-ticker `holding.value_chf`
// (units x latest close, FX-converted, computed server-side). Reusing it rather
// than recomputing here guarantees the two tabs can never disagree.
// Map is {TICKER: value_chf}; empty on any failure, in which case the editor
// silently falls back to showing the stored CSV exposure.
let _todayValues = {};      // per active list
let _todayValuesList = null;
let _todayFx = null;        // report's fx snapshot, for CHF -> row-currency

// value_chf -> the row's OWN currency, so the number lines up with what the
// broker interface shows for that position. Mirrors viewer.js::convertCHFArr's
// divide-by-rate convention (rates are <CCY>CHF, i.e. CHF per unit).
function toRowCcy(valueChf, ccy) {
  if (typeof valueChf !== 'number' || !isFinite(valueChf)) return null;
  const c = (ccy || 'CHF').toUpperCase();
  if (c === 'CHF') return valueChf;
  if (!_todayFx) return null;
  const r = _todayFx[c + 'CHF'];
  if (c === 'BTC') {
    const bu = _todayFx.BTCUSD, uc = _todayFx.USDCHF;
    return (bu && uc) ? valueChf / (bu * uc) : null;
  }
  return (typeof r === 'number' && r !== 0) ? valueChf / r : null;
}

async function fetchTodayValues(list) {
  if (_todayValuesList === list) return _todayValues;
  _todayValues = {}; _todayValuesList = list; _todayFx = null;
  try {
    const idxR = await fetch(
      getActiveBase() + CONFIG.STOCKS_INDEX_PATH,
      { headers: authHeaders(), cache: 'no-store', credentials: 'omit' },
    );
    if (!idxR.ok) return _todayValues;
    const idx = await idxR.json();
    // manifest is newest-first; take this list's most recent report
    const entry = (Array.isArray(idx) ? idx : []).find(
      e => (e.list || e.label || '') === list || (e.file || '').includes('_' + list + '.json'));
    if (!entry || !entry.file) return _todayValues;
    const repR = await fetch(
      getActiveBase() + CONFIG.STOCKS_REPORT_PATH + '?file=' + encodeURIComponent(entry.file),
      { headers: authHeaders(), cache: 'no-store', credentials: 'omit' },
    );
    if (!repR.ok) return _todayValues;
    const rep = await repR.json();
    _todayFx = rep.fx || null;
    (rep.tickers || []).forEach(t => {
      const h = t.holding;
      if (h && typeof h.value_chf === 'number' && isFinite(h.value_chf)) {
        _todayValues[t.ticker] = h.value_chf;
      }
    });
  } catch { /* offline / no report yet -- fall back to CSV values */ }
  return _todayValues;
}

const fmtVal = v => (typeof v === 'number' && isFinite(v))
  ? v.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : '';

async function ensureResearchLists() {
  if (_researchLists !== null) return _researchLists;
  try {
    const r = await fetch(
      getActiveBase() + CONFIG.STOCKS_RESEARCH_LISTS_PATH,
      { headers: authHeaders(), cache: 'no-store', credentials: 'omit' },
    );
    _researchLists = r.ok ? await r.json() : [];
  } catch { _researchLists = []; }
  return _researchLists;
}

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
// row-currency amount -> CHF equivalent. Exact inverse of toRowCcy() above:
// that divides a CHF value by the <CCY>CHF rate to get the row-currency
// amount; this multiplies a row-currency amount by the same rate to get
// back to CHF, so the Exposure column can be sorted uniformly across
// currencies. Mirrors toRowCcy's null/fallback conditions exactly.
function toChf(amount, ccy) {
  if (typeof amount !== 'number' || !isFinite(amount)) return null;
  const c = (ccy || 'CHF').toUpperCase();
  if (c === 'CHF') return amount;
  if (!_todayFx) return null;
  const r = _todayFx[c + 'CHF'];
  if (c === 'BTC') {
    const bu = _todayFx.BTCUSD, uc = _todayFx.USDCHF;
    return (bu && uc) ? amount * bu * uc : null;
  }
  return (typeof r === 'number' && r !== 0) ? amount * r : null;
}

const SORT_COLS = [['ticker', 'Ticker'], ['name', 'Name'], ['exposure', 'Exposure']];
// null = no sort applied yet -- table displays in original CSV/load order and
// no header shows an arrow. Sorting is a VIEW-ONLY concern: it reorders these
// <tr> nodes for display, but collectRows() always saves by dataset.origIndex
// (see buildRow/buildTable below), so it is completely unaffected by this.
let sortKey = null;
let sortDir = 1;
// Original-position counter for the save order (dataset.origIndex on each
// <tr>, stamped by buildRow()). buildTable() resets this to the entries
// length after stamping a full load, so rows added afterwards (+ Zeile,
// search) get the next free index and are appended at the end of a save,
// in the order they were added -- they have no original CSV position.
let _nextOrigIndex = 0;

// Reads a live <tr> (as built by buildRow()) and returns a sortable value for
// the given key. Exposure sorts by CHF-equivalent value: parsed from
// dataset.csvValue (the save source of truth, same field collectRows() uses)
// converted via toChf(), falling back to the raw un-converted number when fx
// isn't available yet -- consistent with the rest of the file's graceful
// degradation when _todayFx hasn't loaded.
function rowSortVal(tr, key) {
  if (key === 'ticker') return (tr.querySelector('[data-field=ticker]')?.textContent || '').trim().toLowerCase();
  if (key === 'name')   return (tr.querySelector('[data-field=name]')?.textContent   || '').trim().toLowerCase();
  if (key === 'exposure') {
    const expEl = tr.querySelector('[data-field=exposure]');
    const raw = expEl ? parseFloat(expEl.dataset.csvValue) : NaN;
    if (!isFinite(raw)) return null;
    const ccy = tr.querySelector('[data-field=currency]')?.textContent.trim() || '';
    const chf = toChf(raw, ccy);
    return chf != null ? chf : raw;
  }
  return null;
}

// Reorders the EXISTING <tr> nodes in place (tbody.append() on already-child
// nodes just moves them) rather than rebuilding rows from data, so any
// in-progress contentEditable edit survives a sort. Nulls (unparsable
// exposure) always sort last, regardless of direction.
function sortRows(tbody) {
  if (!sortKey) return; // no sort active -- leave rows in their current (load/insert) order
  tbody = tbody || $body?.querySelector('.pf-table tbody');
  if (!tbody) return;
  const rows = [...tbody.querySelectorAll('tr')];
  rows.sort((a, b) => {
    const x = rowSortVal(a, sortKey), y = rowSortVal(b, sortKey);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'string' || typeof y === 'string') {
      return sortDir * (String(x) < String(y) ? -1 : (String(x) > String(y) ? 1 : 0));
    }
    return sortDir * (x - y);
  });
  tbody.append(...rows);
}

// Rebuilds just the <thead> row -- cheap and holds no user data, unlike the
// body rows sortRows() carefully preserves. Click toggles direction on the
// active column or switches column (ascending first), matching viewer.js's
// renderHead()/th.onclick convention.
function renderTableHead(thead, tbody) {
  const tr = document.createElement('tr');
  SORT_COLS.forEach(([key, label]) => {
    const th = document.createElement('th');
    th.className = 'pf-sortable';
    th.textContent = label + (sortKey === key ? (sortDir > 0 ? ' ▲' : ' ▼') : '');
    th.addEventListener('click', () => {
      if (sortKey === key) sortDir = -sortDir; else { sortKey = key; sortDir = 1; }
      renderTableHead(thead, tbody);
      sortRows(tbody);
    });
    tr.appendChild(th);
  });
  ['Ccy', '', ''].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    tr.appendChild(th);
  });
  thead.innerHTML = '';
  thead.appendChild(tr);
}

function buildTable(entries) {
  const tbl = document.createElement('table');
  tbl.className = 'pf-table';
  const thead = document.createElement('thead');
  tbl.appendChild(thead);
  const tbody = document.createElement('tbody');
  // Full rebuild from a known entries list -- this IS the original load/save
  // order, so reset the origIndex counter and stamp it 0..n-1 here. Any row
  // added later via buildRow() outside this loop (+ Zeile, search) falls
  // through to _nextOrigIndex++ and lands after these.
  _nextOrigIndex = 0;
  entries.forEach(e => tbody.appendChild(buildRow(e, _nextOrigIndex++)));
  tbl.appendChild(tbody);
  renderTableHead(thead, tbody);
  sortRows(tbody);
  return tbl;
}

function buildRow({ ticker = '', name = '', country = '', exposure = '', currency = '', proxy = '', proxy_currency = '', isin = '', 'as of': asOf = '' } = {}, origIndex) {
  const tr = document.createElement('tr');
  // Original save-order position -- collectRows() sorts on this, NOT DOM
  // order, so a view sort never affects what gets written to the CSV. Rows
  // built outside buildTable's entries loop (+ Zeile, search results) have no
  // original CSV position, so they default to the next free slot, appending
  // them after everything already loaded, in the order they were added.
  tr.dataset.origIndex = origIndex != null ? origIndex : _nextOrigIndex++;
  // Store original as-of so collectRows can preserve it when exposure is unchanged
  tr.dataset.asOf = asOf || '';
  // No editable UI for these four -- stash them on the DOM node so
  // collectRows() can round-trip them on every save (see load()'s comment;
  // isin's read-only sub-line below is a separate, display-only use of the
  // same value).
  tr.dataset.country       = country || '';
  tr.dataset.proxy         = proxy || '';
  tr.dataset.proxyCurrency = proxy_currency || '';
  tr.dataset.isin          = isin || '';

  const tickerTd = document.createElement('td');
  tickerTd.contentEditable = 'true';
  tickerTd.dataset.field = 'ticker';
  tickerTd.textContent = ticker;
  tickerTd.addEventListener('input', () => { _state[_activeList].dirty = true; });
  tr.appendChild(tickerTd);

  // Name — editable span + a read-only ISIN sub-line (tap to copy) when the
  // CSV row carries one. The sub-line itself is display-only; the ISIN value
  // is separately stashed on tr.dataset above and round-tripped by
  // collectRows(), so it can't be corrupted by editing the name.
  const nameTd = document.createElement('td');
  const nameSpan = document.createElement('span');
  nameSpan.contentEditable = 'true';
  nameSpan.dataset.field = 'name';
  nameSpan.textContent = name;
  nameSpan.addEventListener('input', () => { _state[_activeList].dirty = true; });
  nameTd.appendChild(nameSpan);
  if (isin) {
    const isinSub = document.createElement('div');
    isinSub.className = 'cell-sub pf-isin-sub';
    isinSub.textContent = isin;
    isinSub.title = 'ISIN — antippen zum Kopieren';
    isinSub.addEventListener('click', async e => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(isin);
        isinSub.classList.add('copied');
        setTimeout(() => isinSub.classList.remove('copied'), 1200);
      } catch { /* clipboard unavailable — silent, non-critical */ }
    });
    nameTd.appendChild(isinSub);
  }
  tr.appendChild(nameTd);

  // Exposure — shown as label; double-click opens edit popup
  const expTd = document.createElement('td');
  expTd.className = 'pf-edit-cell';
  expTd.title = 'Doppelklick zum Bearbeiten';
  const expSpan = document.createElement('span');
  expSpan.dataset.field = 'exposure';
  const origExp = (exposure != null && exposure !== '') ? String(exposure) : '';
  // CRITICAL: dataset.csvValue is the SAVE source of truth (the stored CSV
  // exposure, valued at `as of`). textContent is DISPLAY ONLY and shows today's
  // revalued holding. collectRows() must read csvValue, never textContent --
  // otherwise saving would write today's value back into the CSV while keeping
  // the old as-of date, silently corrupting the basis.
  expSpan.dataset.csvValue  = origExp;
  expSpan.dataset.origValue = origExp;
  // Displayed in the ROW'S OWN currency (not CHF) so it lines up 1:1 with the
  // broker interface for that position -- value_chf is only the transport form.
  const todayChf = _todayValues[ticker];
  const todayVal = toRowCcy(todayChf, currency);
  const haveToday = typeof todayVal === 'number' && isFinite(todayVal);
  expSpan.textContent = haveToday ? fmtVal(todayVal) : origExp;
  if (haveToday) expSpan.classList.add('pf-today-val');
  expTd.appendChild(expSpan);
  // Sub-line: what the displayed number IS. With today's value on top, the
  // stored basis and its Stichtag would otherwise be invisible -- and rows in
  // one list routinely carry different dates (Portfolio.csv spans 2026-06-13
  // to 2026-07-29), so a six-week-old basis must not look like today's.
  const asOfSub = document.createElement('div');
  asOfSub.className = 'cell-sub pf-asof-sub';
  asOfSub.dataset.field = 'as-of-display';
  // Bare date only. The verbose "heute · Basis X per Y" form was measured
  // ellipsised on mobile (exposure cell is 72px at 390px viewport), and the
  // DATE is exactly what gets cut -- i.e. the one thing this sub-line exists to
  // show. The basis value lives one double-click away in the popup, and the
  // title below carries the full explanation on hover/long-press.
  asOfSub.textContent = asOf || '—';
  asOfSub.title = haveToday
    ? `Heutiger Wert in ${currency || 'CHF'} (Bestand × aktueller Kurs). `
      + `Basis: ${origExp || '—'} per ${asOf || '—'}. Doppelklick zum Bearbeiten.`
    : 'Stichtag des Exposures — Doppelklick zum Bearbeiten';
  expTd.appendChild(asOfSub);
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

  // Edits the STORED CSV exposure (the value as of the Stichtag below), never
  // the today-value shown in the table -- see buildRow's dataset.csvValue note.
  const expLabel = document.createElement('label');
  expLabel.textContent = 'Exposure (per Stichtag)';
  const expInput = document.createElement('input');
  expInput.type = 'text'; expInput.inputMode = 'decimal';
  expInput.value = expSpan ? (expSpan.dataset.csvValue || '') : '';
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

  // Stichtag ("as of") -- the date the exposure above was valued on. Previously
  // invisible in the UI while being silently rewritten to today on any exposure
  // edit, so a stale row and a fresh one looked identical. Now shown and
  // editable: a value entered here is the user's explicit statement of WHEN the
  // exposure was true, and collectRows() honours it instead of stamping today.
  const asOfLabel = document.createElement('label');
  asOfLabel.textContent = 'Stichtag (as of)';
  const asOfInput = document.createElement('input');
  asOfInput.type = 'date';
  asOfInput.value = tr.dataset.asOf || '';
  asOfLabel.appendChild(asOfInput);

  const btns = document.createElement('div');
  btns.className = 'pf-ep-btns';
  const okBtn = document.createElement('button'); okBtn.textContent = 'OK'; okBtn.type = 'button';
  const cancelBtn = document.createElement('button'); cancelBtn.textContent = '✕'; cancelBtn.type = 'button';
  btns.appendChild(okBtn); btns.appendChild(cancelBtn);

  popup.appendChild(expLabel); popup.appendChild(ccyLabel);
  popup.appendChild(asOfLabel); popup.appendChild(btns);

  const rect = tr.getBoundingClientRect();
  popup.style.position = 'fixed';
  popup.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 220)) + 'px';
  document.body.appendChild(popup);
  // Flip above the row when there isn't room below (e.g. a row near the bottom
  // of the viewport) -- fixed positioning means an off-viewport popup can never
  // be scrolled into reach, silently stranding the OK/Cancel buttons.
  const popupHeight = popup.offsetHeight;
  const top = (rect.bottom + 4 + popupHeight <= window.innerHeight)
    ? rect.bottom + 4
    : Math.max(8, rect.top - popupHeight - 4);
  popup.style.top = top + 'px';
  expInput.focus(); expInput.select();

  function confirm() {
    const origAsOf = tr.dataset.asOf || '';
    const newAsOf = (asOfInput.value || '').trim();
    if (expSpan) {
      const newVal = expInput.value.trim();
      if (newVal !== (expSpan.dataset.origValue || '')) expSpan.dataset.changed = '1';
      // Update the SAVE source; the cell keeps showing today's value unless the
      // user has now overridden the basis, in which case today's revaluation is
      // stale until the next scan -- show the entered basis rather than a
      // number that no longer derives from it.
      expSpan.dataset.csvValue = newVal;
      if (expSpan.dataset.changed) {
        expSpan.textContent = newVal;
        expSpan.classList.remove('pf-today-val');
      }
    }
    if (ccySpan) ccySpan.textContent = ccySel.value;
    // An explicitly edited Stichtag WINS over the auto-stamp: record it and
    // clear the `changed` flag that would otherwise make collectRows() overwrite
    // it with today. Editing the exposure alone still auto-stamps today, which
    // is the old behaviour and the right default.
    if (newAsOf !== origAsOf) {
      tr.dataset.asOf = newAsOf;
      tr.dataset.asOfEdited = '1';
      if (expSpan) delete expSpan.dataset.changed;
    }
    // Keep the visible sub-line in step with whichever date will actually be
    // saved -- an exposure edit auto-stamps today, so reflect that immediately
    // rather than leaving the row showing a date save() is about to replace.
    const sub = tr.querySelector('[data-field="as-of-display"]');
    if (sub) {
      const effective = tr.dataset.asOfEdited
        ? (tr.dataset.asOf || '')
        : ((expSpan && expSpan.dataset.changed) ? new Date().toISOString().slice(0, 10)
                                                : (tr.dataset.asOf || ''));
      sub.textContent = effective || '—';
    }
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
  // Sort by dataset.origIndex (the CSV load order, stamped in buildRow()),
  // NOT DOM order -- the DOM order reflects the current VIEW sort, which
  // must never leak into what gets saved. Deleted rows simply aren't in the
  // NodeList any more, so the remaining rows concatenate with no gap.
  return [...$body.querySelectorAll('.pf-table tbody tr')]
    .sort((a, b) => (Number(a.dataset.origIndex) || 0) - (Number(b.dataset.origIndex) || 0))
    .map(tr => {
    const ticker   = tr.querySelector('[data-field=ticker]')?.textContent.trim() || '';
    const name     = tr.querySelector('[data-field=name]')?.textContent.trim()   || '';
    const expEl    = tr.querySelector('[data-field=exposure]');
    // Read dataset.csvValue, NOT textContent: the cell displays today's
    // revalued holding, and writing that back would overwrite the stored basis
    // while keeping its old Stichtag. Falls back to textContent only for rows
    // built before this field existed / added via "+ Zeile".
    const expRaw   = expEl ? (expEl.dataset.csvValue !== undefined
                              ? expEl.dataset.csvValue.trim()
                              : expEl.textContent.trim()) : '';
    const currency = tr.querySelector('[data-field=currency]')?.textContent.trim() || '';
    const exposure = expRaw !== '' ? expRaw : '';
    // As-of resolution, in priority order:
    //   1. an explicitly edited Stichtag ALWAYS wins -- the user stating when a
    //      value was true must not be silently overwritten by the auto-stamp;
    //   2. else exposure changed via the popup -> stamp today (old behaviour);
    //   3. else preserve the original date the row was loaded with.
    let asOf = '';
    if(exposure !== ''){
      asOf = tr.dataset.asOfEdited ? (tr.dataset.asOf || today)
           : (expEl && expEl.dataset.changed) ? today
           : (tr.dataset.asOf || today);
    }
    // country/proxy/proxy_currency/isin have no editable UI -- read back from
    // tr.dataset (stashed by buildRow()) so a save that only touches OTHER
    // rows can't silently scrub these columns from this one.
    return {
      ticker, name, exposure, currency, 'as of': asOf,
      country:        tr.dataset.country || '',
      proxy:          tr.dataset.proxy || '',
      proxy_currency: tr.dataset.proxyCurrency || '',
      isin:           tr.dataset.isin || '',
    };
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
    // isin/proxy round-trip through pandas/JSON as the literal string "nan"
    // when unset (existing backend quirk) -- filter that out here so
    // buildRow() only ever sees a real value or ''.
    const isIsinCol = v => v && String(v).toLowerCase() !== 'nan';
    const entries = (await r.json()).map(e => { const n = _lc(e); return {
      ticker:         n.ticker   || '',
      name:           n.name     || '',
      country:        n.country  || '',
      exposure:       n.exposure != null ? n.exposure : '',
      currency:       n.currency || '',
      proxy:          isIsinCol(n.proxy) ? n.proxy : '',
      proxy_currency: n.proxy_currency || '',
      isin:           isIsinCol(n.isin) ? n.isin : '',
      'as of':        n['as of'] || '',
    }; });
    // Today's values before buildTable, so buildRow can render them directly.
    // Non-fatal by construction: on any failure the map stays empty and rows
    // fall back to showing the stored CSV exposure.
    await fetchTodayValues(list);
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

  // Centered modal prompt (backdrop + card) rather than an anchored popup: the old
  // popup was positioned off the ⇄ button and dismissed on any next click, which on
  // mobile often closed before the target tap landed. This asks "move where?" plainly.
  const backdrop = document.createElement('div');
  backdrop.className = 'row-sheet-backdrop';
  backdrop.id = 'pf-move-backdrop';

  const card = document.createElement('div');
  card.id = 'pf-move-menu';
  card.className = 'pf-action-sheet pf-move-modal';

  const close = () => { backdrop.remove(); card.remove(); };

  const title = document.createElement('div');
  title.className = 'pf-move-title';
  title.innerHTML = `<b>${ticker}</b> verschieben nach:`;
  card.appendChild(title);

  for (const target of others) {
    const row = document.createElement('div');
    row.className = 'pf-move-row';
    const lbl = document.createElement('span');
    lbl.className = 'pf-move-listname';
    lbl.textContent = target.label;
    const mv = document.createElement('button');
    mv.textContent = 'Verschieben';
    mv.addEventListener('click', async () => { close(); await moveCopyTicker(ticker, name, target.key, false); });
    const cp = document.createElement('button');
    cp.textContent = 'Kopieren';
    cp.addEventListener('click', async () => { close(); await moveCopyTicker(ticker, name, target.key, true); });
    row.appendChild(lbl); row.appendChild(mv); row.appendChild(cp);
    card.appendChild(row);
  }

  const cancel = document.createElement('button');
  cancel.className = 'pf-move-cancel';
  cancel.textContent = 'Abbrechen';
  cancel.addEventListener('click', close);
  card.appendChild(cancel);

  backdrop.addEventListener('click', close);
  document.body.appendChild(backdrop);
  document.body.appendChild(card);
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

  const researchBtn = document.createElement('button');
  researchBtn.className = 'pf-list-tab pf-list-research' + (_showResearch ? ' active' : '');
  researchBtn.textContent = '…';
  researchBtn.title = 'Research-Listen ein-/ausblenden';
  researchBtn.addEventListener('click', () => {
    _showResearch = !_showResearch;
    if (_showResearch) ensureResearchLists().then(buildListTabs);
    else buildListTabs();
  });
  wrap.appendChild(researchBtn);

  if (_showResearch && _researchLists) {
    const knownKeys = new Set(LISTS.map(l => l.key));
    _researchLists.filter(r => !knownKeys.has(r.key)).forEach(r => {
      const isActive = r.key === _activeList;
      const btn = document.createElement('button');
      btn.className = 'pf-list-tab pf-list-tab-research' + (isActive ? ' active' : '');
      btn.textContent = r.label;
      btn.dataset.list = r.key;
      btn.addEventListener('click', () => switchList(r.key));
      wrap.appendChild(btn);
    });
  }
}

function switchList(key) {
  if (key === _activeList) return;
  if (_state[_activeList]?.dirty) {
    if (!confirm('Ungespeicherte Änderungen für ' + _activeList + ' verwerfen?')) return;
    _state[_activeList].dirty = false;
  }
  if (!_state[key]) _state[key] = { loaded: false, dirty: false };
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
