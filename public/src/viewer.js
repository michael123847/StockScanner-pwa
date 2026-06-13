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

/**
 * Convert a CHF value to the display currency using the report's FX snapshot.
 * fx = report.fx object { USDCHF, EURCHF, GBPCHF, BTCUSD }.
 * Returns a formatted string or '—' when conversion is not possible.
 */
function convertCHF(valueCHF, currency, fx){
  if(valueCHF == null || !isNum(valueCHF)) return '—';
  if(!fx) return currency === 'CHF' ? fNum(valueCHF, 2) + ' CHF' : '—';
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
  if(currency === 'BTC') return result.toFixed(6) + ' BTC';
  return fNum(result, 2) + ' ' + currency;
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

const CHART_PREFS_KEY = 'pwa.stocks.chartPrefs';

function loadChartPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(CHART_PREFS_KEY) || '{}');
    if (p.type === 'candle' || p.type === 'line') chartType = p.type;
    if (typeof p.ma50 === 'boolean') show50 = p.ma50;
    if (typeof p.ma200 === 'boolean') show200 = p.ma200;
    if (typeof p.fib === 'boolean') showFib = p.fib;
  } catch {}
}

function saveChartPrefs() {
  try { localStorage.setItem(CHART_PREFS_KEY, JSON.stringify({ type: chartType, ma50: show50, ma200: show200, fib: showFib })); } catch {}
}

// ---------- formatting ----------
const isNum = v => typeof v==='number' && isFinite(v);
const fNum=(v,d=2)=> isNum(v)? v.toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d}) : '—';
const fPct=v=> isNum(v)? (v*100).toFixed(1)+'%' : '—';
const fInt=v=> isNum(v)? Math.round(v).toString() : '—';
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
    {key:'rule', label:'Rule',     axis:'reference', badge:'validated'},
    {key:'ml',   label:'ML',       axis:'reference', badge:'experimental'},
    {key:'dp',   label:'Hindsight',axis:'reference'},
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
  else if(col && col.paper)               mark = `<sup title="paper only">&#x1D4AB;</sup>`;

  return `<span class="glyph ax-${axis} ${colorCls}"${styleAttr}>${esc(sig)}${mark}</span>`;
}

// ---------- dynamic COLS helpers ----------
// Returns the full column list for a given report (DATA must be set first).
// Panel columns are injected after Δ1D; Consensus column follows panel columns.
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
  const consensusCol = [
    'Cons.',
    r => r.consensus || null,
    (v) => {
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
    },
    'b',
  ];
  const staticAfter = [
    ['Price',    r=>r.s['Current_Price'],     v=>fNum(v,2),            'n'],
    ['RSI',      r=>r.s['RSI'],               v=>rsiCell(v),           'n'],
    ['200DMA',   r=>r.s['200DMA'],            v=>fNum(v,2),            'n'],
    ['↕200',     r=>r.s['above_200DMA'],      v=>fInt(v),              'n'],
    ['50DMA',    r=>r.s['50DMA'],             v=>fNum(v,2),            'n'],
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

  return [...staticBefore, ...dynamicPanel, consensusCol, ...(valueCol ? [valueCol] : []), ...staticAfter];
}

// COLS is rebuilt each time a report loads; initialised with static fallback.
let COLS = [
  ['Ticker',   r=>r.ticker,                (v,r)=>tickerCell(r),    'l'],
  ['Name',     r=>r.name,                  v=>esc(v),               'l'],
  ['Δ1D',     r=>{ if(typeof r.s['change_1d']==='number') return r.s['change_1d']; const c=r.series&&r.series.close; return(c&&c.length>=2)?c[c.length-1]/c[c.length-2]-1:null; }, v=>pctCell(v), 'n'],
  ['Price',    r=>r.s['Current_Price'],     v=>fNum(v,2),            'n'],
  ['RSI',      r=>r.s['RSI'],               v=>rsiCell(v),           'n'],
  ['200DMA',   r=>r.s['200DMA'],            v=>fNum(v,2),            'n'],
  ['↕200',     r=>r.s['above_200DMA'],      v=>fInt(v),              'n'],
  ['50DMA',    r=>r.s['50DMA'],             v=>fNum(v,2),            'n'],
  ['Δ21D',     r=>r.s['Change_21D'],        v=>pctCell(v),           'n'],
  ['Mom14',    r=>r.s['Momentum'],          v=>pctCell(v),           'n'],
];

const esc = s => (s==null?'':String(s)).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function badge(v){ return v? `<span class="badge ${esc(v)}">${esc(v)}</span>` : '—'; }
function pctCell(v){ if(!isNum(v)) return '—'; const c=v<0?'neg':'pos'; return `<span class="num ${c}">${fPct(v)}</span>`; }
function rsiCell(v){ if(!isNum(v)) return '—'; const c = v>=70?'neg':(v<=30?'pos':''); return `<span class="num ${c}">${v.toFixed(1)}</span>`; }
function tickerCell(r){ return r.tag? `<a href="${esc(r.tag)}" target="_blank" rel="noopener">${esc(r.ticker)}</a>` : esc(r.ticker); }

// ---------- error surface ----------
export function setViewerError(msg){
  const el = $('#view-error');
  if(!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
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
    const asof = rg.asof ? ` (${esc(rg.asof)})` : '';
    regimeBadge = `<span class="glyph regime-badge ${cls}" title="${esc(why)}">${esc(rg.state)}${asof}</span> &nbsp;`;
  }

  $('#meta').innerHTML = `${regimeBadge}<b>${esc(json.portfolio||'?')}</b> &nbsp;·&nbsp; ${ROWS.length} tickers &nbsp;·&nbsp; generated ${esc(json.generated||'')}`;
  $('#tbl').style.display='';
  renderHead(); renderBody();
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
  const r = await fetch(url, { headers: authHeaders(), cache:'no-store', credentials:'omit' });
  if(r.status === 401){ clearToken(); throw new Error('unauthorized'); }
  if(!r.ok){ invalidateLocal(); throw new Error('HTTP_'+r.status); }
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
    yfmt = mag >= 1e6 ? v => (v/1e6).toFixed(2)+'M' : v => v.toFixed(0);
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
  const list = await apiJson(indexUrl());
  populateReports(list, list && list[0] && list[0].file);
  if(list && list.length){
    const data = await apiJson(reportUrl(list[0].file));
    load(data);
  } else {
    $('#tbl').style.display='none';
    setViewerError('Noch keine Reports vorhanden — der erste Scan läuft um Mitternacht.');
  }
}

function populateReports(list, current){
  const sel=$('#report'); if(!sel) return;
  if(!list||!list.length){ sel.style.display='none'; return; }
  // Group reports by list name (optgroup); newest-first order preserved within each.
  const groups=new Map();
  for(const e of list){ const k=e.portfolio||e.file; if(!groups.has(k)) groups.set(k,[]); groups.get(k).push(e); }
  sel.innerHTML=[...groups].map(([name,items])=>
    `<optgroup label="${esc(name)}">`+items.map(e=>`<option value="${esc(e.file)}">${esc((e.generated||'').slice(0,10))}${e.count?` · ${e.count}`:''}</option>`).join('')+`</optgroup>`
  ).join('');
  sel.value = current || list[0].file; sel.style.display='';
  sel.onchange=()=>apiJson(reportUrl(sel.value)).then(load).catch(err=>setViewerError('Report konnte nicht geladen werden: '+err.message));
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
function renderHead(){
  const tr=document.createElement('tr');
  COLS.forEach((c)=>{
    const th=document.createElement('th');
    const key = c[0];
    th.textContent = key + (sortKey===key? (sortDir>0?' ▲':' ▼'):'');
    th.onclick=()=>{ if(sortKey===key) sortDir=-sortDir; else {sortKey=key; sortDir=1;} renderBody(); renderHead(); };
    tr.appendChild(th);
  });
  const th=$('#tbl thead'); th.innerHTML=''; th.appendChild(tr);
}
function sortVal(r,key){
  const col=COLS.find(c=>c[0]===key); if(!col) return null;
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
function renderBody(){
  const q=$('#filter').value.trim().toLowerCase();
  let rows=ROWS.filter(r=> !q || (r.name+' '+r.ticker).toLowerCase().includes(q));
  rows.sort((a,b)=>{ let x=sortVal(a,sortKey), y=sortVal(b,sortKey);
    if(x==null) return 1; if(y==null) return -1;
    if(typeof x==='string'||typeof y==='string'){ x=String(x); y=String(y); return x<y?-sortDir:x>y?sortDir:0; }
    return (x-y)*sortDir; });
  const tb=$('#tbl tbody'); tb.innerHTML='';
  for(const r of rows){
    const tr=document.createElement('tr'); tr.dataset.ticker=r.ticker;
    if(r.ticker===selected) tr.className='sel';
    COLS.forEach(c=>{ const td=document.createElement('td'); const val=c[1](r);
      td.innerHTML = c[2](val,r); if(c[3]==='l') td.style.textAlign='left'; tr.appendChild(td); });
    tr.onclick=()=>{
      select(r.ticker);
      // Navigate to Charts tab so the user sees the chart immediately.
      window.dispatchEvent(new CustomEvent('pwa:navigate', { detail: 'charts' }));
    };
    tb.appendChild(tr);
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
    if (CONFIG && CONFIG.APP_VERSION) console.warn('ensureSeries failed:', err.message);
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
  const S=r.series||{}; const out={}; for(const k in S) out[k]=sliceArr(S[k]); return out;
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
  const step=Math.max(1,Math.floor(n/6));
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

  // --- Price chart ---
  const useCandle = chartType === 'candle' && Array.isArray(S.open) && S.open.length > 0;

  // Build overlay series (MA + Fib) respecting checkbox state
  const overlaySeries = [];
  const legendItems = [];
  if (show50 && S.ma50) { overlaySeries.push({data:S.ma50,color:COL.ma50,width:1.4}); legendItems.push([COL.ma50,'50 MA']); }
  if (show200 && S.ma200) { overlaySeries.push({data:S.ma200,color:COL.ma200,width:1.4}); legendItems.push([COL.ma200,'200 MA']); }
  if (showFib) {
    if (S.fib_236) { overlaySeries.push({data:S.fib_236,color:COL.fib[0],width:1,dash:[5,4]}); legendItems.push([COL.fib[0],'Fib 23.6%',1]); }
    if (S.fib_382) { overlaySeries.push({data:S.fib_382,color:COL.fib[1],width:1,dash:[5,4]}); legendItems.push([COL.fib[1],'38.2%',1]); }
    if (S.fib_618) { overlaySeries.push({data:S.fib_618,color:COL.fib[2],width:1,dash:[5,4]}); legendItems.push([COL.fib[2],'61.8%',1]); }
    if (S.fib_764) { overlaySeries.push({data:S.fib_764,color:COL.fib[3],width:1,dash:[5,4]}); legendItems.push([COL.fib[3],'76.4%',1]); }
  }

  if (useCandle) {
    // Y-bounds from high/low + overlays
    const overlayVals = overlaySeries.flatMap(s => s.data || []);
    const [yMin, yMax] = niceBounds([].concat(S.high||[], S.low||[], overlayVals));
    const candles = (S.open).map((o,i) => ({o, h:S.high[i], l:S.low[i], c:S.close[i]}));
    charts.price = plot({
      canvas: $('#c-price'), x: S.date, yMin, yMax,
      yticks: 5, yfmt: v => v.toFixed(v>=1000?0:2),
      candles,
      series: overlaySeries,
    });
    legend($('#lg-price'), [['#4dff88','Kerzen (Kauf)'],['#ff4d4d','Kerzen (Verk.)'], ...legendItems]);
  } else {
    // Line mode
    const [yMin, yMax] = niceBounds([].concat(S.close||[], S.ma200||[], S.fib_764||[], S.fib_236||[]));
    charts.price = plot({
      canvas: $('#c-price'), x: S.date, yMin, yMax,
      yticks: 5, yfmt: v => v.toFixed(v>=1000?0:2),
      series: [{data:S.close,color:COL.close,width:2}, ...overlaySeries],
    });
    legend($('#lg-price'), [[COL.close,'Close'], ...legendItems]);
  }

  charts.rec = plot({ canvas:$('#c-rec'), x:S.date, yMin:-1.15, yMax:1.15, yticks:2,
    yfmt:v=>v.toFixed(0), hlines:[{y:0,color:'#3a424e'}],
    series:[
      {data:S.rec_filtered,color:COL.recF,width:1.6},
      {data:S.rec_optimal,color:COL.recO,width:1.4},
      {data:S.rec_ml,color:COL.recM,width:1.8},
    ]});
  legend($('#lg-rec'),[[COL.recF,'Rule (filtered)'],[COL.recO,'Optimal (hindsight)'],[COL.recM,'ML']]);

  charts.rsi = plot({ canvas:$('#c-rsi'), x:S.date, yMin:0, yMax:100, yticks:2,
    yfmt:v=>v.toFixed(0), hlines:[{y:70,color:'#ff5c5c'},{y:30,color:'#2ecc71'}],
    series:[{data:S.rsi,color:COL.rsi,width:1.6}] });
}

// ---------- shared hover (mouse + touch) ----------
function onMove(e){
  const S=curSeries(); if(!S) return; const n=(S.date||[]).length; if(!n) return;
  const cv=e.currentTarget, rect=cv.getBoundingClientRect(); const g=charts.price&&charts.price._geom;
  const PL=g?g.PL:54, PR=g?g.PR:12; const plotW=rect.width-PL-PR;
  // Support both mouse and touch events.
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  let idx=Math.round((clientX-rect.left-PL)/plotW*(n-1));
  idx=Math.max(0,Math.min(n-1,idx)); hoverIdx=idx; draw(); showTip(e,S,idx);
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
      ['O', candleColor, fNum(o, 2)],
      ['H', candleColor, fNum(S.high&&S.high[i], 2)],
      ['L', candleColor, fNum(S.low&&S.low[i], 2)],
      ['C', candleColor, fNum(c, 2)],
      ['50 MA',COL.ma50,fNum(S.ma50&&S.ma50[i],2)],
      ['200 MA',COL.ma200,fNum(S.ma200&&S.ma200[i],2)],
      ['RSI',COL.rsi,fNum(S.rsi&&S.rsi[i],1)],
    ].filter(r=>r[2]!=='—').map(([k,c,v])=>`<div><span class="k" style="background:${c}"></span>${k}: <b>${v}</b></div>`).join('');
  } else {
    rows = [
      ['Close',COL.close,fNum(S.close&&S.close[i],2)],
      ['50 MA',COL.ma50,fNum(S.ma50&&S.ma50[i],2)],
      ['200 MA',COL.ma200,fNum(S.ma200&&S.ma200[i],2)],
      ['RSI',COL.rsi,fNum(S.rsi&&S.rsi[i],1)],
      ['ML',COL.recM,fNum(S.rec_ml&&S.rec_ml[i],0)],
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
export function initViewer(){
  $('#filter').oninput=renderBody;

  // Currency selector — re-render table and perf graph without refetch
  const currSel = $('#currency-sel');
  if(currSel){
    currSel.value = getCurrency();
    currSel.addEventListener('change', () => {
      setCurrency(currSel.value);
      // Rebuild COLS so Value column header and formatter picks up new currency
      if(DATA) COLS = buildCols();
      renderHead();
      renderBody();
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

  // Initialize from the current DOM: the restored tab may already be Charts,
  // whose pwa:tab event fired during initTabs() before this listener existed.
  chartsVisible = document.getElementById('page-charts')?.classList.contains('active') || false;
  // Track Charts tab visibility — hidden page has clientWidth==0.
  window.addEventListener('pwa:tab', e=>{
    chartsVisible = e.detail === 'charts';
    if(chartsVisible && selected){ lastW=0; draw(); }
    // Redraw perf graph when overview tab becomes visible (was hidden → zero clientWidth)
    if(e.detail === 'overview'){
      const list = DATA && DATA.portfolio;
      if(list && perfCache.has(list)) drawPerf(perfCache.get(list));
    }
  });

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
