/**
 * viewer.js — Summary table + dependency-free canvas charts.
 *
 * The rendering engine is lifted almost verbatim from StockScanner's standalone
 * viewer.html (the table, the sort/filter, and the hand-rolled canvas charts for
 * price/MA/Fibonacci, recommendations, and RSI). The only change is the data
 * source: instead of reading relative Output/*.json files, it fetches the report
 * manifest and reports from the local server (/api/stocks/index + /report) with
 * the shared Bearer token. Charts are drawn client-side from the JSON `series`,
 * so no plot images are needed.
 */
import { CONFIG } from './config.js';
import { getActiveBase, authHeaders, invalidateLocal } from './localBridge.js';
import { clearToken } from './auth.js';
import { fmtDate, fmtDateTime } from './format.js';
import { labelFor, loadLists } from './lists.js';

const $ = s => document.querySelector(s);

const COL = {
  close:'#4ea1ff', ma50:'#ff9f40', ma200:'#ff5c5c',
  fib:['#b07cff','#9b7653','#e377c2','#9aa0aa'],
  recF:'#4ea1ff', recO:'#2ecc71', recM:'#ff5c5c', rsi:'#4ea1ff'
};
let DATA=null, ROWS=[], sortKey='name', sortDir=1, selected=null, viewLen=Infinity, hoverIdx=null;

// Series cache: Map keyed by "<list>|<ticker>|<asof>" → series object
const seriesCache = new Map();

// Perf series cache: Map keyed by list label → perf JSON
const perfCache = new Map();
// In-flight perf fetch promise (avoid duplicate requests)
let _perfFetch = null;

// ---------- currency ----------
const CURRENCY_KEY = 'pwa.stocks.currency';
const CURRENCIES = ['CHF','EUR','USD','GBP','BTC'];

function getCurrency(){
  try { const v = localStorage.getItem(CURRENCY_KEY); if(CURRENCIES.includes(v)) return v; } catch {}
  return 'CHF';
}
function setCurrency(v){
  try { localStorage.setItem(CURRENCY_KEY, v); } catch {}
}

// ---------- table variant ----------
const TABLE_PRESET_KEY  = 'pwa.stocks.tablePreset';
// ML is the benchmark signal column (2026-07 — Consensus, a weighted panel
// average, wasn't adding value over the production model's own signal).
// {panelKey:'ml_risk'} resolves the column by its stable REGISTRY key rather
// than its display label — a stale report that still says "ML (Live)" (label
// drift, e.g. before a rescan picks up a backend rename) would silently drop
// a literal-'ML' match and the column would vanish from the preset.
const PRESETS = {
  holdings: ['Ticker','Value','Δ1D','Δ21D', {panelKey:'ml_risk'}],
  chancen:  ['Ticker', {panelKey:'ml_risk'}, 'RSI','Mom14'],
};
function getPreset(){
  const fallback = ()=>(DATA&&(DATA.portfolio==='Portfolio'||DATA.fx))?'holdings':'chancen';
  try{
    const v=localStorage.getItem(TABLE_PRESET_KEY);
    if(['holdings','chancen','backtest'].includes(v)) return v;
  }catch{}
  return fallback();
}
function setPreset(v){ try{ localStorage.setItem(TABLE_PRESET_KEY,v); }catch{} }

// ---------- allocation (scheme-#5 sleeve view) ----------
// Lives in the Digest page's "Allokation" sub-tab: it's portfolio-wide and
// list-independent (unlike everything in Übersicht, which is per-report), so
// it isn't part of getPreset()/PRESETS above and doesn't touch #tbl.
let allocationData = null;     // cached JSON once fetched successfully
let allocationTried = false;   // fetch attempted (success or failure)

/** Re-attempt the allocation fetch after a scan completes, if it previously
 *  failed (e.g. allocation_scheme5.json didn't exist yet on first app open) —
 *  otherwise the Allokation sub-tab would stay empty until an app restart. */
function retryAllocationIfMissing(){
  if(!allocationData){
    allocationTried = false;
    ensureAllocation();
  }
}

/** Fetch Output/allocation_scheme5.json via the server; cache in a module var.
 *  Failure is silent (console.warn only) — renderAllocation() shows its own
 *  empty state. Re-renders immediately if the Allokation sub-tab is open. */
export async function ensureAllocation(){
  if(allocationTried) return allocationData;
  allocationTried = true;
  try{
    const url = getActiveBase() + CONFIG.STOCKS_ALLOCATION_PATH;
    allocationData = await apiJson(url);
  }catch(err){
    allocationData = null;
    console.warn('allocation fetch failed:', err.message);
  }
  const panel = $('#alloc-panel');
  if(panel && panel.style.display !== 'none') renderAllocation();
  return allocationData;
}

// ---------- backtest metrics (slim per-ticker, deployed model) ----------
// Output/backtest_metrics.json via scripts/backtest_metrics.py — persistent
// until that script is rerun after a model retrain (own model_id field).
// Computed once per ticker; covers every list, so no per-report refetch.
let metricsData = null;
let metricsTried = false;

async function ensureMetrics(){
  if(metricsTried) return metricsData;
  metricsTried = true;
  try{
    const url = getActiveBase() + CONFIG.STOCKS_METRICS_PATH;
    metricsData = await apiJson(url);
  }catch(err){
    metricsData = null;
    console.warn('backtest metrics fetch failed:', err.message);
  }
  if(getPreset()==='backtest' && DATA) renderOverview();
  return metricsData;
}
function metricsFor(ticker){ return (metricsData && metricsData.tickers && metricsData.tickers[ticker]) || null; }

const TABLE_VARIANT_KEY = 'pwa.stocks.tableVariant';
function getTableVariant(){
  try{ const v=localStorage.getItem(TABLE_VARIANT_KEY); if(['auto','classic','compact'].includes(v)) return v; }catch{}
  return 'auto';
}
const isPortrait=()=>window.matchMedia('(orientation: portrait)').matches;

/**
 * Convert a CHF value to the display currency using the report's FX snapshot.
 * fx = report.fx object { USDCHF, EURCHF, GBPCHF, BTCUSD }.
 * Returns a formatted string or '—' when conversion is not possible.
 */
function convertCHF(valueCHF, currency, fx){
  if(valueCHF == null || !isNum(valueCHF)) return '—';
  if(!fx) return currency === 'CHF' ? fSig(valueCHF) + ' CHF' : '—';
  let result;
  if(currency === 'CHF'){
    result = valueCHF;
  } else if(currency === 'USD'){
    if(!isNum(fx.USDCHF) || fx.USDCHF === 0) return '—';
    result = valueCHF / fx.USDCHF;
  } else if(currency === 'EUR'){
    if(!isNum(fx.EURCHF) || fx.EURCHF === 0) return '—';
    result = valueCHF / fx.EURCHF;
  } else if(currency === 'GBP'){
    if(!isNum(fx.GBPCHF) || fx.GBPCHF === 0) return '—';
    result = valueCHF / fx.GBPCHF;
  } else if(currency === 'BTC'){
    if(!isNum(fx.BTCUSD) || fx.BTCUSD === 0 || !isNum(fx.USDCHF) || fx.USDCHF === 0) return '—';
    result = valueCHF / (fx.BTCUSD * fx.USDCHF);
  } else {
    return '—';
  }
  if(!isNum(result)) return '—';
  if(currency === 'BTC') return fSig(result) + ' BTC';
  return fSig(result) + ' ' + currency;
}

/**
 * Convert a CHF value using per-date FX arrays (for the perf graph).
 * fxArrays = { USDCHF:[…], EURCHF:[…], GBPCHF:[…], BTCUSD:[…] }, idx = date index.
 * Returns a number or null.
 */
function convertCHFArr(valueCHF, currency, fxArrays, idx){
  if(valueCHF == null || !isNum(valueCHF)) return null;
  if(currency === 'CHF') return valueCHF;
  const get = (arr) => (arr && isNum(arr[idx])) ? arr[idx] : null;
  if(currency === 'USD'){
    const r = get(fxArrays && fxArrays.USDCHF); return (r && r !== 0) ? valueCHF / r : null;
  } else if(currency === 'EUR'){
    const r = get(fxArrays && fxArrays.EURCHF); return (r && r !== 0) ? valueCHF / r : null;
  } else if(currency === 'GBP'){
    const r = get(fxArrays && fxArrays.GBPCHF); return (r && r !== 0) ? valueCHF / r : null;
  } else if(currency === 'BTC'){
    const btcusd = get(fxArrays && fxArrays.BTCUSD);
    const usdchf = get(fxArrays && fxArrays.USDCHF);
    return (btcusd && usdchf && btcusd !== 0 && usdchf !== 0) ? valueCHF / (btcusd * usdchf) : null;
  }
  return null;
}

// Track whether the Charts page is visible (clientWidth/Height == 0 when hidden).
let chartsVisible = false;
// Guard resize: only redraw on actual width changes, not URL-bar height jitter.
let lastW = 0;

// ---------- chart prefs ----------
let chartType = 'line'; // 'line' | 'candle'
let show50 = true, show200 = true, showFib = true;
let showRule = true, showDp = true, showMlLive = true;

const CHART_PREFS_KEY = 'pwa.stocks.chartPrefs';

function loadChartPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(CHART_PREFS_KEY) || '{}');
    if (p.type === 'candle' || p.type === 'line') chartType = p.type;
    if (typeof p.ma50 === 'boolean') show50 = p.ma50;
    if (typeof p.ma200 === 'boolean') show200 = p.ma200;
    if (typeof p.fib === 'boolean') showFib = p.fib;
    if (typeof p.rule === 'boolean') showRule = p.rule;
    if (typeof p.dp === 'boolean') showDp = p.dp;
    if (typeof p.mlLive === 'boolean') showMlLive = p.mlLive;
  } catch {}
}

function saveChartPrefs() {
  try {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({
      type: chartType, ma50: show50, ma200: show200, fib: showFib,
      rule: showRule, dp: showDp, mlLive: showMlLive,
    }));
  } catch {}
}

// ---------- formatting ----------
const isNum = v => typeof v==='number' && isFinite(v);
// Locale pinned to en-US (not `undefined`/device locale): every other number
// formatter here (fPct, fInt, rsiCell's .toFixed) is locale-independent and
// always dot-decimal — fNum with the device locale produced "61,4" on a
// German/Swiss phone while the table showed "61.4" for the same value.
const fNum=(v,d=2)=> isNum(v)? v.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}) : '—';
const fPct=v=> isNum(v)? (v*100).toFixed(1)+'%' : '—';
const fInt=v=> isNum(v)? Math.round(v).toString() : '—';
const fSig=v=>{ if(!isNum(v)) return '—';
  const a=Math.abs(v); let div=1,suf='';
  if(a>=1e9){div=1e9;suf='b';} else if(a>=1e6){div=1e6;suf='m';} else if(a>=1e3){div=1e3;suf='k';}
  let s=(v/div).toPrecision(4); if(s.indexOf('.')>=0) s=s.replace(/\.?0+$/,'');
  return s+suf; };
// Legacy rank for back-compat; signal polarity now uses signalRank() below.
const recRank={Buy:3,Hold:2,Sell:1};

// Signal polarity rank — most-bearish=1 … most-bullish=highest.
// Covers all four axes; unknown signals default to 0 (sorts last).
const SIGNAL_RANK = {
  // reference
  'Sell':1,'Hold':2,'Buy':3,
  // defensive
  'Strong Sell':1,'Reduce':2,/*Hold:2 already*/'Strong Buy':5,
  // directional
  'Lev Short':1,'Short':2,'Neutral':3,'Long':4,'Lev Long':5,
  // tactical
  'Exit':1,'Wait':2,/*Hold:2*/'Enter':4,
};
// defensive 'Buy' = 4 (not in reference 'Buy'=3 — same label, same rank OK)
SIGNAL_RANK['Buy'] = Math.max(SIGNAL_RANK['Buy']||0, 4);
// defensive 'Hold' = 3 (keep max)
SIGNAL_RANK['Hold'] = Math.max(SIGNAL_RANK['Hold']||0, 3);
// tactical 'Hold' = 3
// Already set via max above.

function signalRank(signal){ return signal ? (SIGNAL_RANK[signal] || 0) : 0; }

// ---------- schema normalisation ----------
function normalizeSchema(json){
  if(json.schema === 2) return json; // already v2 — pass through unchanged
  // Synthesize v2 shape from flat summary fields
  json.columns = [
    {key:'rule',    label:'Rule',       axis:'reference', badge:'validated'},
    {key:'ml_risk', label:'ML',         axis:'defensive'},
    {key:'dp',      label:'DP (Oracle)',axis:'reference', badge:'oracle'},
    {key:'ml',      label:'The Bet',    axis:'reference', badge:'experimental'},
  ];
  for(const t of (json.tickers||[])){
    const s = t.summary || {};
    const panel = {};
    if(s['Recommendation_3_1'] != null) panel.rule = {signal: s['Recommendation_3_1']};
    if(s['Recommendation_ML']  != null) panel.ml   = {signal: s['Recommendation_ML']};
    if(s['Optimal_hindsight']  != null) panel.dp   = {signal: s['Optimal_hindsight']};
    t.panel = panel;
    // consensus remains undefined for old reports — renderer shows '—'
  }
  return json;
}

// ---------- glyph renderer ----------
// Axis colour semantics: bearish → sell ramp, neutral → hold, bullish → buy ramp.
// Strong/Lev variants use bold shades (--buy-strong / --sell-strong).
const BEARISH_SIGNALS  = new Set(['Sell','Strong Sell','Reduce','Lev Short','Short','Exit']);
const NEUTRAL_SIGNALS  = new Set(['Hold','Neutral','Wait']);
// Everything else is treated bullish.

function signalColorClass(signal){
  if(!signal) return '';
  if(BEARISH_SIGNALS.has(signal)){
    // Extra-strong bearish
    if(signal==='Strong Sell'||signal==='Lev Short') return 'sig-strong-sell';
    return 'sig-sell';
  }
  if(NEUTRAL_SIGNALS.has(signal)) return 'sig-hold';
  // bullish
  if(signal==='Strong Buy'||signal==='Lev Long') return 'sig-strong-buy';
  return 'sig-buy';
}

function slugSignal(signal){ return signal.toLowerCase().replace(/\s+/g,'-'); }

function glyph(cell, col){
  if(!cell || !cell.signal) return '—';
  const sig    = cell.signal;
  const axis   = (col && col.axis) || 'reference';
  const conf   = (typeof cell.conf === 'number') ? cell.conf : null;
  const colorCls = signalColorClass(sig);
  const opacity  = conf !== null ? (0.45 + 0.55 * conf).toFixed(3) : '1';
  const styleAttr = conf !== null ? ` style="opacity:${opacity}"` : '';

  // Badge/paper superscript mark
  let mark = '';
  if(col && col.badge === 'experimental') mark = `<sup title="experimental — not yet validated">*</sup>`;
  else if(col && col.badge === 'oracle')  mark = `<sup title="Oracle — Rückschau, nicht handelbar">*</sup>`;
  else if(col && col.paper)               mark = `<sup title="paper only">&#x1D4AB;</sup>`;

  return `<span class="glyph ax-${axis} ${colorCls}"${styleAttr}>${esc(sig)}${mark}</span>`;
}

// ---------- dynamic COLS helpers ----------
// Returns the full column list for a given report (DATA must be set first).
// Panel columns are injected after Δ1D; Consensus column follows panel columns.
// Consensus is deliberately NOT a table column (2026-07 — a weighted average of
// the panel isn't a stronger benchmark than ML itself, and it crowded a scarce
// first-columns slot). It's still shown in the row-sheet popup, which is why
// this lives as a standalone function rather than inline in buildCols().
function consensusGlyph(v){
  if(!v || typeof v.score !== 'number') return '—';
  const sign = v.score > 0 ? '+' : '';
  const tooltip = `Consensus ${sign}${v.score.toFixed(2)} (${v.flag})`;
  if(v.flag === 'mixed') {
    return `<span class="glyph ax-reference sig-hold" title="${tooltip}">Mixed ⚠</span>`;
  }
  let cls, label;
  if(v.score >= 0.75)       { cls = 'sig-strong-buy';  label = 'Strong Buy'; }
  else if(v.score >= 0.25)  { cls = 'sig-buy';         label = 'Buy'; }
  else if(v.score > -0.25)  { cls = 'cons-neutral';    label = 'Neutral'; }
  else if(v.score > -0.75)  { cls = 'sig-sell';        label = 'Sell'; }
  else                      { cls = 'sig-strong-sell'; label = 'Strong Sell'; }
  return `<span class="glyph ax-reference ${cls}" title="${tooltip}">${label}</span>`;
}

function buildCols(){
  const panelCols = DATA && DATA.columns ? DATA.columns : [];
  const staticBefore = [
    ['Ticker',   r=>r.ticker,                (v,r)=>tickerCell(r),    'l'],
    ['Name',     r=>r.name,                  v=>esc(v),               'l'],
    ['Δ1D',     r=>{ if(typeof r.s['change_1d']==='number') return r.s['change_1d']; const c=r.series&&r.series.close; return(c&&c.length>=2)?c[c.length-1]/c[c.length-2]-1:null; }, v=>pctCell(v), 'n'],
  ];
  const dynamicPanel = panelCols.map(col => [
    col.label,
    r => (r.panel && r.panel[col.key]) ? r.panel[col.key] : null,
    (cell) => glyph(cell, col),
    'b',
    {panelCol: col},  // metadata at index 4 for sortVal
  ]);
  const staticAfter = [
    ['Price',    r=>r.s['Current_Price'],     v=>fSig(v),              'n'],
    ['RSI',      r=>r.s['RSI'],               v=>rsiCell(v),           'n'],
    ['200DMA',   r=>r.s['200DMA'],            v=>fSig(v),              'n'],
    ['↕200',     r=>r.s['above_200DMA'],      v=>fInt(v),              'n'],
    ['50DMA',    r=>r.s['50DMA'],             v=>fSig(v),              'n'],
    ['Δ21D',     r=>r.s['Change_21D'],        v=>pctCell(v),           'n'],
    ['Mom14',    r=>r.s['Momentum'],          v=>pctCell(v),           'n'],
  ];

  // Value column — only injected when the report has holdings (fx snapshot present)
  const hasHoldings = DATA && DATA.fx;
  const valueCol = hasHoldings ? [
    'Value',
    r => (r.holding && isNum(r.holding.value_chf)) ? r.holding.value_chf : null,
    v => convertCHF(v, getCurrency(), DATA && DATA.fx),
    'n',
    {isValue: true},
  ] : null;

  return [...staticBefore, ...dynamicPanel, ...(valueCol ? [valueCol] : []), ...staticAfter];
}

// COLS is rebuilt each time a report loads; initialised with static fallback.
let COLS = [
  ['Ticker',   r=>r.ticker,                (v,r)=>tickerCell(r),    'l'],
  ['Name',     r=>r.name,                  v=>esc(v),               'l'],
  ['Δ1D',     r=>{ if(typeof r.s['change_1d']==='number') return r.s['change_1d']; const c=r.series&&r.series.close; return(c&&c.length>=2)?c[c.length-1]/c[c.length-2]-1:null; }, v=>pctCell(v), 'n'],
  ['Price',    r=>r.s['Current_Price'],     v=>fSig(v),              'n'],
  ['RSI',      r=>r.s['RSI'],               v=>rsiCell(v),           'n'],
  ['200DMA',   r=>r.s['200DMA'],            v=>fSig(v),              'n'],
  ['↕200',     r=>r.s['above_200DMA'],      v=>fInt(v),              'n'],
  ['50DMA',    r=>r.s['50DMA'],             v=>fSig(v),              'n'],
  ['Δ21D',     r=>r.s['Change_21D'],        v=>pctCell(v),           'n'],
  ['Mom14',    r=>r.s['Momentum'],          v=>pctCell(v),           'n'],
];

const esc = s => (s==null?'':String(s)).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function badge(v){ return v? `<span class="badge ${esc(v)}">${esc(v)}</span>` : '—'; }
function pctCell(v){ if(!isNum(v)) return '—'; const c=v<0?'neg':'pos'; return `<span class="num ${c}">${fPct(v)}</span>`; }
function rsiCell(v){ if(!isNum(v)) return '—'; const c = v>=70?'neg':(v<=30?'pos':''); return `<span class="num ${c}">${v.toFixed(1)}</span>`; }
function tickerCell(r){ return r.tag? `<a href="${esc(r.tag)}" target="_blank" rel="noopener">${esc(r.ticker)}</a>` : esc(r.ticker); }
function tickerCellSub(r){ const base=r.tag?`<a href="${esc(r.tag)}" target="_blank" rel="noopener">${esc(r.ticker)}</a>`:esc(r.ticker); return `<div>${base}</div><div class="cell-sub">${esc(r.name)}</div>`; }
function applyPresetCols(){
  const allow=PRESETS[getPreset()];
  if(!allow) return BACKTEST_COLS; // preset==='backtest' — a distinct column set, not a COLS filter
  return COLS.filter(c=>{
    const panelKey = c[4] && c[4].panelCol && c[4].panelCol.key;
    return allow.some(a => typeof a==='string' ? a===c[0] : (panelKey && a.panelKey===panelKey));
  }).map(c=>c[0]==='Ticker'?['Ticker',r=>r.ticker,(v,r)=>tickerCellSub(r),'l']:c);
}

// Signed delta cell: green/red by sign, plain fixed-point (not a percent —
// used for Sharpe deltas, which are ratio differences, not returns).
function numDeltaCell(v,d=2){ if(!isNum(v)) return '—'; const c=v<0?'neg':'pos'; const s=v>0?'+':''; return `<span class="num ${c}">${s}${v.toFixed(d)}</span>`; }

// "Backtest" column preset: slim per-ticker metrics from the deployed model
// (scripts/backtest_metrics.py via ensureMetrics()), independent of the
// current report's panel data — works for every list, including ones with no
// holdings/panel columns at all (e.g. Indices).
const BACKTEST_COLS = [
  ['Ticker',     r=>r.ticker,                          (v,r)=>tickerCellSub(r),        'l'],
  ['CAGR B&H',   r=>metricsFor(r.ticker)?.cagr_bh,      v=>fPct(v),                     'n'],
  ['Sharpe B&H', r=>metricsFor(r.ticker)?.sharpe_bh,    v=>isNum(v)?v.toFixed(2):'—',   'n'],
  ['ΔCAGR',      r=>metricsFor(r.ticker)?.d_cagr,       v=>pctCell(v),                  'n'],
  ['ΔSharpe',    r=>metricsFor(r.ticker)?.d_sharpe,     v=>numDeltaCell(v),             'n'],
  ['MaxDD',      r=>metricsFor(r.ticker)?.maxdd_ml,     v=>fPct(v),                     'n'],
];

// ---------- error surface ----------
export function setViewerError(msg){
  const el = $('#view-error');
  if(!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

// Navigate to Charts and select the ticker if it's in the current report.
// Returns true on success, false if the ticker is not loaded.
export function selectTickerIfPresent(sym){
  if(!ROWS.find(r=>r.ticker===sym)) return false;
  select(sym);
  window.dispatchEvent(new CustomEvent('pwa:navigate',{detail:'charts'}));
  return true;
}

// ---------- loading ----------
function load(json){
  setViewerError('');
  normalizeSchema(json);
  DATA=json;
  ROWS = (json.tickers||[]).map(t=>({ ...t, s:t.summary||{} }));
  COLS = buildCols();

  // Regime badge
  let regimeBadge = '';
  if(json.regime && json.regime.state){
    const rg = json.regime;
    const cls = rg.state==='Risk-On' ? 'sig-buy' : rg.state==='Risk-Off' ? 'sig-sell' : 'sig-hold';
    const why = Array.isArray(rg.why) ? rg.why.join(' · ') : '';
    const asof = rg.asof ? ` (${esc(fmtDate(rg.asof))})` : '';
    regimeBadge = `<span class="glyph regime-badge ${cls}" title="${esc(why)}">${esc(rg.state)}${asof}</span> &nbsp;`;
  }

  $('#meta').innerHTML = `${regimeBadge}<b>${esc(json.portfolio||'?')}</b> &nbsp;·&nbsp; ${ROWS.length} tickers &nbsp;·&nbsp; generated ${esc(fmtDateTime(json.generated||''))}`;
  renderOverview();
  populateChartTicker();
  if(ROWS.length) select(ROWS[0].ticker);

  // Show currency selector and perf graph only when the report has holdings
  const hasFx = !!(json.fx);
  const currSel = $('#currency-sel');
  const perfWrap = $('#perf-wrap');
  if(currSel){
    if(hasFx){
      currSel.value = getCurrency();
      currSel.style.display = '';
    } else {
      currSel.style.display = 'none';
    }
  }
  if(perfWrap){
    if(hasFx){
      perfWrap.style.display = '';
      loadPerfAndDraw();
    } else {
      perfWrap.style.display = 'none';
    }
  }
}

// ---------- server data ----------
const indexUrl  = () => getActiveBase() + CONFIG.STOCKS_INDEX_PATH;
const reportUrl = (file) => getActiveBase() + CONFIG.STOCKS_REPORT_PATH + '?file=' + encodeURIComponent(file);
const seriesUrl = (list, ticker, asof) => {
  let u = getActiveBase() + CONFIG.STOCKS_SERIES_PATH + '?list=' + encodeURIComponent(list) + '&ticker=' + encodeURIComponent(ticker);
  if (asof) u += '&asof=' + encodeURIComponent(asof);
  return u;
};

/**
 * ensureSeries(ticker) — fetch the series for a ticker if not already embedded or cached.
 * Assigns r.series on the ROWS entry and resolves when ready (or rejects on error).
 * Skips the fetch if the report already has an embedded series (back-compat with old reports).
 */
async function ensureSeries(ticker) {
  const r = ROWS.find(t => t.ticker === ticker);
  if (!r) return;
  // Back-compat: if an old report with embedded series is loaded, use it directly
  if (r.series && Array.isArray(r.series.date) && r.series.date.length > 0) return;

  const list = DATA && DATA.portfolio;
  if (!list) return;
  // Use the date part of the generated timestamp as the asof cutoff
  const asof = DATA.generated ? DATA.generated.slice(0, 10) : null;
  const cacheKey = `${list}|${ticker}|${asof||''}`;

  if (seriesCache.has(cacheKey)) {
    r.series = seriesCache.get(cacheKey);
    return;
  }

  const data = await apiJson(seriesUrl(list, ticker, asof));
  const s = data && data.ticker;
  if (s) {
    seriesCache.set(cacheKey, s);
    r.series = s;
  }
}

async function apiJson(url){
  let r;
  try {
    r = await fetch(url, { headers: authHeaders(), cache:'no-store', credentials:'omit' });
  } catch(err) {
    // Network-level failure (DNS, connection refused, timeout) — the base is
    // genuinely unreachable; drop the probed-base cache so the next call re-probes.
    invalidateLocal();
    throw err;
  }
  if(r.status === 401){ clearToken(); throw new Error('unauthorized'); }
  // A completed HTTP response — even an error one (404: allocation/series not
  // yet generated is routine) — proves the base IS reachable. Don't invalidate it.
  if(!r.ok){ throw new Error('HTTP_'+r.status); }
  return r.json();
}

// ---------- perf graph ----------
const perfUrl = (list) => getActiveBase() + CONFIG.STOCKS_PORTFOLIO_SERIES_PATH + '?list=' + encodeURIComponent(list);

async function loadPerfAndDraw(){
  const list = DATA && DATA.portfolio;
  if(!list || !DATA.fx) return;

  let perf;
  if(perfCache.has(list)){
    perf = perfCache.get(list);
  } else {
    // Avoid duplicate in-flight fetches
    if(!_perfFetch){
      _perfFetch = apiJson(perfUrl(list)).then(p => {
        perfCache.set(list, p);
        _perfFetch = null;
        return p;
      }).catch(err => {
        _perfFetch = null;
        console.warn('perf fetch failed:', err.message);
        return null;
      });
    }
    perf = await _perfFetch;
    if(!perf) return;
  }
  drawPerf(perf);
}

function drawPerf(perf){
  const cv = $('#c-perf');
  if(!cv) return;
  if(!perf || !Array.isArray(perf.dates) || !Array.isArray(perf.total)) return;

  const currency = getCurrency();
  const dates = perf.dates;
  const yVals = perf.total.map((v, i) => convertCHFArr(v, currency, perf.fx, i));

  const validVals = yVals.filter(v => v !== null && isNum(v));
  if(!validVals.length) return;

  const [yMin, yMax] = niceBounds(validVals);

  // Y-axis formatter
  let yfmt;
  if(currency === 'BTC'){
    yfmt = v => v.toFixed(4);
  } else {
    const mag = Math.abs(yMax);
    yfmt = mag >= 1e6 ? v => (v/1e6).toFixed(2)+'M'
         : mag >= 1e3 ? v => (v/1e3).toFixed(1)+'k'
         : v => v.toFixed(0);
  }

  plot({
    canvas: cv,
    x: dates,
    yMin, yMax,
    yticks: 4,
    yfmt,
    series: [{ data: yVals, color: '#4ea1ff', width: 1.8 }],
  });

  const lgEl = $('#lg-perf');
  if(lgEl) legend(lgEl, [['#4ea1ff', 'Portfolio (' + currency + ')']]);
}

/** Loads the report manifest and renders the newest report. */
export async function loadReports(){
  await loadLists();
  ensureAllocation(); // fire-and-forget: pre-warms the cache so the Allokation sub-tab is ready
  ensureMetrics();    // fire-and-forget: pre-warms so the Backtest preset is ready on first pick
  const list = await apiJson(indexUrl());
  const file = populateReports(list);
  if(file){
    const data = await apiJson(reportUrl(file));
    load(data);
  } else {
    $('#tbl').style.display='none';
    setViewerError('Noch keine Reports vorhanden — der erste Scan läuft um Mitternacht.');
  }
}

function fillDates(groups, listName, dateSel){
  if(!dateSel) return null;
  const items=groups.get(listName)||[];
  dateSel.innerHTML=items.map(e=>
    `<option value="${esc(e.file)}">${esc(fmtDate(e.generated||''))}${e.count?` · ${e.count}`:''}</option>`
  ).join('');
  dateSel.style.display=items.length?'':'none';
  return items.length?items[0].file:null; // newest first → index 0 = latest
}

function populateReports(list){
  const sel=$('#report');
  const dateSel=$('#report-date');
  if(!sel) return null;
  if(!list||!list.length){
    sel.style.display='none';
    if(dateSel) dateSel.style.display='none';
    return null;
  }
  // Group by list name; newest-first order preserved within each group.
  const groups=new Map();
  for(const e of list){ const k=e.portfolio||e.file; if(!groups.has(k)) groups.set(k,[]); groups.get(k).push(e); }
  // List selector — one option per list
  sel.innerHTML=[...groups.keys()].map(name=>`<option value="${esc(name)}">${esc(labelFor(name))}</option>`).join('');
  sel.value=groups.has('Portfolio')?'Portfolio':[...groups.keys()][0];
  sel.style.display='';
  // Populate date dropdown for the default list; capture file to load
  const file=fillDates(groups,sel.value,dateSel);
  // Wire list change: repopulate dates, load latest
  sel.onchange=()=>{
    const f=fillDates(groups,sel.value,dateSel);
    if(f) apiJson(reportUrl(f)).then(load).catch(err=>setViewerError('Report konnte nicht geladen werden: '+err.message));
  };
  // Wire date change: load chosen date
  if(dateSel) dateSel.onchange=()=>{
    if(dateSel.value) apiJson(reportUrl(dateSel.value)).then(load).catch(err=>setViewerError('Report konnte nicht geladen werden: '+err.message));
  };
  return file;
}

// Populate the chart-ticker <select> in the Charts tab.
function populateChartTicker(){
  const sel=$('#chart-ticker'); if(!sel) return;
  if(!ROWS.length){ sel.style.display='none'; return; }
  sel.innerHTML = ROWS.map(r=>`<option value="${esc(r.ticker)}">${esc(r.name)} (${esc(r.ticker)})</option>`).join('');
  sel.value = selected || ROWS[0].ticker;
  sel.style.display='';
  sel.onchange=()=>select(sel.value);
}

// ---------- table ----------

/** Explanation text for a column label. The report's columns[].desc (from the
 *  backend REGISTRY — the single source of truth for recommender texts) wins;
 *  the local EXPLAIN map covers client-only columns (Δ1D, RSI, …) and acts as
 *  fallback for pre-desc reports. */
function explainFor(label){
  const fromReport = DATA && Array.isArray(DATA.columns)
    ? DATA.columns.find(c => c.label === label)?.desc : null;
  return fromReport || EXPLAIN[label] || '';
}

function renderHead(cols){
  cols=cols||COLS;
  const tr=document.createElement('tr');
  cols.forEach((c)=>{
    const th=document.createElement('th');
    const key = c[0];
    th.textContent = key + (sortKey===key? (sortDir>0?' ▲':' ▼'):'');
    const desc = explainFor(key);
    if (desc) th.title = desc;   // desktop hover help; mobile uses the row sheet
    th.onclick=()=>{ if(sortKey===key) sortDir=-sortDir; else {sortKey=key; sortDir=1;} if(DATA) renderOverview(); };
    tr.appendChild(th);
  });
  const th=$('#tbl thead'); th.innerHTML=''; th.appendChild(tr);
}
function sortVal(r,key,cols){
  cols=cols||COLS;
  const col=cols.find(c=>c[0]===key); if(!col) return null;
  const v = col[1](r);
  // Panel column: sort by signal polarity rank
  if(col[4] && col[4].panelCol){
    return v ? signalRank(v.signal) : 0;
  }
  // Consensus column: sort by score
  if(key==='Cons.' && v && typeof v.score==='number') return v.score;
  // Legacy string rank (back-compat for any remaining string signals)
  if(typeof v==='string' && recRank[v]) return recRank[v];
  return v;
}
function renderBody(cols,rowOnClick){
  cols=cols||COLS;
  rowOnClick=rowOnClick||(r=>{select(r.ticker);window.dispatchEvent(new CustomEvent('pwa:navigate',{detail:'charts'}));});
  const q=$('#filter').value.trim().toLowerCase();
  let rows=ROWS.filter(r=> !q || (r.name+' '+r.ticker).toLowerCase().includes(q));
  rows.sort((a,b)=>{ let x=sortVal(a,sortKey,cols), y=sortVal(b,sortKey,cols);
    if(x==null) return 1; if(y==null) return -1;
    if(typeof x==='string'||typeof y==='string'){ x=String(x); y=String(y); return x<y?-sortDir:x>y?sortDir:0; }
    return (x-y)*sortDir; });
  const tb=$('#tbl tbody'); tb.innerHTML='';
  for(const r of rows){
    const tr=document.createElement('tr'); tr.dataset.ticker=r.ticker;
    if(r.ticker===selected) tr.className='sel';
    cols.forEach(c=>{ const td=document.createElement('td'); const val=c[1](r);
      td.innerHTML = c[2](val,r); if(c[3]==='l') td.style.textAlign='left'; tr.appendChild(td); });
    const _r=r; tr.onclick=()=>rowOnClick(_r);
    tb.appendChild(tr);
  }
}

// ---------- variant renderers ----------

// Column explanations. The recommender entries (Rule/ML/DP/Bet/Swing) are
// FALLBACKS only — schema-2 reports carry authoritative texts in
// columns[].desc, maintained in functions/panel.py REGISTRY (single source
// of truth; edit there, not here). The metric entries (Δ1D, RSI, …) are
// client-only display columns and are owned here.
const EXPLAIN = {
  'Rule':        'Regelbasierter Recommender: kauft bei Aufwärtstrend über 200DMA und gutem RSI; verkauft bei Umkehr.',
  'The Bet':     'Legacy ML-Modell (höchste CAGR im Backtest, Confidence-Sizing, kein Risiko-Overlay). Aggressivste Variante — hohe Rendite, hohes Drawdown-Risiko. ∗ = experimentell.',
  'DP (Oracle)': 'Rückblick-Optimum mit demselben Cut wie das Trainingslabel (dp_state_cut): bis zur Cut-Grenze durchgezogen, danach — noch nicht "settled" nahe dem aktuellen Rand — gestrichelt als vorläufiges Look-ahead. Benchmark, kein handelbares Signal. ∗ = Oracle.',
  'ML':          'Produktions-Modell (dp_state_cut, er=0.90). Das tatsächlich ausgerollte Signal — Risiko-optimiert, konservativer als The Bet. Stärke: Drawdown-Kontrolle (Bärenjahre ca. −25% vs. −54% Buy&Hold), nicht Mehrrendite.',
  'Swing':     'Swing-Trading-Signal: kurzfristige Trendfolge über ~14 Handelstage.',
  'Cons.':     'Consensus: gewichteter Mittelwert aller Recommender. Score +1 = max. Kauf, −1 = max. Verkauf. Mixed ⚠ = Recommender widersprechen sich.',
  'Δ1D':      'Tagesrendite: Kursänderung gegenüber dem Vortag in %.',
  'Δ21D':     '21-Tage-Rendite: Kursänderung über ~1 Monat in %.',
  'Mom14':    'Momentum (14 Handelstage): prozentuale Kursänderung der letzten zwei Wochen.',
  'RSI':       'Relative Strength Index (14 Tage). >70 = überkauft, <30 = überverkauft.',
  'Price':     'Aktueller Schlusskurs.',
  '200DMA':   '200-Tage-Durchschnittskurs. Langfristiger Trendindikator.',
  '50DMA':    '50-Tage-Durchschnittskurs. Mittelfristiger Trendindikator.',
  '↕200':     'Abstand zum 200DMA in %. Positiv = Kurs liegt über dem Langfristdurchschnitt.',
  'Value':     'Portfoliowert in der gewählten Währung (Bestand × aktueller Kurs, umgerechnet).',
  'CAGR B&H':   'Jährliche Rendite bei reinem Halten (Buy & Hold) über die gesamte gespeicherte Historie.',
  'Sharpe B&H': 'Sharpe-Ratio bei reinem Halten über die gesamte Historie.',
  'ΔCAGR':      'CAGR-Differenz: ML-Modell minus Buy & Hold. Positiv = Modell schlägt reines Halten.',
  'ΔSharpe':    'Sharpe-Differenz: ML-Modell minus Buy & Hold. Positiv = besseres risikoadjustiertes Ergebnis.',
  'MaxDD':      'Maximaler Drawdown des ML-Modells (schlimmster Rückgang vom letzten Hoch). Meist die robustere Stärke als die Rendite — siehe ΔCAGR.',
  'Order':      'Vorschlag für Ordertyp (Market/Limit) und Preis, abgeleitet aus Support-/Widerstandsniveaus (MA50, Bollinger-Bänder, Fibonacci) beim aktuellen ML-Signal. Nur ein Hinweis, keine Anlageberatung.',
};

function openRowSheet(ticker){
  const r=ROWS.find(t=>t.ticker===ticker); if(!r) return;
  document.querySelectorAll('.row-sheet-backdrop,.row-sheet').forEach(el=>el.remove());
  const backdrop=document.createElement('div'); backdrop.className='row-sheet-backdrop';
  const sheet=document.createElement('div'); sheet.className='row-sheet';
  const panelCols=DATA&&DATA.columns?DATA.columns:[];
  const consHtml=consensusGlyph(r.consensus);
  const recsHtml=[
    ...panelCols.map(col=>{
      const g=glyph(r.panel&&r.panel[col.key],col);
      return g==='—'?'':
        `<div class="rs-metric"><span class="rs-metric-label">${esc(col.label)}</span><span class="rs-metric-value">${g}</span></div>`;
    }),
    (consHtml&&consHtml!=='—')?
      `<div class="rs-metric"><span class="rs-metric-label">Cons.</span><span class="rs-metric-value">${consHtml}</span></div>`:'',
  ].join('');
  const skipCols=new Set(['Ticker','Name','Cons.']);
  const metricsHtml=COLS.filter(c=>!skipCols.has(c[0])&&!(c[4]&&c[4].panelCol))
    .map(c=>`<div class="rs-metric"><span class="rs-metric-label">${esc(c[0])}</span><span class="rs-metric-value">${c[2](c[1](r),r)}</span></div>`)
    .join('');
  // Backtest metrics: shown regardless of the active table preset (a quick
  // look without switching), but only once ensureMetrics() has resolved for
  // this ticker — otherwise the section is simply omitted, not dashed-out.
  const btRow = metricsFor(ticker);
  const backtestHtml = btRow ? BACKTEST_COLS.slice(1)
    .map(c=>`<div class="rs-metric"><span class="rs-metric-label">${esc(c[0])}</span><span class="rs-metric-value">${c[2](c[1](r),r)}</span></div>`)
    .join('') : '';
  // Order-execution hint: only present when the report carries one (active Buy/Sell
  // on the production ML signal) -- see functions/order_hint.py.
  const oh = r.order_hint;
  const orderHtml = oh ? `<div class="row-sheet-section">
    <div class="row-sheet-section-label">Ordervorschlag</div>
    <div class="rs-metrics">
      <div class="rs-metric"><span class="rs-metric-label">Order</span><span class="rs-metric-value">${esc(oh.type==='market'?'Market':'Limit')}${oh.price!=null?(' @ '+oh.price):''}</span></div>
    </div>
    <div class="rs-order-rationale">${esc(oh.rationale||'')}</div>
  </div>` : '';
  sheet.innerHTML=`<div class="row-sheet-panel">
    <div class="row-sheet-header">
      <div class="row-sheet-title">${tickerCell(r)}</div>
      <div class="row-sheet-sub">${esc(r.name)}&nbsp;&middot;&nbsp;${esc(r.exchange||'')}</div>
      <div class="row-sheet-hint">ⓘ doppeltippen für Erklärung</div>
    </div>
    <div class="row-sheet-section">
      <div class="row-sheet-section-label">Empfehlungen</div>
      <div class="rs-metrics">${recsHtml}</div>
    </div>
    <div class="row-sheet-section">
      <div class="row-sheet-section-label">Kennzahlen</div>
      <div class="rs-metrics">${metricsHtml}</div>
    </div>
    ${backtestHtml ? `<div class="row-sheet-section">
      <div class="row-sheet-section-label">Backtest (Ø deployed model)</div>
      <div class="rs-metrics">${backtestHtml}</div>
    </div>` : ''}
    ${orderHtml}
    <button class="btn btn-primary row-sheet-chart-btn">&rarr; Chart</button>
  </div>`;
  document.body.appendChild(backdrop); document.body.appendChild(sheet);
  const close=()=>{backdrop.remove();sheet.remove();};
  backdrop.addEventListener('click',close);
  sheet.querySelector('.row-sheet-chart-btn').addEventListener('click',()=>{
    close(); select(ticker); window.dispatchEvent(new CustomEvent('pwa:navigate',{detail:'charts'}));
  });
  sheet.querySelectorAll('.rs-metric').forEach(tile=>{
    tile.addEventListener('dblclick',e=>{
      e.stopPropagation();
      const key=(tile.querySelector('.rs-metric-label')||{}).textContent||'';
      const text=explainFor(key); if(!text) return;
      document.getElementById('rs-explain-popup')?.remove();
      const popup=document.createElement('div');
      popup.id='rs-explain-popup'; popup.className='rs-explain-popup';
      popup.textContent=text;
      const rect=tile.getBoundingClientRect();
      popup.style.top=(rect.bottom+4)+'px';
      popup.style.left=Math.max(8,Math.min(rect.left,window.innerWidth-244))+'px';
      document.body.appendChild(popup);
      const dismiss=ev=>{ if(!popup.contains(ev.target)){popup.remove();document.removeEventListener('click',dismiss,true);} };
      setTimeout(()=>document.addEventListener('click',dismiss,true),0);
    });
  });
}


function renderClassic(){
  const presetSel=$('#table-preset-sel');
  const tbl=$('#tbl');
  if(tbl) tbl.style.display='';
  // Column-profile switcher is always available now that it only ever holds
  // Holdings/Chancen/Backtest (Allokation moved to its own Digest sub-tab).
  if(presetSel){ presetSel.style.display=''; presetSel.value=getPreset(); }
  // Holdings/Chancen don't affect the desktop table (full COLS always shows —
  // they're a mobile column-count concession); Backtest is a genuinely
  // different column set, so it applies on desktop too.
  const cols = getPreset()==='backtest' ? BACKTEST_COLS : COLS;
  if(getPreset()==='backtest') ensureMetrics();
  renderHead(cols);
  renderBody(cols,r=>{ select(r.ticker); window.dispatchEvent(new CustomEvent('pwa:navigate',{detail:'charts'})); });
}

function renderCompact(){
  const presetSel=$('#table-preset-sel');
  const tbl=$('#tbl');
  if(tbl) tbl.style.display='';
  if(presetSel){ presetSel.style.display=''; presetSel.value=getPreset(); }
  if(getPreset()==='backtest') ensureMetrics();
  const presetCols=applyPresetCols();
  renderHead(presetCols);
  renderBody(presetCols,r=>openRowSheet(r.ticker));
}

function renderOverview(){
  const v=getTableVariant();
  if(v==='auto') isPortrait()?renderCompact():renderClassic();
  else if(v==='compact') renderCompact();
  else renderClassic();
}

// ---------- allocation view rendering ----------
const ALLOC_COLS = [
  ['Sleeve',        'l'],
  ['Achse',         'l'],
  ['Konviktion',    'n'],
  ['Haupt-Position','n'],
  ['1×-Shift',      'n'],
  ['Cash',          'n'],
];

// Compact "CAGR X% · MaxDD Y% · Sharpe Z" line for the documented backtested
// headline metrics (docs/ALLOCATION_STATUS.md; producer emits them statically,
// see scripts/alloc_scheme5_live.py HYBRID_METRICS/SCHEME5_METRICS).
function metricsBoxHtml(m){
  if(!m) return '';
  const cagr   = isNum(m.cagr_pct)  ? fPct(m.cagr_pct/100)  : '—';
  const maxdd  = isNum(m.maxdd_pct) ? fPct(m.maxdd_pct/100) : '—';
  const sharpe = isNum(m.sharpe)    ? m.sharpe.toFixed(2)   : '—';
  return `<div class="alloc-totals alloc-metrics">
    <span>CAGR <b>${cagr}</b></span>
    <span>MaxDD <b>${maxdd}</b></span>
    <span>Sharpe <b>${sharpe}</b></span>
  </div>`;
}

// Builds the "real money" hybrid table (small, separate <table> — not #alloc-tbl) as an HTML string.
function renderHybridHtml(h){
  const rows = (h.positions||[]).map(p=>{
    const conv = isNum(p.conviction_pct) ? fPct(p.conviction_pct/100) : '—';
    const cash = isNum(p.cash_pct) ? fPct(p.cash_pct/100) : '—';
    return `<tr>
      <td style="text-align:left">${esc(p.name||'')}<div class="cell-sub">${esc(p.ticker||'')}</div></td>
      <td style="text-align:left">${esc(p.stance||'')}</td>
      <td>${fPct((p.weight_pct||0)/100)}</td>
      <td>${conv}</td>
      <td>${fPct((p.hold_now_pct||0)/100)}</td>
      <td>${cash}</td>
    </tr>`;
  }).join('');
  return `
    <p class="section-label">${esc(h.label||'Portfolio (real money)')}</p>
    ${metricsBoxHtml(h.metrics)}
    <div class="table-scroll">
      <table class="alloc-hybrid-tbl">
        <thead><tr>
          <th style="text-align:left">Position</th>
          <th style="text-align:left">Stance</th>
          <th>Gewicht</th>
          <th>Konviktion</th>
          <th>Halten jetzt</th>
          <th>Cash</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="alloc-totals">
      <span><b>${fPct((h.cash_money_market_pct||0)/100)}</b> CHF Geldmarkt</span>
      <span>±${esc(h.rebalance_band_pp!=null?h.rebalance_band_pp:'')}pp Rebalance-Band</span>
    </div>
    ${h.note?`<p class="hint alloc-hint">${esc(h.note)}</p>`:''}
    <p class="hint alloc-hint">Per-Ticker-Evidenz (CAGR/Sharpe vs. Buy&amp;Hold, MaxDD) für jede
      Position: Übersicht → Spalten-Profil <b>Backtest</b>.</p>
  `;
}

export function renderAllocation(){
  const tbl=$('#alloc-tbl');
  const a = allocationData;
  const metaEl=$('#alloc-meta'), hybridEl=$('#alloc-hybrid'), footEl=$('#alloc-foot');

  if(!a){
    if(metaEl){ metaEl.style.display=''; metaEl.textContent='Allokation nicht verfügbar.'; }
    if(hybridEl){ hybridEl.style.display='none'; hybridEl.innerHTML=''; }
    if(tbl) tbl.style.display='none';
    if(footEl){ footEl.style.display='none'; footEl.innerHTML=''; }
    return;
  }

  if(metaEl){
    metaEl.style.display='';
    metaEl.innerHTML = `<b>${esc(a.label||'')}</b> &nbsp;·&nbsp; ${esc(fmtDate(a.asof||''))} &nbsp;·&nbsp; ${esc(a.currency||'')}`;
  }

  if(hybridEl){
    if(a.hybrid){
      hybridEl.style.display='';
      hybridEl.innerHTML = renderHybridHtml(a.hybrid)
        + '<p class="section-label alloc-hint">Research-Zielschema #5</p>'
        + metricsBoxHtml(a.scheme5_metrics);
    } else {
      hybridEl.style.display='none';
      hybridEl.innerHTML='';
    }
  }

  if(tbl) tbl.style.display='';
  const tr=document.createElement('tr');
  ALLOC_COLS.forEach(([label])=>{ const th=document.createElement('th'); th.textContent=label; tr.appendChild(th); });
  const thead=$('#alloc-tbl thead'); thead.innerHTML=''; thead.appendChild(tr);

  const sleeves = (a.sleeves||[]).slice().sort((x,y)=>
    ((y.hold_primary_pct||0)+(y.hold_1x_pct||0)) - ((x.hold_primary_pct||0)+(x.hold_1x_pct||0)));

  const tb=$('#alloc-tbl tbody'); tb.innerHTML='';
  for(const s of sleeves){
    const row=document.createElement('tr');
    const badge2x = s.primary_is_2x ? '<span class="badge-2x">2×</span>' : '';
    const shift = (s.shift_1x_ticker && isNum(s.hold_1x_pct) && s.hold_1x_pct>0)
      ? `${fPct((s.hold_1x_pct||0)/100)} ${esc(s.shift_1x_ticker)}`
      : '—';
    const cells = [
      `${esc(s.primary_ticker||s.sleeve||'')}`,
      esc(s.axis||''),
      fPct((s.conviction_pct||0)/100),
      `${fPct((s.hold_primary_pct||0)/100)}${badge2x}`,
      shift,
      fPct((s.cash_pct||0)/100),
    ];
    cells.forEach((html,i)=>{ const td=document.createElement('td'); td.innerHTML=html;
      if(ALLOC_COLS[i][1]==='l') td.style.textAlign='left'; row.appendChild(td); });
    tb.appendChild(row);
  }

  if(footEl){
    footEl.style.display='';
    const caveats = Array.isArray(a.caveats) ? a.caveats.map(c=>`<li>${esc(c)}</li>`).join('') : '';
    footEl.innerHTML = `
      <div class="alloc-totals">
        <span><b>${fPct((a.in_1x_twins_pct||0)/100)}</b> in 1× Twins</span>
        <span><b>${fPct((a.cash_money_market_pct||0)/100)}</b> CHF Geldmarkt</span>
      </div>
      <p class="hint alloc-hint">${esc(a.derisk_rule||'')}</p>
      <p class="hint alloc-hint">${esc(a.cash_destination||'')}</p>
      ${caveats?`<ul class="alloc-caveats">${caveats}</ul>`:''}
    `;
  }
}

// ---------- detail ----------
function select(ticker){
  selected=ticker;
  document.querySelectorAll('#tbl tbody tr').forEach(tr=>tr.classList.toggle('sel',tr.dataset.ticker===ticker));
  // Sync the chart-ticker dropdown.
  const sel=$('#chart-ticker'); if(sel && sel.value!==ticker) sel.value=ticker;
  const r=ROWS.find(t=>t.ticker===ticker); if(!r) return;
  $('#d-name').textContent = r.name;
  const panelCols = DATA && DATA.columns ? DATA.columns : [];
  const panelHtml = panelCols.map(col => {
    const cell = r.panel && r.panel[col.key];
    return `${esc(col.label)} ${glyph(cell, col)}`;
  }).join(' &nbsp;·&nbsp; ');
  $('#d-sub').innerHTML = `${tickerCell(r)} &nbsp;·&nbsp; ${esc(r.exchange||'')}` +
    (panelHtml ? ` &nbsp;·&nbsp; ${panelHtml}` : '');
  renderRanges();

  // Lazy-load series then draw. ensureSeries is a no-op if already present.
  ensureSeries(ticker).then(() => {
    // Enable/disable candle button depending on OHLC availability
    const hasOHLC = Array.isArray(r.series && r.series.open) && (r.series.open||[]).length > 0;
    const btnCandle = $('#btn-candle'), btnLine = $('#btn-line');
    if (btnCandle) {
      if (hasOHLC) {
        btnCandle.disabled = false;
        btnCandle.removeAttribute('title');
        // Restore saved chartType preference
        loadChartPrefs();
      } else {
        btnCandle.disabled = true;
        btnCandle.title = 'OHLC ab nächstem Scan verfügbar';
        chartType = 'line';
      }
      // Sync active button state
      if (chartType === 'candle' && hasOHLC) {
        btnCandle.classList.add('active');
        if (btnLine) btnLine.classList.remove('active');
      } else {
        if (btnLine) btnLine.classList.add('active');
        btnCandle.classList.remove('active');
      }
    }

    // Only draw if the charts page is currently visible — a hidden page has
    // clientWidth==0 which would produce a 1×1 buffer.
    if(chartsVisible) draw();
  }).catch(err => {
    console.warn('ensureSeries failed:', err.message);
    // Still attempt to draw with whatever we have (may be empty)
    if(chartsVisible) draw();
  });
}
function renderRanges(){
  const opts=[['Full',Infinity],['120d',120],['60d',60],['14d',14]];
  const box=$('#ranges'); box.innerHTML='';
  opts.forEach(([lbl,n])=>{ const b=document.createElement('button'); b.className='btn'+(viewLen===n?' active':''); b.textContent=lbl;
    b.onclick=()=>{ viewLen=n; renderRanges(); draw(); }; box.appendChild(b); });
}

// ---------- charts (dependency-free canvas) ----------
function sliceArr(a){ if(!a) return a; return viewLen===Infinity? a : a.slice(-viewLen); }
function curSeries(){
  const r=ROWS.find(t=>t.ticker===selected); if(!r) return null;
  // No series fetched yet (still in flight, or ensureSeries failed) → null, not
  // an empty object, so callers' existing `if(!S) return` guards catch it. Every
  // chart is keyed off S.date; without it there's nothing plottable.
  const S=r.series;
  if(!S || !Array.isArray(S.date) || !S.date.length) return null;
  const out={}; for(const k in S) out[k]=sliceArr(S[k]); return out;
}
function legend(el, items){ el.innerHTML = items.map(([c,t,dash])=>`<span><i style="border-color:${c};border-top-style:${dash?'dashed':'solid'}"></i>${esc(t)}</span>`).join(''); }

/**
 * setupCanvas — CSS-driven sizing that never reads back the buffer attribute.
 *
 * The old code read cv.getAttribute('height') then wrote cv.height = h*dpr,
 * which reflects back into the attribute. Each call on mobile (dpr≈3) tripled
 * the displayed height. Fixed: read clientWidth/clientHeight (the CSS box,
 * always stable), compute buffer pixels from those, and only assign when the
 * buffer actually needs to change.
 */
function setupCanvas(cv){
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;   // CSS box — never the buffer
  const bw = Math.max(1, Math.round(w*dpr)), bh = Math.max(1, Math.round(h*dpr));
  if (cv.width  !== bw) cv.width  = bw;            // resize buffer only when changed
  if (cv.height !== bh) cv.height = bh;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  return {ctx, w, h};
}

function niceBounds(vals){
  let mn=Infinity,mx=-Infinity; for(const v of vals) if(isNum(v)){ if(v<mn)mn=v; if(v>mx)mx=v; }
  if(mn===Infinity){mn=0;mx=1;} if(mn===mx){mn-=1;mx+=1;}
  const pad=(mx-mn)*0.08; return [mn-pad, mx+pad];
}
// generic plot: cfg={canvas, x:[labels], yMin,yMax, series:[{data,color,width,dash}], hlines:[{y,color}], yfmt}
function plot(cfg){
  const cv=cfg.canvas, {ctx,w,h}=setupCanvas(cv);
  const PL=54, PR=12, PT=10, PB=22, n=cfg.x.length;
  const plotW=w-PL-PR, plotH=h-PT-PB;
  const xAt=i=> PL + (n<=1?0:(i/(n-1))*plotW);
  const yAt=v=> PT + (1-(v-cfg.yMin)/(cfg.yMax-cfg.yMin))*plotH;
  ctx.clearRect(0,0,w,h);

  // Candlestick rendering (drawn before grid lines so grid sits on top)
  if (cfg.candles && cfg.candles.length) {
    const bw = Math.max(1, (plotW / cfg.candles.length) * 0.7);
    cfg.candles.forEach(({o, h: hi, l, c}, i) => {
      if (o == null || hi == null || l == null || c == null) return;
      const x = xAt(i);
      const bullish = c >= o;
      const color = bullish ? '#4dff88' : '#ff4d4d';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      // Wick
      ctx.beginPath();
      ctx.moveTo(x, yAt(hi));
      ctx.lineTo(x, yAt(l));
      ctx.stroke();
      // Body
      const y1 = yAt(Math.max(o, c));
      const y2 = yAt(Math.min(o, c));
      const bodyH = Math.max(1, y2 - y1);
      ctx.fillStyle = color;
      ctx.fillRect(x - bw / 2, y1, bw, bodyH);
    });
  }

  ctx.font='11px system-ui,Arial'; ctx.textBaseline='middle';
  ctx.strokeStyle='#2a313c'; ctx.fillStyle='#8a93a2'; ctx.lineWidth=1;
  const ticks=cfg.yticks||4;
  for(let t=0;t<=ticks;t++){ const v=cfg.yMin+(cfg.yMax-cfg.yMin)*t/ticks; const y=yAt(v);
    ctx.globalAlpha=.5; ctx.beginPath(); ctx.moveTo(PL,y); ctx.lineTo(w-PR,y); ctx.stroke(); ctx.globalAlpha=1;
    ctx.textAlign='right'; ctx.fillText(cfg.yfmt?cfg.yfmt(v):v.toFixed(0), PL-6, y); }
  for(const hl of (cfg.hlines||[])){ const y=yAt(hl.y); ctx.strokeStyle=hl.color||'#555'; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(PL,y); ctx.lineTo(w-PR,y); ctx.stroke(); ctx.setLineDash([]); }
  ctx.fillStyle='#8a93a2'; ctx.textAlign='center';
  const LBL_PX=56;
  const maxLabels=Math.max(2,Math.floor(plotW/LBL_PX));
  const step=Math.max(1,Math.ceil(n/maxLabels));
  for(let i=0;i<n;i+=step){ ctx.fillText((cfg.x[i]||'').slice(2), xAt(i), h-PB+11); }
  for(const s of cfg.series){ if(!s.data) continue; ctx.strokeStyle=s.color; ctx.lineWidth=s.width||1.6;
    ctx.setLineDash(s.dash||[]); ctx.beginPath(); let pen=false;
    for(let i=0;i<n;i++){ const v=s.data[i]; if(!isNum(v)){ pen=false; continue; }
      const X=xAt(i), Y=yAt(v); if(!pen){ctx.moveTo(X,Y);pen=true;} else ctx.lineTo(X,Y); }
    ctx.stroke(); ctx.setLineDash([]); }
  if(hoverIdx!=null && hoverIdx>=0 && hoverIdx<n){ const X=xAt(hoverIdx);
    ctx.strokeStyle='#5a6573'; ctx.setLineDash([3,3]); ctx.beginPath(); ctx.moveTo(X,PT); ctx.lineTo(X,h-PB); ctx.stroke(); ctx.setLineDash([]);
    for(const s of cfg.series){ const v=s.data&&s.data[hoverIdx]; if(isNum(v)){ ctx.fillStyle=s.color; ctx.beginPath(); ctx.arc(X,yAt(v),3,0,7); ctx.fill(); } } }
  cfg._geom={PL,PR,plotW,n};
  return cfg;
}

let charts={};
function draw(){
  const S=curSeries(); if(!S) return;

  // fillSteps — carry an indicator across the full visible history. Many series
  // (Fib levels, 200 MA, recommenders, RSI) have a leading NaN warmup region the
  // backend can't fill (200-bar MA needs 200 prior bars, the model needs warmup,
  // etc.), so they otherwise start partway across the chart. This back-fills leading
  // NaNs with the first valid value and forward-fills internal gaps, so the line
  // (and its steps) spans the whole chart instead of just the tail.
  const fillSteps = a => {
    if (!a) return a; const out = a.slice(); let first = null;
    for (const v of out) if (isNum(v)) { first = v; break; }
    if (first === null) return out;            // no data at all → leave untouched
    let last = first;
    for (let i = 0; i < out.length; i++) { if (isNum(out[i])) last = out[i]; else out[i] = last; }
    return out;
  };

  // --- Price chart ---
  const useCandle = chartType === 'candle' && Array.isArray(S.open) && S.open.length > 0;

  // Build overlay series (MA + Fib) respecting checkbox state.
  // hasData: an array can exist (right length) but be 100% null — a 200 MA
  // needs >=200 bars, so a young ticker (e.g. a fund with <200 days of price
  // history) has an all-null ma200/fib_* column. `S.ma200` alone is truthy
  // (it's a non-empty array either way), so without this the legend used to
  // claim "200 MA"/"Fib" were plotted when nothing actually drew.
  const hasData = a => Array.isArray(a) && a.some(isNum);
  const overlaySeries = [];
  const legendItems = [];
  if (show50 && hasData(S.ma50)) { overlaySeries.push({data:fillSteps(S.ma50),color:COL.ma50,width:1.4}); legendItems.push([COL.ma50,'50 MA']); }
  if (show200 && hasData(S.ma200)) { overlaySeries.push({data:fillSteps(S.ma200),color:COL.ma200,width:1.4}); legendItems.push([COL.ma200,'200 MA']); }
  if (showFib) {
    let _fibLeg = false;
    if (hasData(S.fib_236)) { overlaySeries.push({data:fillSteps(S.fib_236),color:COL.fib[0],width:1,dash:[5,4]}); if(!_fibLeg){ legendItems.push([COL.fib[0],'Fib',1]); _fibLeg=true; } }
    if (hasData(S.fib_382)) { overlaySeries.push({data:fillSteps(S.fib_382),color:COL.fib[1],width:1,dash:[5,4]}); if(!_fibLeg){ legendItems.push([COL.fib[1],'Fib',1]); _fibLeg=true; } }
    if (hasData(S.fib_618)) { overlaySeries.push({data:fillSteps(S.fib_618),color:COL.fib[2],width:1,dash:[5,4]}); if(!_fibLeg){ legendItems.push([COL.fib[2],'Fib',1]); _fibLeg=true; } }
    if (hasData(S.fib_764)) { overlaySeries.push({data:fillSteps(S.fib_764),color:COL.fib[3],width:1,dash:[5,4]}); if(!_fibLeg){ legendItems.push([COL.fib[3],'Fib',1]); _fibLeg=true; } }
  }

  if (useCandle) {
    // Y-bounds from high/low + overlays
    const overlayVals = overlaySeries.flatMap(s => s.data || []);
    const [yMin, yMax] = niceBounds([].concat(S.high||[], S.low||[], overlayVals));
    const candles = (S.open).map((o,i) => ({o, h:S.high[i], l:S.low[i], c:S.close[i]}));
    charts.price = plot({
      canvas: $('#c-price'), x: S.date, yMin, yMax,
      yticks: 5, yfmt: v => fSig(v),
      candles,
      series: overlaySeries,
    });
    legend($('#lg-price'), [['#4dff88','Kerzen (Kauf)'],['#ff4d4d','Kerzen (Verk.)'], ...legendItems]);
  } else {
    // Line mode
    const overlayVals = overlaySeries.flatMap(s => s.data || []);
    const [yMin, yMax] = niceBounds([].concat(S.close||[], overlayVals));
    charts.price = plot({
      canvas: $('#c-price'), x: S.date, yMin, yMax,
      yticks: 5, yfmt: v => fSig(v),
      series: [{data:S.close,color:COL.close,width:2}, ...overlaySeries],
    });
    legend($('#lg-price'), [[COL.close,'Close'], ...legendItems]);
  }

  // ML is a 5-band signal ({-2..+2}); scale /2 so it shares the -1..1
  // axis with Rule and DP-Oracle (tooltip still shows the raw band value).
  const scaleHalf = a => a ? a.map(v => isNum(v) ? v / 2 : v) : a;

  // DP (Oracle): solid over the settled region (rec_dp_cut, which skips fillSteps
  // so its trailing NaN cut stays a gap), then a DASHED continuation over the
  // unsettled tail using the raw look-ahead rec_optimal. The solid→dashed handoff
  // marks the dp_settled_boundary (the "cut"): the oracle stays visible near the
  // live edge but is clearly flagged as not-yet-settled / not handelbar.
  const dpSolid = S.rec_dp_cut;
  let dpDashed = null;
  if (dpSolid && S.rec_optimal) {
    let lastSettled = -1;
    for (let i = dpSolid.length - 1; i >= 0; i--) { if (isNum(dpSolid[i])) { lastSettled = i; break; } }
    // Draw a dashed tail whenever the cut blanks bars before the last one.
    // lastSettled === -1 means the whole visible window is unsettled (e.g. a calm
    // name whose settled boundary is off-screen to the left) → dash the entire
    // look-ahead line. Otherwise dash only the trailing tail, starting at the last
    // settled bar so it joins the solid segment. A ticker with no cut at all
    // (lastSettled === len-1) gets no tail.
    if (lastSettled < S.rec_optimal.length - 1) {
      dpDashed = new Array(S.rec_optimal.length).fill(null);
      for (let i = Math.max(0, lastSettled); i < S.rec_optimal.length; i++) dpDashed[i] = S.rec_optimal[i];
    }
  }

  const recSeries = [];
  const recLegend = [];
  if (showRule) { recSeries.push({data:fillSteps(S.rec_filtered),color:COL.recF,width:1.6}); recLegend.push([COL.recF,'Rule']); }
  if (showDp) {
    recSeries.push({data:dpSolid,color:COL.recO,width:1.4});
    if (dpDashed) recSeries.push({data:dpDashed,color:COL.recO,width:1.4,dash:[4,3]});
    recLegend.push([COL.recO,'DP (Oracle) ∗']);
  }
  if (showMlLive) { recSeries.push({data:scaleHalf(fillSteps(S.rec_ml_live)),color:COL.recM,width:1.8}); recLegend.push([COL.recM,'ML']); }

  charts.rec = plot({ canvas:$('#c-rec'), x:S.date, yMin:-1.15, yMax:1.15, yticks:2,
    yfmt:v=>v.toFixed(0), hlines:[{y:0,color:'#3a424e'}],
    series: recSeries });
  legend($('#lg-rec'), recLegend);

  charts.rsi = plot({ canvas:$('#c-rsi'), x:S.date, yMin:0, yMax:100, yticks:2,
    yfmt:v=>v.toFixed(0), hlines:[{y:70,color:'#ff5c5c'},{y:30,color:'#2ecc71'}],
    series:[{data:fillSteps(S.rsi),color:COL.rsi,width:1.6}] });
}

// ---------- shared hover (mouse + touch) ----------
let _drawPending = false;
function onMove(e){
  const S=curSeries(); if(!S) return; const n=(S.date||[]).length; if(!n) return;
  const cv=e.currentTarget, rect=cv.getBoundingClientRect(); const g=charts.price&&charts.price._geom;
  const PL=g?g.PL:54, PR=g?g.PR:12; const plotW=rect.width-PL-PR;
  // Support both mouse and touch events.
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  let idx=Math.round((clientX-rect.left-PL)/plotW*(n-1));
  idx=Math.max(0,Math.min(n-1,idx));
  const idxChanged = idx !== hoverIdx;
  hoverIdx = idx;
  // draw() redraws all 3 canvases from scratch — only worth doing when the
  // crosshair actually moved to a different bar, and coalesced to at most one
  // redraw per animation frame even if move events fire faster than that.
  if(idxChanged && !_drawPending){
    _drawPending = true;
    requestAnimationFrame(() => { _drawPending = false; draw(); });
  }
  showTip(e,S,idx);  // cheap DOM update — keeps following the cursor every move
}
function showTip(e,S,i){
  const tip=$('#tip');
  const useCandle = chartType === 'candle' && Array.isArray(S.open) && S.open.length > 0;
  let rows;
  if (useCandle) {
    const c = S.close&&S.close[i]; const o = S.open&&S.open[i];
    const bullish = (c != null && o != null) ? c >= o : true;
    const candleColor = bullish ? '#4dff88' : '#ff4d4d';
    rows = [
      ['O', candleColor, fSig(o)],
      ['H', candleColor, fSig(S.high&&S.high[i])],
      ['L', candleColor, fSig(S.low&&S.low[i])],
      ['C', candleColor, fSig(c)],
      ['50 MA',COL.ma50,fSig(S.ma50&&S.ma50[i])],
      ['200 MA',COL.ma200,fSig(S.ma200&&S.ma200[i])],
      ['RSI',COL.rsi,fNum(S.rsi&&S.rsi[i],1)],
    ].filter(r=>r[2]!=='—').map(([k,c,v])=>`<div><span class="k" style="background:${c}"></span>${k}: <b>${v}</b></div>`).join('');
  } else {
    rows = [
      ['Close',COL.close,fSig(S.close&&S.close[i])],
      ['50 MA',COL.ma50,fSig(S.ma50&&S.ma50[i])],
      ['200 MA',COL.ma200,fSig(S.ma200&&S.ma200[i])],
      ['RSI',COL.rsi,fNum(S.rsi&&S.rsi[i],1)],
      // Tooltip rows mirror the rec-subplot checkboxes: a hidden line shouldn't
      // still report a value in the hover panel.
      ['Rule',COL.recF, showRule ? fNum(S.rec_filtered&&S.rec_filtered[i],0) : '—'],
      ['ML',COL.recM, showMlLive ? fNum(S.rec_ml_live&&S.rec_ml_live[i],0) : '—'],
      // Settled bars show the cut value; unsettled tail shows the look-ahead
      // rec_optimal with a ~ prefix (matches the dashed continuation on the chart).
      ['DP (Oracle)',COL.recO, showDp ? ((S.rec_dp_cut && isNum(S.rec_dp_cut[i]))
        ? fNum(S.rec_dp_cut[i],0)
        : (S.rec_optimal && isNum(S.rec_optimal[i]) ? '~'+fNum(S.rec_optimal[i],0) : '—')) : '—'],
    ].filter(r=>r[2]!=='—').map(([k,c,v])=>`<div><span class="k" style="background:${c}"></span>${k}: <b>${v}</b></div>`).join('');
  }
  tip.innerHTML=`<div class="d">${esc((S.date&&S.date[i])||'')}</div>${rows}`;
  tip.style.display='block';
  const pad=14;
  // Support both mouse and touch events for tooltip positioning.
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  let x=clientX+pad, y=clientY+pad;
  if(x+tip.offsetWidth>innerWidth) x=clientX-tip.offsetWidth-pad;
  if(y+tip.offsetHeight>innerHeight) y=clientY-tip.offsetHeight-pad;
  tip.style.left=x+'px'; tip.style.top=y+'px';
}
function onLeave(){ hoverIdx=null; $('#tip').style.display='none'; draw(); }

// ---------- init ----------
let _filterTimer = null;
export function initViewer(){
  window.addEventListener('pwa:scan-done', retryAllocationIfMissing);

  $('#filter').oninput=()=>{
    clearTimeout(_filterTimer);
    _filterTimer = setTimeout(() => { if(DATA) renderOverview(); }, 150);
  };

  // Currency selector — re-render table and perf graph without refetch
  const currSel = $('#currency-sel');
  if(currSel){
    currSel.value = getCurrency();
    currSel.addEventListener('change', () => {
      setCurrency(currSel.value);
      // Rebuild COLS so Value column header and formatter picks up new currency
      if(DATA) COLS = buildCols();
      renderOverview();
      // Redraw perf graph using cached data
      const list = DATA && DATA.portfolio;
      if(list && perfCache.has(list)) drawPerf(perfCache.get(list));
    });
  }

  ['c-price','c-rec','c-rsi'].forEach(id=>{ const cv=$('#'+id); if(!cv) return;
    cv.addEventListener('mousemove', onMove);
    cv.addEventListener('mouseleave', onLeave);
    // Passive touch hover — `touch-action:pan-y` (CSS) lets vertical page
    // scrolling pass through; we only read the finger X for the crosshair, so
    // we never preventDefault (which would trap the canvas-heavy page's scroll).
    cv.addEventListener('touchstart', onMove, {passive:true});
    cv.addEventListener('touchmove',  onMove, {passive:true});
    cv.addEventListener('touchend',   onLeave);
  });

  // Load persisted chart prefs and sync checkbox DOM
  loadChartPrefs();
  const ma50El = document.getElementById('chk-ma50');
  const ma200El = document.getElementById('chk-ma200');
  const fibEl = document.getElementById('chk-fib');
  if (ma50El) ma50El.checked = show50;
  if (ma200El) ma200El.checked = show200;
  if (fibEl) fibEl.checked = showFib;
  const ruleEl = document.getElementById('chk-rule');
  const dpEl = document.getElementById('chk-dp');
  const mlLiveEl = document.getElementById('chk-mllive');
  if (ruleEl) ruleEl.checked = showRule;
  if (dpEl) dpEl.checked = showDp;
  if (mlLiveEl) mlLiveEl.checked = showMlLive;

  // Wire chart-type buttons
  document.getElementById('btn-line')?.addEventListener('click', () => {
    chartType = 'line';
    document.getElementById('btn-line').classList.add('active');
    document.getElementById('btn-candle').classList.remove('active');
    saveChartPrefs();
    draw();
  });
  document.getElementById('btn-candle')?.addEventListener('click', () => {
    if (document.getElementById('btn-candle').disabled) return;
    chartType = 'candle';
    document.getElementById('btn-candle').classList.add('active');
    document.getElementById('btn-line').classList.remove('active');
    saveChartPrefs();
    draw();
  });

  // Wire overlay checkboxes
  ['chk-ma50', 'chk-ma200', 'chk-fib'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', e => {
      if (id === 'chk-ma50') show50 = e.target.checked;
      if (id === 'chk-ma200') show200 = e.target.checked;
      if (id === 'chk-fib') showFib = e.target.checked;
      saveChartPrefs();
      draw();
    });
  });

  // Wire recommendation-subplot checkboxes
  ['chk-rule', 'chk-dp', 'chk-mllive'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', e => {
      if (id === 'chk-rule') showRule = e.target.checked;
      if (id === 'chk-dp') showDp = e.target.checked;
      if (id === 'chk-mllive') showMlLive = e.target.checked;
      saveChartPrefs();
      draw();
    });
  });

  // Initialize from the current DOM: the restored tab may already be Charts,
  // whose pwa:tab event fired during initTabs() before this listener existed.
  chartsVisible = document.getElementById('page-charts')?.classList.contains('active') || false;
  // Track Charts tab visibility — hidden page has clientWidth==0.
  window.addEventListener('pwa:tab', e=>{
    // A chart hover tooltip has no natural "leave" event when the user taps a
    // bottom-nav tab instead of moving the pointer off the canvas — onLeave()
    // never fires, so #tip stays visible, floating over whatever tab opens next.
    const tip = $('#tip'); if (tip) tip.style.display = 'none';
    hoverIdx = null;
    chartsVisible = e.detail === 'charts';
    if(chartsVisible && selected){ lastW=0; draw(); }
    // Redraw perf graph when overview tab becomes visible (was hidden → zero clientWidth)
    if(e.detail === 'overview'){
      const list = DATA && DATA.portfolio;
      if(list && perfCache.has(list)) drawPerf(perfCache.get(list));
    }
  });

  window.addEventListener('pwa:table-variant', ()=>{ if(DATA) renderOverview(); });
  window.matchMedia('(orientation: portrait)').addEventListener('change',()=>{ if(DATA) renderOverview(); });
  const presetSel=$('#table-preset-sel');
  if(presetSel) presetSel.addEventListener('change',()=>{ setPreset(presetSel.value); if(DATA) renderOverview(); });

  // Tap #meta to reveal/hide the scan timestamp detail line
  const metaEl = $('#meta'), statusEl = $('#status-line');
  if(metaEl && statusEl){
    metaEl.style.cursor = 'pointer';
    metaEl.title = 'Scan-Zeiten einblenden';
    metaEl.addEventListener('click', ()=>{
      const shown = statusEl.style.display !== 'none';
      statusEl.style.display = shown ? 'none' : '';
    });
  }

  // Width-guarded resize: only redraw on actual width changes (not URL-bar jitter).
  let rz;
  addEventListener('resize', ()=>{
    clearTimeout(rz);
    rz = setTimeout(()=>{
      // Redraw perf graph on resize (overview tab may be visible)
      const list = DATA && DATA.portfolio;
      if(list && perfCache.has(list)){
        const perfWrap = $('#perf-wrap');
        if(perfWrap && perfWrap.style.display !== 'none') drawPerf(perfCache.get(list));
      }
      if(!chartsVisible || !selected) return;
      const w = ($('#c-price')||{}).clientWidth || 0;
      if(w !== lastW){ lastW=w; draw(); }
    }, 120);
  });
}
