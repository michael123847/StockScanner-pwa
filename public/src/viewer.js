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
const recRank={Buy:3,Hold:2,Sell:1};

// summary-table columns: [label, key-getter, formatter, css-align]
const COLS = [
  ['Ticker',   r=>r.ticker,                (v,r)=>tickerCell(r),    'l'],
  ['Name',     r=>r.name,                  v=>esc(v),               'l'],
  ['Rule',     r=>r.s['Recommendation_3_1'], v=>badge(v),           'b'],
  ['ML',       r=>r.s['Recommendation_ML'],  v=>badge(v),           'b'],
  ['Hindsight',r=>r.s['Optimal_hindsight'],  v=>badge(v),           'b'],
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
  DATA=json;
  ROWS = (json.tickers||[]).map(t=>({ ...t, s:t.summary||{} }));
  $('#meta').innerHTML = `<b>${esc(json.portfolio||'?')}</b> &nbsp;·&nbsp; ${ROWS.length} tickers &nbsp;·&nbsp; generated ${esc(json.generated||'')}`;
  $('#tbl').style.display='';
  renderHead(); renderBody();
  populateChartTicker();
  if(ROWS.length) select(ROWS[0].ticker);
}

// ---------- server data ----------
const indexUrl  = () => getActiveBase() + CONFIG.STOCKS_INDEX_PATH;
const reportUrl = (file) => getActiveBase() + CONFIG.STOCKS_REPORT_PATH + '?file=' + encodeURIComponent(file);

async function apiJson(url){
  const r = await fetch(url, { headers: authHeaders(), cache:'no-store', credentials:'omit' });
  if(r.status === 401){ clearToken(); throw new Error('unauthorized'); }
  if(!r.ok){ invalidateLocal(); throw new Error('HTTP_'+r.status); }
  return r.json();
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
  sel.innerHTML = list.map(e=>`<option value="${esc(e.file)}">${esc(e.portfolio||e.file)} · ${esc((e.generated||'').slice(0,10))}${e.count?` · ${e.count}`:''}</option>`).join('');
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
  const col=COLS.find(c=>c[0]===key); let v=col?col[1](r):null;
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
  $('#d-sub').innerHTML = `${tickerCell(r)} &nbsp;·&nbsp; ${esc(r.exchange||'')} &nbsp;·&nbsp; `+
    `Rule ${badge(r.s['Recommendation_3_1'])} ML ${badge(r.s['Recommendation_ML'])} Hindsight ${badge(r.s['Optimal_hindsight'])}`;
  renderRanges();

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
}
function renderRanges(){
  const opts=[['Full',Infinity],['120d',120],['60d',60]];
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
  });

  // Width-guarded resize: only redraw on actual width changes (not URL-bar jitter).
  let rz;
  addEventListener('resize', ()=>{
    clearTimeout(rz);
    rz = setTimeout(()=>{
      if(!chartsVisible || !selected) return;
      const w = ($('#c-price')||{}).clientWidth || 0;
      if(w !== lastW){ lastW=w; draw(); }
    }, 120);
  });
}
