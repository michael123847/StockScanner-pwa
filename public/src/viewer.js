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

// Perf series cache: Map keyed by list label (or '__digest_combined__') → perf JSON
const perfCache = new Map();

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

// Which allocation scheme the user has marked as the one they're actually
// following in real life (independent of which scheme they're currently just
// browsing in the dropdown for comparison). Purely a local reminder/label --
// no backend concept of "active", nothing is traded automatically.
const ACTIVE_SCHEME_KEY = 'ss_active_scheme';
function getActiveScheme(){
  try { return localStorage.getItem(ACTIVE_SCHEME_KEY) || null; } catch { return null; }
}
function setActiveScheme(v){
  try { localStorage.setItem(ACTIVE_SCHEME_KEY, v); } catch {}
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
  holdings: ['Ticker','Value','Δ1D','Order', {panelKey:'ml_risk'}],
  chancen:  ['Ticker', {panelKey:'ml_risk'}, 'RSI','Δ21D'],
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

// Allokation-view domain constants (trade-recommendation thresholds), shared
// by computeSchemeTrades and computeAddCash below.
const DUST_PCT = 0.5;        // hide trades below 0.5% of total (rounding noise, not actionable)
const MIN_ORDER_CHF = 1000;  // no recommendation is worth transacting below this

/** Re-attempt the allocation fetch after a scan completes, if it previously
 *  failed (e.g. allocation.json didn't exist yet on first app open) —
 *  otherwise the Allokation sub-tab would stay empty until an app restart. */
function retryAllocationIfMissing(){
  if(!allocationData){
    allocationTried = false;
    ensureAllocation();
  }
}

// The <option value> keys in index.html's scheme dropdown are stable, but
// their hard-coded TEXT drifts whenever a producer's --*-fund weights change
// its label (same sickness the alloc-meta header above already guards
// against via schemeLabel). Rewrite each option's text from the same JSON
// once it resolves; the hard-coded text stays as the fallback for the
// not-yet-loaded state.
function updateSchemeDropdownLabels(a){
  const sel = $('#alloc-scheme-sel');
  if(!sel || !a) return;
  const schemes = a.schemes || {};
  const labelsByValue = {
    hybrid:    schemes.hybrid && (schemes.hybrid.short_label || schemes.hybrid.label),
    scheme5:   schemes.scheme5 && (schemes.scheme5.short_label || schemes.scheme5.label),
    techheavy: schemes.techheavy && (schemes.techheavy.short_label || schemes.techheavy.label),
    cashout:   schemes.cashout && (schemes.cashout.short_label || schemes.cashout.label),
  };
  for(const opt of sel.options){
    const label = labelsByValue[opt.value];
    if(label) opt.textContent = label;
  }
}

// Normalizes a legacy pre-`schemes`-wrapper payload (scheme5's fields at the
// payload root, hybrid/techheavy/cashout nested beside them -- the producer's
// shape before its 2026-07-16 reshape) into the current uniform
// {asof, currency, schemes:{scheme5, hybrid, techheavy, cashout}} shape, so a
// stale backend (old alloc_scheme5_live.py / allocation_scheme5.json) still
// renders. Everything downstream reads only the new shape.
function normalizeAllocationPayload(a){
  if(!a || a.schemes) return a;
  return {
    asof: a.asof,
    currency: a.currency,
    schemes: {
      scheme5: {
        label: a.label, short_label: a.short_label, research: a.research,
        metrics: a.scheme5_metrics, sleeves: a.sleeves,
        in_1x_twins_pct: a.in_1x_twins_pct, cash_money_market_pct: a.cash_money_market_pct,
        derisk_rule: a.derisk_rule, cash_destination: a.cash_destination, caveats: a.caveats,
      },
      hybrid: a.hybrid, techheavy: a.techheavy, cashout: a.cashout,
    },
  };
}

/** Fetch Output/allocation.json via the server; cache in a module var.
 *  Failure is silent (console.warn only) — renderAllocation() shows its own
 *  empty state. Re-renders immediately if the Allokation sub-tab is open. */
export async function ensureAllocation(){
  if(allocationTried) return allocationData;
  allocationTried = true;
  try{
    const url = getActiveBase() + CONFIG.STOCKS_ALLOCATION_PATH;
    allocationData = normalizeAllocationPayload(await apiJson(url));
    updateSchemeDropdownLabels(allocationData);
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

// ---------- scheme trade recommendation (Allokation sub-tab) ----------
// Independent of the currently-selected Übersicht list/report — always the
// "Portfolio" list's latest report, since that's what carries real holdings
// (per-ticker holding.value_chf). Fetched once, cached like allocation/metrics.
let portfolioHoldingsData = null;
let portfolioHoldingsTried = false;

async function ensurePortfolioHoldings(){
  if(portfolioHoldingsTried) return portfolioHoldingsData;
  portfolioHoldingsTried = true;
  try{
    const idx = await apiJson(indexUrl());
    const entry = (idx||[]).find(e => (e.portfolio||e.file) === 'Portfolio');
    portfolioHoldingsData = entry ? await apiJson(reportUrl(entry.file)) : null;
  }catch(err){
    portfolioHoldingsData = null;
    console.warn('portfolio holdings fetch failed:', err.message);
  }
  const panel = $('#alloc-panel');
  if(panel && panel.style.display !== 'none') renderAllocation();
  return portfolioHoldingsData;
}

// Scheme-side identity ticker (e.g. an ISIN like 'CH0032831981') -> the
// ticker actually used in Input/Portfolio.csv, read live from each holding's
// 'isin' column (input/Portfolio.csv) via the report JSON's holding.isin
// field (main.py/scanner/report.py). Rebuilt from the latest
// portfolioHoldingsData on every call, same pattern as buildProxyAliasMap
// below, so it always reflects the current CSV, never a stale hard-coded map.
function buildIsinAliasMap(){
  const map = {};
  const tickers = (portfolioHoldingsData && portfolioHoldingsData.tickers) || [];
  for(const t of tickers){
    const isin = t.holding && t.holding.isin;
    if(isin && String(isin).trim()) map[String(isin).trim()] = t.ticker;
  }
  return map;
}

// proxy ticker (e.g. QQQ, the scheme's Nasdaq-100 leg) -> the ticker
// Portfolio.csv actually holds for it (e.g. XNAS.SW), read live from each
// holding's 'proxy' column (input/Portfolio.csv) via the report JSON's
// holding.proxy field (main.py). Rebuilt from the latest portfolioHoldingsData
// on every call so it always reflects the current CSV, never a stale guess.
function buildProxyAliasMap(){
  const map = {};
  const tickers = (portfolioHoldingsData && portfolioHoldingsData.tickers) || [];
  for(const t of tickers){
    const proxy = t.holding && t.holding.proxy;
    if(proxy && String(proxy).trim()) map[String(proxy).trim()] = t.ticker;
  }
  return map;
}

// Resolves a scheme-side ticker to the Portfolio.csv ticker to match against.
// viaProxy tells the caller the match is a *different* instrument standing in
// for the scheme leg (different price series) -- as opposed to an identity
// alias or a direct match, where the scheme leg's own levels are correct.
function resolveAliasedTicker(t, proxyMap, isinMap){
  if(isinMap[t]) return {ticker: isinMap[t], viaProxy: false};
  if(proxyMap[t]) return {ticker: proxyMap[t], viaProxy: true};
  return {ticker: t, viaProxy: false};
}

// Holdings excluded from the trade-recommendation pool entirely (not counted
// in the total, never recommended for sale) -- e.g. an ESAP employee plan,
// handled manually. Live list: Input/Portfolio_exclude.csv (same schema as
// Portfolio.csv -- a real, scanned holdings list, just excluded from the
// scheme trade math) via GET /api/stocks/portfolio_exclude, fetched once and
// cached like allocation/
// metrics/holdings above.
let portfolioExcludeData = null;
let portfolioExcludeTried = false;

async function ensurePortfolioExclude(){
  if(portfolioExcludeTried) return portfolioExcludeData;
  portfolioExcludeTried = true;
  try{
    const url = getActiveBase() + CONFIG.STOCKS_PORTFOLIO_EXCLUDE_PATH;
    const data = await apiJson(url);
    portfolioExcludeData = new Set((data && data.tickers || []).map(t => t.ticker));
  }catch(err){
    portfolioExcludeData = new Set();
    console.warn('portfolio_exclude fetch failed:', err.message);
  }
  const panel = $('#alloc-panel');
  if(panel && panel.style.display !== 'none') renderAllocation();
  return portfolioExcludeData;
}

// Build {ticker -> target weight%} + a combined cash weight% for one scheme.
// Uses each position/sleeve's *live* hold_now/hold_primary/hold_1x/cash split
// (already conviction/de-risk-adjusted by the producer), not the static
// long-run weight_pct, so the trade list reflects today's actual target.
function buildSchemeTargets(schemeKey){
  const a = allocationData;
  if(!a) return null;
  const block = a.schemes && a.schemes[schemeKey];
  if(!block) return null;
  const proxyMap = buildProxyAliasMap();
  const isinMap = buildIsinAliasMap();
  const targets = new Map(); // ticker -> {name, pct, meta:{levels, ml_signal, twin, isin, viaProxy}}
  const add = (originalTk, name, pct, meta) => {
    if(!pct) return;
    const {ticker: tk, viaProxy} = resolveAliasedTicker(originalTk, proxyMap, isinMap);
    // Preserve the scheme's own (pre-alias) ticker as the ISIN, when it looks like
    // one -- resolveAliasedTicker() maps it to whatever ticker Portfolio.csv holds
    // it under for matching purposes (e.g. 'CH0032831981' -> 'AVADIS'), which would
    // otherwise erase the ISIN from the row entirely.
    const fullMeta = {...(meta||{}), isin: isIsin(originalTk) ? originalTk : null, viaProxy};
    const prev = targets.get(tk);
    targets.set(tk, {
      name: (prev && prev.name) || name,
      pct: (prev ? prev.pct : 0) + pct,
      meta: (prev && prev.meta) || fullMeta,
    });
  };
  let cashPct = 0;
  // Any "positions"-shaped block (hybrid/techheavy/cashout/…) shares this
  // branch -- adding a new scheme to the producer's JSON needs no new PWA
  // branch here as long as it follows the same shape.
  const positionsBlock = Array.isArray(block.positions) ? block : null;
  if(positionsBlock){
    for(const p of (positionsBlock.positions||[])){
      add(p.ticker, p.name, isNum(p.hold_now_pct) ? p.hold_now_pct : (p.weight_pct||0),
        {levels: p.levels||null, ml_signal: p.ml_signal||null, twin: null});
    }
    cashPct += positionsBlock.cash_money_market_pct||0;
  } else if(schemeKey === 'scheme5'){
    for(const s of (block.sleeves||[])){
      // The primary ticker's own metadata carries the twin reference (per the
      // producer: for leveraged sleeves this is the REAL 1x twin's live
      // signal/levels, not the synthetic 2x series — see alloc_live.py).
      add(s.primary_ticker||s.sleeve, s.sleeve, s.hold_primary_pct||0,
        {levels: s.levels||null, ml_signal: s.ml_signal||null, twin: s.shift_1x_ticker||null});
      if(s.shift_1x_ticker && (s.hold_1x_pct||0) > 0){
        // shift_1x_ticker is a display label ("URTH (1x World)") -- the actual
        // matchable ticker is its first token; using the full label as the map
        // key meant this leg could never match a real Portfolio.csv holding.
        const twinTicker = s.shift_1x_ticker.split(' ')[0];
        add(twinTicker, s.shift_1x_ticker, s.hold_1x_pct,
          {levels: s.levels||null, ml_signal: s.ml_signal||null, twin: null});
      }
      cashPct += s.cash_pct||0;
    }
  } else return null;
  // rebalance_band_pp is the scheme's own declared drift tolerance for its
  // B&H legs (see the producer's note: "Fund/Gold/Bonds sind Buy&Hold (±5pp
  // Rebalance-Band)") -- absent/0 means no band.
  const band = isNum(block.rebalance_band_pp) ? block.rebalance_band_pp : 0;
  return {targets, cashPct, band};
}

// ISIN heuristic (ISO 6166: 2 letters + 9 alnum + 1 check digit) -- the scheme/
// hybrid JSON uses the ISIN itself as the "ticker" for fund legs with no
// exchange ticker (Avadis, ZKB Gold ETF, CHF Bonds).
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const isIsin = (tk) => ISIN_RE.test(tk||'');

// German rationale text for each backend reason code (functions/order_hint.py
// order_hints_both(), embedded per held ticker as report.order_hints by
// main.py/scanner/report.py). Replaces the old orderHintJS() mirror -- the
// backend now computes both trade directions itself; this only localizes the
// stable reason code into the UI's German text.
const ORDER_HINT_REASON_DE = {
  breakout_upper:     () => 'Market — Ausbruch über oberes Band',
  pullback_support:   price => `Limit @ ${price.toFixed(2)} — Rücksetzer-Kauf`,
  no_support:         () => 'Market — kein Support unter Kurs',
  breakdown_lower:    () => 'Market — Ausbruch unter unteres Band',
  sell_into_strength: price => `Limit @ ${price.toFixed(2)} — Verkauf in Stärke`,
  no_resistance:      () => 'Market — kein Widerstand über Kurs',
  ml_off_exit:        () => 'Market — ML-Off-Exit (De-Risk-Verkäufe nie per Limit)',
};

// hint is report.order_hints[direction] ({type, price, reason}) for a held
// ticker, or null when no order_hints are available (a stale pre-upgrade
// report, or a scheme leg with no matching Portfolio.csv holding) -- shown as
// a placeholder rather than recomputed from scheme-side data.
function localizeOrderHint(hint, direction){
  if(!hint) {
    return {type:'market', price:null,
      rationale: direction==='buy' ? 'Market — neue Position, keine Kursdaten' : 'Market — keine Kursdaten'};
  }
  return {type: hint.type, price: hint.price, rationale: ORDER_HINT_REASON_DE[hint.reason](hint.price)};
}

// Recommended trades to move the WHOLE current portfolio (Input/Portfolio.csv,
// total CHF value across every held ticker) into the selected scheme's target
// weights: any holding outside the scheme's sleeves is a full sell; any scheme
// instrument not yet held is a full buy from cash. Same formula whether the
// portfolio has never matched the scheme (large trades) or already does
// (small drift-correction trades) — there is no separate "rebalance mode".
// The scheme's rebalance_band_pp additionally suppresses drift corrections on
// already-held B&H legs (no ml_signal) while |drift| < band — drift within the
// band is deliberate holding, not a trade signal. ML-timed legs are exempt: a
// conviction-driven target change is the strategy speaking, never band-eaten.
function computeSchemeTrades(schemeKey){
  const built = buildSchemeTargets(schemeKey);
  const holdings = portfolioHoldingsData;
  if(!built || !holdings || !Array.isArray(holdings.tickers)) return null;

  const exclude = portfolioExcludeData || new Set();
  const byTicker = new Map();
  const excludedHeld = [];
  let total = 0;
  for(const t of holdings.tickers){
    const v = (t.holding && isNum(t.holding.value_chf)) ? t.holding.value_chf : 0;
    if(exclude.has(t.ticker)){ if(v > 0) excludedHeld.push(t.ticker); continue; }
    // The Portfolio report already computes real levels/ml_risk/order_hints for
    // every held ticker (main.py/scanner/report.py's per-row pipeline) -- reuse
    // them for holdings outside the scheme too, instead of a blind "no data"
    // fallback. These are real, currently-held instruments; a full-sell
    // recommendation on one deserves the same real Market/Limit price a scheme
    // instrument gets, not a placeholder.
    if(v > 0){
      const ml_signal = t.panel && t.panel.ml_risk && t.panel.ml_risk.signal || null;
      byTicker.set(t.ticker, {value: v, name: t.name, levels: t.levels||null, ml_signal, orderHints: t.order_hints||null});
      total += v;
    }
  }
  if(total <= 0) return null;

  const passes = (absTrade) => absTrade / total * 100 >= DUST_PCT && absTrade >= MIN_ORDER_CHF;
  const rows = [];
  const seen = new Set();
  for(const [tk, {name, pct, meta}] of built.targets){
    seen.add(tk);
    const targetVal = total * pct / 100;
    const held = byTicker.get(tk);
    const curVal = (held||{}).value || 0;
    const trade = targetVal - curVal;
    // A proxy-matched leg (scheme wants QQQ, Portfolio.csv holds XNAS.SW as its
    // declared proxy) MUST price off the actually-held instrument -- QQQ and
    // XNAS.SW track closely but are different tickers on different price
    // scales, so the scheme's own QQQ levels would produce a nonsense limit
    // price for an XNAS.SW order. The backend's order_hints are always keyed
    // by the actually-held ticker (this report row), so this falls out for
    // free -- no separate viaProxy branch needed for pricing, only for the
    // displayed meta (ml_signal/levels shown in the row detail sheet).
    const viaProxy = meta && meta.viaProxy && held && held.levels;
    const rowMeta = viaProxy ? {...meta, levels: held.levels, ml_signal: held.ml_signal}
      : (meta || (held && held.levels ? {levels: held.levels, ml_signal: held.ml_signal, twin: null} : null));
    // Band check uses the SCHEME's own meta (stance), not the holding's report
    // signal: B&H legs carry no ml_signal in the scheme JSON, timed legs do.
    const bandHeld = built.band > 0 && curVal > 0 && !(meta && meta.ml_signal);
    if(bandHeld && Math.abs(trade) / total * 100 < built.band) continue;
    if(passes(Math.abs(trade))){
      const dir = trade > 0 ? 'buy' : 'sell';
      const hint = held && held.orderHints ? held.orderHints[dir] : null;
      rows.push({ticker: tk, name: (held||{}).name || name, targetVal, curVal, trade,
        meta: rowMeta, orderHint: localizeOrderHint(hint, dir)});
    }
  }
  const cashTarget = total * built.cashPct / 100;
  if(passes(cashTarget)) rows.push({ticker: 'CASH', name: 'Cash / Geldmarkt', targetVal: cashTarget, curVal: 0, trade: cashTarget, meta: null, orderHint: null});
  for(const [tk, {value, name, levels, ml_signal, orderHints}] of byTicker){
    if(!seen.has(tk) && passes(value)) rows.push({ticker: tk, name, targetVal: 0, curVal: value, trade: -value,
      meta: {levels, ml_signal, twin: null}, orderHint: localizeOrderHint(orderHints ? orderHints.sell : null, 'sell')});
  }
  rows.sort((x,y) => Math.abs(y.trade) - Math.abs(x.trade));
  return {total, rows, fx: holdings.fx, excludedHeld, band: built.band};
}

// Inverse of convertCHF: interpret a value typed in the display currency as CHF.
function toCHF(amount, currency, fx){
  if(!isNum(amount)) return null;
  if(currency === 'CHF') return amount;
  if(!fx) return null;
  if(currency === 'USD') return isNum(fx.USDCHF) ? amount * fx.USDCHF : null;
  if(currency === 'EUR') return isNum(fx.EURCHF) ? amount * fx.EURCHF : null;
  if(currency === 'GBP') return isNum(fx.GBPCHF) ? amount * fx.GBPCHF : null;
  if(currency === 'BTC') return (isNum(fx.BTCUSD) && isNum(fx.USDCHF)) ? amount * fx.BTCUSD * fx.USDCHF : null;
  return null;
}

// Additive-only recommendation for where NEW cash should go to move the
// portfolio toward the selected scheme's target weights — never a sell,
// unlike computeSchemeTrades(). Shortfall-proportional fill: every target
// under its target value gets funded first; if the cash covers every
// shortfall, the leftover is spread pro-rata by target weight instead of
// sitting idle. Same holdings pool (exclusions applied) and dust threshold
// as computeSchemeTrades() so the two tables agree on "what counts".
function computeAddCash(schemeKey, cashChf){
  const built = buildSchemeTargets(schemeKey);
  const holdings = portfolioHoldingsData;
  if(!built || !holdings || !Array.isArray(holdings.tickers)) return null;
  if(!isNum(cashChf) || cashChf <= 0) return null;

  const exclude = portfolioExcludeData || new Set();
  const byTicker = new Map();
  let currentTotal = 0;
  for(const t of holdings.tickers){
    const v = (t.holding && isNum(t.holding.value_chf)) ? t.holding.value_chf : 0;
    if(exclude.has(t.ticker)) continue;
    if(v > 0){
      const ml_signal = t.panel && t.panel.ml_risk && t.panel.ml_risk.signal || null;
      byTicker.set(t.ticker, {value: v, name: t.name, levels: t.levels||null, ml_signal, orderHints: t.order_hints||null});
      currentTotal += v;
    }
  }

  const newTotal = currentTotal + cashChf;

  // Build every target leg (incl. the cash/Geldmarkt leg) with its shortfall.
  // Prefer the scheme's own levels; fall back to a held ticker's report-sourced
  // levels if the scheme has none for it (same rationale as computeSchemeTrades,
  // including the proxy-match override -- see there for why). order_hints are
  // always keyed by the actually-held ticker, so no proxy branch is needed for
  // pricing (see computeSchemeTrades).
  const legs = [];
  for(const [tk, {name, pct, meta}] of built.targets){
    const targetVal = newTotal * pct / 100;
    const held = byTicker.get(tk);
    const curVal = (held||{}).value || 0;
    const viaProxy = meta && meta.viaProxy && held && held.levels;
    const legMeta = viaProxy ? {...meta, levels: held.levels, ml_signal: held.ml_signal}
      : (meta || (held && held.levels ? {levels: held.levels, ml_signal: held.ml_signal, twin: null} : null));
    legs.push({ticker: tk, name: (held||{}).name || name, pct, curVal, meta: legMeta,
      orderHints: (held||{}).orderHints || null,
      shortfall: Math.max(0, targetVal - curVal)});
  }
  if(built.cashPct > 0){
    legs.push({ticker: 'CASH', name: 'Cash / Geldmarkt', pct: built.cashPct, curVal: 0, meta: null,
      orderHints: null,
      shortfall: Math.max(0, newTotal * built.cashPct / 100)});
  }

  const sumShortfall = legs.reduce((s, l) => s + l.shortfall, 0);
  let rows;
  if(sumShortfall <= 0){
    // No shortfalls at all (portfolio already at/above every target) — spread
    // the whole amount pro-rata by weight since there's nothing to "catch up".
    const sumPct = legs.reduce((s, l) => s + l.pct, 0) || 1;
    rows = legs.map(l => ({ticker: l.ticker, name: l.name, amount: cashChf * l.pct / sumPct, meta: l.meta, orderHints: l.orderHints}));
  } else if(sumShortfall <= cashChf){
    const leftover = cashChf - sumShortfall;
    const sumPct = legs.reduce((s, l) => s + l.pct, 0) || 1;
    rows = legs.map(l => ({ticker: l.ticker, name: l.name, amount: l.shortfall + leftover * l.pct / sumPct, meta: l.meta, orderHints: l.orderHints}));
  } else {
    // Greedy water-fill: pour the deposit into the largest absolute shortfall
    // first, spilling to the next leg only once the current one reaches target.
    // A small deposit thus lands as ONE actionable trade in the most-underweight
    // position instead of being split proportionally into sub-threshold slivers
    // that the MIN_ORDER_CHF filter below would drop, leaving no recommendation
    // at all. Biggest gaps first also cuts tracking error to target fastest per
    // franc, and mirrors how one actually invests new cash: top up whatever is
    // furthest below plan.
    const ordered = [...legs].sort((a, b) => b.shortfall - a.shortfall);
    let remaining = cashChf;
    rows = [];
    for(const l of ordered){
      if(remaining <= 0) break;
      const put = Math.min(l.shortfall, remaining);
      remaining -= put;
      rows.push({ticker: l.ticker, name: l.name, amount: put, meta: l.meta, orderHints: l.orderHints});
    }
  }

  rows = rows.filter(r => r.amount / cashChf * 100 >= DUST_PCT && r.amount >= MIN_ORDER_CHF);
  if(rows.length === 0 && cashChf >= MIN_ORDER_CHF && legs.length){
    // Deposit fragmented across several near-filled gaps, so every greedy leg
    // came in under MIN_ORDER: fall back to a single trade of the whole amount
    // into the most-underweight leg, so a >=1000 CHF deposit is always
    // actionable (may slightly overshoot that one leg's target — self-corrects
    // at the next rebalance, preferable to showing "no trades").
    const top = legs.reduce((a, b) => b.shortfall > a.shortfall ? b : a);
    rows = [{ticker: top.ticker, name: top.name, amount: cashChf, meta: top.meta, orderHints: top.orderHints}];
  }
  rows.sort((x,y) => y.amount - x.amount);
  // Additive-only: every row is a buy by construction.
  rows.forEach(r => { r.orderHint = localizeOrderHint(r.orderHints ? r.orderHints.buy : null, 'buy'); });
  return {cash: cashChf, rows, fx: holdings.fx};
}

// Structural mirror of computeAddCash() for the opposite flow: raising W CHF
// by selling down toward the scheme's target weights. Sell-only, from each
// leg's excess over its POST-withdrawal target (newTotal = currentTotal-W,
// so target weights are evaluated against the smaller post-withdrawal book,
// not today's total) -- proportionally while excess covers W, pro-rata by
// weight for any remainder once every leg's excess is exhausted. Unlike
// computeAddCash, the scheme's own cash/money-market target is NOT a leg
// here: that leg has no tracked curVal (computeAddCash hardcodes it to 0),
// so treating it symmetrically would recommend "selling" untracked cash.
// The withdrawal amount is instead surfaced as one fixed CASH receipt row.
function computeWithdrawal(schemeKey, cashChf){
  const built = buildSchemeTargets(schemeKey);
  const holdings = portfolioHoldingsData;
  if(!built || !holdings || !Array.isArray(holdings.tickers)) return null;
  if(!isNum(cashChf) || cashChf <= 0) return null;

  const exclude = portfolioExcludeData || new Set();
  const byTicker = new Map();
  let currentTotal = 0;
  for(const t of holdings.tickers){
    const v = (t.holding && isNum(t.holding.value_chf)) ? t.holding.value_chf : 0;
    if(exclude.has(t.ticker)) continue;
    if(v > 0){
      const ml_signal = t.panel && t.panel.ml_risk && t.panel.ml_risk.signal || null;
      byTicker.set(t.ticker, {value: v, name: t.name, levels: t.levels||null, ml_signal, orderHints: t.order_hints||null});
      currentTotal += v;
    }
  }
  if(currentTotal <= 0) return null;

  // Can never withdraw more than the (exclusions-adjusted) book holds.
  const W = Math.min(cashChf, currentTotal);
  const newTotal = currentTotal - W;

  const legs = [];
  for(const [tk, {name, pct, meta}] of built.targets){
    const targetVal = newTotal * pct / 100;
    const held = byTicker.get(tk);
    const curVal = (held||{}).value || 0;
    const viaProxy = meta && meta.viaProxy && held && held.levels;
    const legMeta = viaProxy ? {...meta, levels: held.levels, ml_signal: held.ml_signal}
      : (meta || (held && held.levels ? {levels: held.levels, ml_signal: held.ml_signal, twin: null} : null));
    legs.push({ticker: tk, name: (held||{}).name || name, pct, curVal, meta: legMeta,
      orderHints: (held||{}).orderHints || null,
      excess: Math.max(0, curVal - targetVal)});
  }

  const sumExcess = legs.reduce((s, l) => s + l.excess, 0);
  const sumPct = legs.reduce((s, l) => s + l.pct, 0) || 1;
  // Math.min(l.curVal, …) in every branch: cheap, always-correct insurance
  // that no leg is ever asked to sell more than it actually holds, so this
  // holds regardless of which branch's algebra applies at the edges.
  let rows;
  if(sumExcess <= 0){
    rows = legs.map(l => ({ticker: l.ticker, name: l.name, amount: Math.min(l.curVal, W * l.pct / sumPct), meta: l.meta, orderHints: l.orderHints}));
  } else if(sumExcess <= W){
    const remainder = W - sumExcess;
    rows = legs.map(l => ({ticker: l.ticker, name: l.name, amount: Math.min(l.curVal, l.excess + remainder * l.pct / sumPct), meta: l.meta, orderHints: l.orderHints}));
  } else {
    rows = legs.map(l => ({ticker: l.ticker, name: l.name, amount: Math.min(l.curVal, W * l.excess / sumExcess), meta: l.meta, orderHints: l.orderHints}));
  }

  rows = rows.filter(r => r.amount > 0 && r.amount / W * 100 >= DUST_PCT && r.amount >= MIN_ORDER_CHF);
  rows.sort((x,y) => y.amount - x.amount);
  rows.forEach(r => { r.orderHint = localizeOrderHint(r.orderHints ? r.orderHints.sell : null, 'sell'); });
  rows.push({ticker: 'CASH', name: 'Cash / Geldmarkt', amount: W, meta: null, orderHints: null, orderHint: null});
  return {cash: W, rows, fx: holdings.fx};
}

// Same green/red convention as the Übersicht Order column (orderCell/orderDirection).
function allocOrderCell(oh, dir){
  if(!oh) return '<span class="num">—</span>';
  const cls = dir==='buy' ? 'pos' : (dir==='sell' ? 'neg' : '');
  const typeLabel = oh.type==='market' ? 'Market' : 'Limit';
  const priceStr = oh.price!=null ? ` @ ${oh.price.toFixed(2)}` : '';
  return `<span class="num ${cls}">${esc(typeLabel)}${priceStr}</span>`;
}

// Last-rendered rows, kept for the delegated row-click → popup lookup (avoids
// round-tripping row objects through HTML data-attributes).
let _lastTradesResult = null;
let _lastAddCashResult = null;
let _lastWithdrawalResult = null;

function renderTradesHtml(result){
  _lastTradesResult = result;
  if(!result || !result.rows.length){
    const bandPart = result && result.band > 0 ? `B&amp;H-Abweichungen &le; &plusmn;${result.band}pp, ` : '';
    return `<p class="hint alloc-hint">Portfolio bereits deckungsgleich mit diesem Schema (${bandPart}keine Trades &gt; 0.5% oder &gt;1000 CHF).</p>`;
  }
  const currency = getCurrency();
  // Jetzt/Ziel/Trade: same values already shown per-row in the detail sheet
  // (openTradeSheet) -- .wide-col hides them below ~700px so mobile keeps the
  // narrow 2-column layout while desktop doesn't waste its width.
  const rows = result.rows.map((r,i) => {
    const tradeCls = r.trade>0?'pos':(r.trade<0?'neg':'');
    return `<tr class="alloc-trade-row" data-kind="trade" data-idx="${i}">
    <td style="text-align:left">${esc(r.name||r.ticker)}<div class="cell-sub">${esc(r.ticker)}</div></td>
    <td class="wide-col">${convertCHF(r.curVal, currency, result.fx)}</td>
    <td class="wide-col">${convertCHF(r.targetVal, currency, result.fx)}</td>
    <td class="wide-col num ${tradeCls}">${convertCHF(r.trade, currency, result.fx)}</td>
    <td>${allocOrderCell(r.orderHint, r.trade>0?'buy':'sell')}</td>
  </tr>`;
  }).join('');
  return `
    <p class="section-label">Empfohlene Trades — Transfer ins Schema</p>
    <div class="table-scroll">
      <table class="alloc-hybrid-tbl alloc-trades-tbl">
        <thead><tr>
          <th style="text-align:left">Position</th>
          <th class="wide-col">Jetzt</th>
          <th class="wide-col">Ziel</th>
          <th class="wide-col">Trade</th>
          <th>Order</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint alloc-hint">Basis: Gesamtwert von <b>input/Portfolio.csv</b> (${convertCHF(result.total, getCurrency(), result.fx)}${
      result.excludedHeld.length ? `, ohne ${result.excludedHeld.map(esc).join(', ')} (input/Portfolio_exclude.csv — manuell verwaltet, nie Teil des Trade-Vorschlags)` : ''
    }),
      umverteilt auf die Zielgewichte des gewählten Schemas — Positionen außerhalb des Schemas
      werden vollständig verkauft, fehlende Schema-Positionen aus Cash gekauft. Trades &lt;0.5% oder
      &lt;1000 CHF werden ausgeblendet. Zeile antippen für Details.</p>
  `;
}

function renderAddCashHtml(result){
  _lastAddCashResult = result;
  if(!result || !result.rows.length) return '';
  const rows = result.rows.map((r,i) => `<tr class="alloc-trade-row" data-kind="addcash" data-idx="${i}">
    <td style="text-align:left">${esc(r.name||r.ticker)}<div class="cell-sub">${esc(r.ticker)}</div></td>
    <td>${allocOrderCell(r.orderHint, 'buy')}</td>
  </tr>`).join('');
  return `
    <p class="section-label">Neue Einzahlung — wohin investieren</p>
    <div class="table-scroll">
      <table class="alloc-hybrid-tbl alloc-trades-tbl">
        <thead><tr>
          <th style="text-align:left">Position</th>
          <th>Order</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint alloc-hint">Additiv: verteilt nur die neue Einzahlung (${convertCHF(result.cash, getCurrency(), result.fx)})
      auf die Positionen mit dem größten Rückstand zum Zielgewicht — nie ein Verkauf. Trades &lt;0.5%
      der Einzahlung oder &lt;1000 CHF werden ausgeblendet. Zeile antippen für Details.</p>
  `;
}

function renderWithdrawalHtml(result){
  _lastWithdrawalResult = result;
  if(!result || !result.rows.length) return '';
  // The trailing CASH row is a receipt line (the withdrawn total), not a sell
  // recommendation -- rendered plain, without the trade-row class/data-idx,
  // so it isn't clickable into a detail sheet like the real sell rows above it.
  const rows = result.rows.map((r,i) => {
    const isCash = r.ticker === 'CASH';
    if(isCash){
      return `<tr>
      <td style="text-align:left">${esc(r.name)}</td>
      <td class="num">${convertCHF(r.amount, getCurrency(), result.fx)}</td>
    </tr>`;
    }
    return `<tr class="alloc-trade-row" data-kind="withdrawal" data-idx="${i}">
    <td style="text-align:left">${esc(r.name||r.ticker)}<div class="cell-sub">${esc(r.ticker)}</div></td>
    <td>${allocOrderCell(r.orderHint, 'sell')}</td>
  </tr>`;
  }).join('');
  return `
    <p class="section-label">Empfohlene Verkäufe — Entnahme</p>
    <div class="table-scroll">
      <table class="alloc-hybrid-tbl alloc-trades-tbl">
        <thead><tr>
          <th style="text-align:left">Position</th>
          <th>Order</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint alloc-hint">Entnahme von ${convertCHF(result.cash, getCurrency(), result.fx)}: verkauft anteilig aus dem
      Überschuss jeder Position über ihrem Zielgewicht (nach der Entnahme berechnet) — Zielgewichte bleiben so
      weit wie möglich erhalten. Trades &lt;0.5% der Entnahme oder &lt;1000 CHF werden ausgeblendet. Zeile antippen für Details.</p>
  `;
}

// ---------- trade detail popup (copyable ISIN / order level) ----------
let _copyBtnSeq = 0;
function copyBtnHtml(text){
  return `<button class="copy-btn" data-copy="${esc(text)}" title="Kopieren" type="button">⧉</button>`;
}
function wireCopyButtons(root){
  root.querySelectorAll('.copy-btn').forEach(btn=>{
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const text = btn.dataset.copy;
      try{
        await navigator.clipboard.writeText(text);
        btn.classList.add('copied');
        const orig = btn.textContent;
        btn.textContent = '✓';
        setTimeout(()=>{ btn.textContent = orig; btn.classList.remove('copied'); }, 1200);
      }catch(err){ console.warn('clipboard write failed:', err.message); }
    });
  });
}

// Same look & feel as the Übersicht row-sheet (openRowSheet) -- reuses its CSS
// classes (.row-sheet*/.rs-metric*) for visual consistency between the two popups.
function openTradeSheet(row, ctx){
  if(!row) return;
  document.querySelectorAll('.row-sheet-backdrop,.row-sheet').forEach(el=>el.remove());
  const backdrop=document.createElement('div'); backdrop.className='row-sheet-backdrop';
  const sheet=document.createElement('div'); sheet.className='row-sheet';

  const currency = getCurrency();
  const meta = row.meta || {};
  const oh = row.orderHint;
  const isAddCash = ctx.kind === 'addcash';
  const isWithdrawal = ctx.kind === 'withdrawal';
  const dir = isAddCash ? 'buy' : isWithdrawal ? 'sell' : (row.trade > 0 ? 'buy' : (row.trade < 0 ? 'sell' : null));
  const ohCls = dir==='buy' ? 'pos' : (dir==='sell' ? 'neg' : '');

  const isinTile = isIsin(row.ticker) ? `<div class="rs-metric"><span class="rs-metric-label">ISIN</span>
    <span class="rs-metric-value">${esc(row.ticker)} ${copyBtnHtml(row.ticker)}</span></div>` : '';

  let twinTile = '';
  if(meta.twin){
    const twinTicker = meta.twin.split(' ')[0];
    twinTile = `<div class="rs-metric"><span class="rs-metric-label">Reale Position</span>
      <span class="rs-metric-value">${esc(meta.twin)} ${copyBtnHtml(twinTicker)}</span></div>`;
  }

  const mlTile = meta.ml_signal ? `<div class="rs-metric"><span class="rs-metric-label">ML</span>
    <span class="rs-metric-value">${esc(meta.ml_signal)}</span></div>` : '';

  const jetztZielHtml = (isAddCash || isWithdrawal) ? '' : `
    <div class="rs-metric"><span class="rs-metric-label">Jetzt</span><span class="rs-metric-value">${convertCHF(row.curVal, currency, ctx.fx)}</span></div>
    <div class="rs-metric"><span class="rs-metric-label">Ziel</span><span class="rs-metric-value">${convertCHF(row.targetVal, currency, ctx.fx)}</span></div>`;

  const amountLabel = isAddCash ? 'Neu investieren' : isWithdrawal ? 'Verkauf' : 'Trade';
  const amountVal = (isAddCash || isWithdrawal) ? row.amount : row.trade;
  const amountCls = isWithdrawal ? 'neg' : (amountVal>0 ? 'pos' : (amountVal<0 ? 'neg' : ''));
  const amountStr = isAddCash ? convertCHF(row.amount, currency, ctx.fx)
    : isWithdrawal ? 'Verkaufen ' + convertCHF(row.amount, currency, ctx.fx)
    : (amountVal>0 ? 'Kaufen ' : 'Verkaufen ') + convertCHF(Math.abs(amountVal), currency, ctx.fx);

  const orderPriceStr = (oh && oh.price!=null) ? oh.price.toFixed(2) : null;
  const orderTile = oh ? `<div class="rs-metric"><span class="rs-metric-label">Order</span>
    <span class="rs-metric-value num ${ohCls}">${esc(oh.type==='market'?'Market':'Limit')}${orderPriceStr?(' @ '+orderPriceStr):''}
    ${orderPriceStr?copyBtnHtml(orderPriceStr):''}</span></div>` : '';

  sheet.innerHTML = `<div class="row-sheet-panel">
    <div class="row-sheet-header">
      <div class="row-sheet-title">${esc(row.name||row.ticker)}</div>
      <div class="row-sheet-sub">${esc(row.ticker)}</div>
    </div>
    <div class="row-sheet-section">
      <div class="row-sheet-section-label">Details</div>
      <div class="rs-metrics">
        ${jetztZielHtml}
        <div class="rs-metric"><span class="rs-metric-label">${amountLabel}</span><span class="rs-metric-value num ${amountCls}">${amountStr}</span></div>
        ${mlTile}
        ${isinTile}
        ${twinTile}
      </div>
    </div>
    ${orderTile ? `<div class="row-sheet-section">
      <div class="row-sheet-section-label">Ordervorschlag</div>
      <div class="rs-metrics">${orderTile}</div>
      <div class="rs-order-rationale">${esc(oh.rationale||'')}</div>
    </div>` : ''}
  </div>`;

  backdrop.addEventListener('click', ()=>{ backdrop.remove(); sheet.remove(); });
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
  wireCopyButtons(sheet);
}

// Delegated click/dblclick on both trade tables — looks up the row by index
// from the last-rendered result rather than round-tripping data through HTML
// attributes. dblclick mirrors click (desktop-mouse affordance parity with
// the row-sheet-hint pattern elsewhere) rather than being a distinct action.
function openTradeRowSheet(e){
  const tr = e.target.closest('.alloc-trade-row');
  if(!tr) return;
  const idx = Number(tr.dataset.idx);
  if(tr.dataset.kind === 'trade' && _lastTradesResult){
    openTradeSheet(_lastTradesResult.rows[idx], {fx: _lastTradesResult.fx, kind: 'trade'});
  } else if(tr.dataset.kind === 'addcash' && _lastAddCashResult){
    openTradeSheet(_lastAddCashResult.rows[idx], {fx: _lastAddCashResult.fx, kind: 'addcash'});
  } else if(tr.dataset.kind === 'withdrawal' && _lastWithdrawalResult){
    openTradeSheet(_lastWithdrawalResult.rows[idx], {fx: _lastWithdrawalResult.fx, kind: 'withdrawal'});
  }
}
document.addEventListener('click', openTradeRowSheet);
document.addEventListener('dblclick', openTradeRowSheet);

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
    ['Order',    r=>r.order_hint,             (v,r)=>orderCell(v,r),   'n'],
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
  ['Order',    r=>r.order_hint,             (v,r)=>orderCell(v,r),   'n'],
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

// Order-execution hint direction, mirroring the Buy/Sell collapse in
// functions/order_hint.py (the ml_risk panel signal is the authoritative
// source — order_hint itself only carries type/price/rationale, not direction).
function orderDirection(r){
  const sig = r.panel && r.panel.ml_risk && r.panel.ml_risk.signal;
  if(sig==='Buy'||sig==='Strong Buy') return 'buy';
  if(sig==='Sell'||sig==='Strong Sell'||sig==='Reduce') return 'sell';
  return null;
}
function orderCell(oh,r){
  if(!oh) return '—';
  const dir = orderDirection(r);
  const cls = dir==='buy' ? 'pos' : (dir==='sell' ? 'neg' : '');
  const typeLabel = oh.type==='market' ? 'Market' : 'Limit';
  const priceStr = oh.price!=null ? ` @ ${oh.price}` : '';
  return `<span class="num ${cls}">${esc(typeLabel)}${priceStr}</span>`;
}

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

  // Show currency selector only when the report has holdings. The portfolio
  // total-value chart no longer lives here -- it's a fixed Digest-tab fixture
  // (Portfolio + Portfolio_exclude combined, see loadDigestPerf()), independent
  // of whatever report/list is open in Übersicht.
  const hasFx = !!(json.fx);
  const currSel = $('#currency-sel');
  if(currSel){
    if(hasFx){
      currSel.value = getCurrency();
      currSel.style.display = '';
    } else {
      currSel.style.display = 'none';
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

// "Full" range: the capped/embedded series above is ~1.5y (CONFIG['series_max_bars']
// server-side). The Full button instead lazily fetches the ticker's whole uncapped
// history straight from store.db via GET .../series?ticker=&full=1 (server.js's
// spawnSeriesFull path) -- same single-ticker { date, open, ... } shape as the
// capped endpoint, so it drops straight into r.series/curSeries() unchanged.
// Cached per-ticker (fetched at most once) and swapped into r.series in place --
// other ranges (120d/60d/14d) just slice whatever's already there, so once a
// ticker's full history is loaded they benefit too without a second fetch.
const fullSeriesCache = new Map();
const fullSeriesUrl = (ticker) => getActiveBase() + CONFIG.STOCKS_SERIES_PATH + '?ticker=' + encodeURIComponent(ticker) + '&full=1';
async function ensureFullSeries(ticker) {
  const r = ROWS.find(t => t.ticker === ticker);
  if (!r) return;
  if (fullSeriesCache.has(ticker)) { r.series = fullSeriesCache.get(ticker); return; }
  try {
    const data = await apiJson(fullSeriesUrl(ticker));
    const s = data && data.ticker;
    if (s) { fullSeriesCache.set(ticker, s); r.series = s; }
  } catch (err) {
    // 404 (ticker not in store.db) or a network/server error -- silently keep
    // whatever series is already loaded rather than blanking the chart.
    console.warn('ensureFullSeries failed:', err.message);
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

// Forward/backward-fill a date->value Map onto a sorted date union (nearest known
// value carried across gaps) -- same fill convention as functions/allocation.py's
// chf_factor_series (ffill().bfill()), needed because Portfolio.perf.json and
// Portfolio_exclude.perf.json come from independent scans with ragged, non-identical
// date windows (different holding histories / scan cutoffs).
function _fillOnUnion(map, unionDates){
  const out = new Array(unionDates.length).fill(null);
  let last = null;
  for(let i = 0; i < unionDates.length; i++){
    if(map.has(unionDates[i])) last = map.get(unionDates[i]);
    out[i] = last;
  }
  let next = null;
  for(let i = unionDates.length - 1; i >= 0; i--){
    if(out[i] !== null) next = out[i];
    else out[i] = next;
  }
  return out;
}

/** Sum two portfolio_series payloads ({dates,total,fx}) onto their date union. */
function combinePerf(a, b){
  if(!a && !b) return null;
  if(!a) return b;
  if(!b) return a;
  const unionDates = Array.from(new Set([...(a.dates||[]), ...(b.dates||[])])).sort();
  const aTotal = _fillOnUnion(new Map((a.dates||[]).map((d,i)=>[d, a.total[i]])), unionDates);
  const bTotal = _fillOnUnion(new Map((b.dates||[]).map((d,i)=>[d, b.total[i]])), unionDates);
  const total = unionDates.map((_, i) => (aTotal[i]||0) + (bTotal[i]||0));
  const fx = {};
  const fxKeys = new Set([...Object.keys(a.fx||{}), ...Object.keys(b.fx||{})]);
  for(const k of fxKeys){
    const aMap = new Map((a.dates||[]).map((d,i)=>[d, (a.fx||{})[k]?.[i]]));
    const bMap = new Map((b.dates||[]).map((d,i)=>[d, (b.fx||{})[k]?.[i]]));
    const aFilled = _fillOnUnion(aMap, unionDates);
    const bFilled = _fillOnUnion(bMap, unionDates);
    fx[k] = unionDates.map((_, i) => aFilled[i] ?? bFilled[i] ?? null);
  }
  return {base: a.base || b.base, dates: unionDates, total, fx};
}

let _digestPerfLoaded = false;
let _digestPerfFetch = null;

/** Combined Portfolio + Portfolio_exclude total-value chart, shown at the bottom
 * of the Digest tab (portfolio-wide, independent of whatever report/list is open
 * in Übersicht) -- see combinePerf() above for the date-alignment rationale. */
export async function loadDigestPerf(){
  const wrap = $('#perf-wrap');
  if(!wrap) return;
  // Guard here, not just at each call site: this chart belongs to the Digest
  // sub-tab only. Callers include the outer "Digest" bottom-nav tab becoming
  // visible (pwa:tab), which fires regardless of whether the Digest|Allokation
  // sub-tab is currently on Allokation -- without this check the chart would
  // reappear under Allokation on e.g. Übersicht -> Digest navigation even
  // after switchSubtab() hides it.
  const allocPanel = $('#alloc-panel');
  const onAlloc = allocPanel && allocPanel.style.display !== 'none';
  if(onAlloc){ wrap.style.display = 'none'; return; }
  if(_digestPerfLoaded){
    const combined = perfCache.get('__digest_combined__');
    if(combined){ wrap.style.display=''; drawPerf(combined); }
    return;
  }
  if(!_digestPerfFetch){
    _digestPerfFetch = Promise.all([
      apiJson(perfUrl('Portfolio')).catch(()=>null),
      apiJson(perfUrl('Portfolio_exclude')).catch(()=>null),
    ]).then(([a, b]) => {
      _digestPerfLoaded = true;
      _digestPerfFetch = null;
      const combined = combinePerf(a, b);
      if(combined) perfCache.set('__digest_combined__', combined);
      return combined;
    });
  }
  const combined = await _digestPerfFetch;
  if(combined){ wrap.style.display=''; drawPerf(combined); }
  else wrap.style.display = 'none';
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
  if(lgEl) legend(lgEl, [['#4ea1ff', 'Portfolio gesamt inkl. Exclude (' + currency + ')']]);
}

/** Loads the report manifest and renders the newest report. */
// input/research/*.csv lists (training/research universes) -- never-scanned
// ones are reached exclusively via the Portfolio tab's "…" chip now; here we
// only need the key set so populateReports() can group already-emitted
// research reports into their own <optgroup>. Fetched once, cached like
// allocation/metrics/holdings above.
let researchListsData = null;
let researchListsTried = false;

async function ensureResearchLists(){
  if(researchListsTried) return researchListsData;
  researchListsTried = true;
  try{
    const url = getActiveBase() + CONFIG.STOCKS_RESEARCH_LISTS_PATH;
    researchListsData = await apiJson(url);
  }catch(err){
    researchListsData = [];
    console.warn('research_lists fetch failed:', err.message);
  }
  return researchListsData;
}

export async function loadReports(){
  await loadLists();
  ensureAllocation();       // fire-and-forget: pre-warms the cache so the Allokation sub-tab is ready
  ensureMetrics();          // fire-and-forget: pre-warms so the Backtest preset is ready on first pick
  await ensureResearchLists(); // needed before the first populateReports() call so research reports group correctly
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

  // Research lists (Input/research/*.csv) that have never been scanned live
  // exclusively in the Portfolio tab's "…" chip now; here we only ever show
  // a research list once it already has at least one emitted report, mixed
  // into the normal dropdown like any other list (no toggle).
  const researchKeys = new Set((researchListsData||[]).map(r=>r.key));
  const mainKeys = [...groups.keys()].filter(k=>!researchKeys.has(k));
  const researchGroupKeys = [...groups.keys()].filter(k=>researchKeys.has(k));

  const optHtml = k => `<option value="${esc(k)}">${esc(labelFor(k))}</option>`;
  let html = mainKeys.map(optHtml).join('');
  if(researchGroupKeys.length){
    html += `<optgroup label="Research">${researchGroupKeys.map(optHtml).join('')}</optgroup>`;
  }
  sel.innerHTML = html;
  sel.value = mainKeys.includes('Portfolio') ? 'Portfolio' : (mainKeys[0] || sel.options[0]?.value);
  sel.style.display='';

  sel.onchange=()=>{
    const f=fillDates(groups,sel.value,dateSel);
    if(f) apiJson(reportUrl(f)).then(load).catch(err=>setViewerError('Report konnte nicht geladen werden: '+err.message));
  };
  if(dateSel) dateSel.onchange=()=>{
    if(dateSel.value) apiJson(reportUrl(dateSel.value)).then(load).catch(err=>setViewerError('Report konnte nicht geladen werden: '+err.message));
  };
  return fillDates(groups,sel.value,dateSel);
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

// Shared "explain this" popup -- same look/dismiss behaviour used by the
// row-sheet's .rs-metric dblclick handler and (below) table column headers,
// which have no hover on touch so title= alone is unreachable there.
function showExplainPopup(anchorEl, text){
  if(!text) return;
  document.getElementById('rs-explain-popup')?.remove();
  const popup=document.createElement('div');
  popup.id='rs-explain-popup'; popup.className='rs-explain-popup';
  popup.textContent=text;
  const rect=anchorEl.getBoundingClientRect();
  popup.style.top=(rect.bottom+4)+'px';
  popup.style.left=Math.max(8,Math.min(rect.left,window.innerWidth-244))+'px';
  document.body.appendChild(popup);
  const dismiss=ev=>{ if(!popup.contains(ev.target)){popup.remove();document.removeEventListener('click',dismiss,true);} };
  setTimeout(()=>document.addEventListener('click',dismiss,true),0);
}

function renderHead(cols){
  cols=cols||COLS;
  const tr=document.createElement('tr');
  cols.forEach((c)=>{
    const th=document.createElement('th');
    const key = c[0];
    th.textContent = key + (sortKey===key? (sortDir>0?' ▲':' ▼'):'');
    const desc = explainFor(key);
    if (desc) th.title = desc;   // desktop hover help
    th.onclick=()=>{ if(sortKey===key) sortDir=-sortDir; else {sortKey=key; sortDir=1;} if(DATA) renderOverview(); };
    // Touch has no hover: doppeltippen reuses the row-sheet's explain-popup
    // pattern instead (single tap keeps sorting, unchanged).
    if (desc) th.ondblclick=(e)=>{ e.stopPropagation(); showExplainPopup(th, desc); };
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
  // Order column: sort buy > sell > none (v is the order_hint object, not a scalar)
  if(key==='Order'){ const d=orderDirection(r); return d==='buy'?2:(d==='sell'?1:0); }
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
  const skipCols=new Set(['Ticker','Name','Cons.','Order']); // Order has its own dedicated section below (with rationale)
  // ISIN/proxy: Input/Portfolio.csv metadata columns, passed through onto
  // holding.isin/holding.proxy by main.py/scanner/report.py -- absent for
  // non-holdings (Watchlist/research rows have no holding at all). Unset
  // columns round-trip through pandas/JSON as the literal string "nan"
  // (existing backend quirk, not a PWA bug) -- isIsin() rejects that for
  // isin; proxy has no format check, so it needs an explicit nan guard.
  const holdingProxy = r.holding && r.holding.proxy;
  const isinTile = (r.holding && isIsin(r.holding.isin)) ? `<div class="rs-metric"><span class="rs-metric-label">ISIN</span>
    <span class="rs-metric-value">${esc(r.holding.isin)} ${copyBtnHtml(r.holding.isin)}</span></div>` : '';
  const proxyTile = (holdingProxy && String(holdingProxy).toLowerCase()!=='nan') ? `<div class="rs-metric"><span class="rs-metric-label">Kurs via</span>
    <span class="rs-metric-value">${esc(holdingProxy)}</span></div>` : '';
  const metricsHtml=isinTile+proxyTile+COLS.filter(c=>!skipCols.has(c[0])&&!(c[4]&&c[4].panelCol))
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
  // on the production ML signal) -- see functions/order_hint.py. Same green/red
  // buy/sell coloring as the Order column in Übersicht (orderCell/orderDirection).
  const oh = r.order_hint;
  const orderDir = orderDirection(r);
  const orderCls = orderDir==='buy' ? 'pos' : (orderDir==='sell' ? 'neg' : '');
  // Opposite-direction level: r.order_hints ({buy,sell}, backend's
  // order_hint.py order_hints_both()) carries real limit/market levels for
  // BOTH directions on every held ticker -- the tile above already shows
  // today's ML-signal-driven direction, this adds the other side beneath it.
  // Falls back to nothing when order_hints is absent (stale pre-upgrade
  // report) or the direction is ambiguous (no clear buy/sell signal, so
  // there's no defined "opposite" of the primary tile).
  const oppDir = orderDir==='buy' ? 'sell' : (orderDir==='sell' ? 'buy' : null);
  const oppHint = (oppDir && r.order_hints) ? localizeOrderHint(r.order_hints[oppDir], oppDir) : null;
  const oppLabel = oppDir==='buy' ? 'Kauf-Limit' : 'Verkauf-Limit';
  const oppHtml = oppHint ? `<div class="rs-metric"><span class="rs-metric-label">${esc(oppLabel)}</span><span class="rs-metric-value num ${oppDir==='buy'?'pos':'neg'}">${esc(oppHint.type==='market'?'Market':'Limit')}${oppHint.price!=null?(' @ '+oppHint.price):''}</span></div>` : '';
  const orderHtml = oh ? `<div class="row-sheet-section">
    <div class="row-sheet-section-label">Ordervorschlag</div>
    <div class="rs-metrics">
      <div class="rs-metric"><span class="rs-metric-label">Order</span><span class="rs-metric-value num ${orderCls}">${esc(oh.type==='market'?'Market':'Limit')}${oh.price!=null?(' @ '+oh.price):''}</span></div>
      ${oppHtml}
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
  wireCopyButtons(sheet);
  const close=()=>{backdrop.remove();sheet.remove();};
  backdrop.addEventListener('click',close);
  sheet.querySelector('.row-sheet-chart-btn').addEventListener('click',()=>{
    close(); select(ticker); window.dispatchEvent(new CustomEvent('pwa:navigate',{detail:'charts'}));
  });
  sheet.querySelectorAll('.rs-metric').forEach(tile=>{
    tile.addEventListener('dblclick',e=>{
      e.stopPropagation();
      const key=(tile.querySelector('.rs-metric-label')||{}).textContent||'';
      showExplainPopup(tile, explainFor(key));
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

// Root-caused 2026-07-11: "auto doesn't switch to compact on a phone" reports
// were never a bug in isPortrait()/renderCompact() (verified working whenever
// getTableVariant()==='auto') -- they're an explicit 'classic' choice made on
// a previous (desktop) session, persisted via localStorage, silently
// outranking auto-detection with no visible explanation. Surface that instead
// of trying to override a deliberate user choice.
function renderVariantMismatchHint(v){
  const el = $('#variant-mismatch-hint');
  if(!el) return;
  if(v!=='classic' || !isPortrait()){ el.style.display='none'; return; }
  el.style.display='';
  el.innerHTML = 'Klassische Ansicht ist manuell festgelegt (Info → Darstellung) und bleibt auf diesem Gerät aktiv. <a href="#" id="variant-switch-compact">Zu Kompakt wechseln</a>';
  el.querySelector('#variant-switch-compact').onclick = e=>{
    e.preventDefault();
    try{ localStorage.setItem(TABLE_VARIANT_KEY, 'auto'); }catch{}
    const sel = $('#table-variant-sel'); if(sel) sel.value = 'auto';
    window.dispatchEvent(new CustomEvent('pwa:table-variant'));
  };
}

function renderOverview(){
  const v=getTableVariant();
  renderVariantMismatchHint(v);
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
// see scripts/alloc_live.py HYBRID_METRICS/SCHEME5_METRICS).
function metricsBoxHtml(m){
  if(!m) return '';
  const cagr   = isNum(m.cagr_pct)  ? fPct(m.cagr_pct/100)  : '—';
  const maxdd  = isNum(m.maxdd_pct) ? fPct(m.maxdd_pct/100) : '—';
  const sharpe = isNum(m.sharpe)    ? m.sharpe.toFixed(2)   : '—';
  // Backtest window the headline metrics are measured over (producer-supplied,
  // per scheme — see alloc_live.py *_METRICS). Shown so the numbers aren't read
  // as forward/live figures.
  const period = m.period ? `<span class="alloc-metrics-period">Backtest ${esc(m.period)}</span>` : '';
  return `<div class="alloc-totals alloc-metrics">
    <span>CAGR <b>${cagr}</b></span>
    <span>MaxDD <b>${maxdd}</b></span>
    <span>Sharpe <b>${sharpe}</b></span>
    ${period}
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
  const schemeSel=$('#alloc-scheme-sel'), tradesEl=$('#alloc-trades');

  if(!a){
    if(metaEl){ metaEl.style.display=''; metaEl.textContent='Allokation nicht verfügbar.'; }
    if(hybridEl){ hybridEl.style.display='none'; hybridEl.innerHTML=''; }
    if(tbl) tbl.style.display='none';
    if(footEl){ footEl.style.display='none'; footEl.innerHTML=''; }
    if(schemeSel) schemeSel.style.display='none';
    if(tradesEl){ tradesEl.style.display='none'; tradesEl.innerHTML=''; }
    return;
  }

  if(schemeSel) schemeSel.style.display='';
  const scheme = (schemeSel && schemeSel.value) || 'hybrid';
  const block = a.schemes && a.schemes[scheme];

  if(metaEl){
    metaEl.style.display='';
    // Every scheme block (scheme5 included) carries its own label + research
    // flag under a.schemes[scheme] -- uniform since the producer's 2026-07-16
    // reshape (previously scheme5's label lived at the payload root, the one
    // exception to this pattern).
    const schemeLabel = block && block.label;
    const researchBadge = (block && block.research)
      ? ' <span class="alloc-research-badge">Research</span>' : '';
    const activeBadge = getActiveScheme()===scheme
      ? ' <span class="badge-active" style="color:#4ade80;font-weight:600;">● AKTIV</span>' : '';
    metaEl.innerHTML = `<b>${esc(schemeLabel||'')}</b> &nbsp;·&nbsp; ${esc(fmtDate(a.asof||''))} &nbsp;·&nbsp; ${esc(a.currency||'')}${researchBadge}${activeBadge}`;
  }

  const activateBtn = $('#alloc-activate-btn');
  if(activateBtn){
    activateBtn.style.display='';
    const isActive = getActiveScheme()===scheme;
    activateBtn.textContent = isActive ? '✓ Aktiv' : 'Aktivieren';
    activateBtn.disabled = isActive;
    activateBtn.className = isActive ? 'active' : '';
  }

  if(hybridEl){
    const positionsBlock = (block && Array.isArray(block.positions)) ? block : null;
    if(positionsBlock){
      hybridEl.style.display='';
      hybridEl.innerHTML = renderHybridHtml(positionsBlock);
    } else {
      hybridEl.style.display='none';
      hybridEl.innerHTML='';
    }
  }

  if(tbl) tbl.style.display = scheme==='scheme5' ? '' : 'none';
  if(scheme==='scheme5'){
    const tr=document.createElement('tr');
    ALLOC_COLS.forEach(([label])=>{ const th=document.createElement('th'); th.textContent=label; tr.appendChild(th); });
    const thead=$('#alloc-tbl thead'); thead.innerHTML=''; thead.appendChild(tr);

    const sleeves = ((block && block.sleeves)||[]).slice().sort((x,y)=>
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
  }

  if(footEl){
    if(scheme==='scheme5'){
      footEl.style.display='';
      const caveats = Array.isArray(block && block.caveats) ? block.caveats.map(c=>`<li>${esc(c)}</li>`).join('') : '';
      footEl.innerHTML = `
        <div class="alloc-totals">
          <span><b>${fPct(((block && block.in_1x_twins_pct)||0)/100)}</b> in 1× Twins</span>
          <span><b>${fPct(((block && block.cash_money_market_pct)||0)/100)}</b> CHF Geldmarkt</span>
        </div>
        <p class="hint alloc-hint">${esc((block && block.derisk_rule)||'')}</p>
        <p class="hint alloc-hint">${esc((block && block.cash_destination)||'')}</p>
        ${caveats?`<ul class="alloc-caveats">${caveats}</ul>`:''}
      `;
    } else {
      // hybrid/techheavy: their own note+metrics are already inside
      // renderHybridHtml (hybridEl above) -- nothing scheme5-specific to add here.
      footEl.style.display='none';
      footEl.innerHTML='';
    }
  }

  // Trade recommendation — needs the Portfolio list's real holdings + the
  // exclusion list, both fetched independently of whatever list/report is
  // currently open in Übersicht.
  if(tradesEl){
    tradesEl.style.display='';
    tradesEl.innerHTML = '<p class="hint">Trades werden berechnet…</p>';
    Promise.all([ensurePortfolioHoldings(), ensurePortfolioExclude()]).then(()=>{
      // Guard against a stale async response landing after the user switched
      // scheme or navigated away from the sub-tab.
      if(!$('#alloc-trades') || ($('#alloc-scheme-sel')||{}).value !== scheme) return;
      tradesEl.innerHTML = renderTradesHtml(computeSchemeTrades(scheme));
    });
  }

  const addCashPanel = $('#alloc-addcash-panel');
  if(addCashPanel) addCashPanel.style.display = '';
  renderAddCash();
}

// Recompute + render the "Neue Einzahlung" (add-cash) block from the current
// #alloc-addcash input value. Independent trigger from renderAllocation()
// (also called directly by the debounced input listener) so typing doesn't
// re-fetch/re-render the whole Allokation sub-tab.
function renderAddCash(){
  const out = $('#alloc-addcash-out');
  const input = $('#alloc-addcash');
  const schemeSel = $('#alloc-scheme-sel');
  if(!out || !input) return;
  const raw = input.value.trim();
  if(!raw){ out.innerHTML=''; return; }
  // Input is type="text" (not "number") so a leading "-" for a withdrawal is
  // typable on mobile keypads that hide the minus key. Parse leniently: accept
  // a comma decimal separator and CH thousands apostrophes/spaces.
  const typed = Number(raw.replace(/[’'\s]/g, '').replace(',', '.'));
  if(!isNum(typed) || typed === 0){ out.innerHTML=''; return; }
  const scheme = (schemeSel && schemeSel.value) || 'hybrid';
  // Negative amount = withdrawal (computeWithdrawal), positive = add-cash
  // (computeAddCash) -- same input, same debounced trigger, opposite flow.
  const isWithdrawal = typed < 0;

  out.innerHTML = '<p class="hint">Wird berechnet…</p>';
  Promise.all([ensurePortfolioHoldings(), ensurePortfolioExclude()]).then(()=>{
    // Guard against a stale async response landing after the user changed
    // the input, switched scheme, or navigated away from the sub-tab.
    if(!$('#alloc-addcash-out') || ($('#alloc-scheme-sel')||{}).value !== scheme) return;
    const fx = portfolioHoldingsData && portfolioHoldingsData.fx;
    const cashChf = toCHF(Math.abs(typed), getCurrency(), fx);
    if(!isNum(cashChf) || cashChf <= 0){ out.innerHTML=''; return; }
    out.innerHTML = isWithdrawal
      ? renderWithdrawalHtml(computeWithdrawal(scheme, cashChf))
      : renderAddCashHtml(computeAddCash(scheme, cashChf));
  });
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
    b.onclick=()=>{
      viewLen=n; renderRanges(); draw();
      // Full range: deep-fetch (cached, at most once per ticker) then redraw
      // with the swapped-in series -- see ensureFullSeries().
      if(lbl==='Full' && selected) ensureFullSeries(selected).then(()=>{ if(chartsVisible) draw(); });
    };
    box.appendChild(b); });
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
      // Redraw the Digest perf graph using cached data (currency-formatted)
      const combined = perfCache.get('__digest_combined__');
      if(combined) drawPerf(combined);
      if(allocationData) renderAllocation(); // trade amounts are currency-formatted too
    });
  }

  // Allokation sub-tab: scheme selector re-renders the scheme block + trades
  const schemeSel = $('#alloc-scheme-sel');
  if(schemeSel) schemeSel.addEventListener('change', () => { if(allocationData) renderAllocation(); });

  // "Aktivieren" — mark the currently-viewed scheme as the one actually being
  // followed (local label only, see getActiveScheme/setActiveScheme).
  const activateBtn = $('#alloc-activate-btn');
  if(activateBtn){
    activateBtn.addEventListener('click', () => {
      const cur = ($('#alloc-scheme-sel')||{}).value || 'hybrid';
      setActiveScheme(cur);
      if(allocationData) renderAllocation();
    });
  }

  // Add-cash input — debounced recompute, independent of the full renderAllocation()
  let _addCashTimer = null;
  const addCashInput = $('#alloc-addcash');
  if(addCashInput) addCashInput.addEventListener('input', () => {
    clearTimeout(_addCashTimer);
    _addCashTimer = setTimeout(renderAddCash, 250);
  });

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

  // Initialize from the current DOM: the restored tab (localStorage 'pwa.stocks.tab')
  // may already be Digest or Charts, whose pwa:tab event fired during initTabs()
  // synchronously on page load, before this listener existed to catch it.
  chartsVisible = document.getElementById('page-charts')?.classList.contains('active') || false;
  if(document.getElementById('page-digest')?.classList.contains('active')) loadDigestPerf();
  // Track Charts tab visibility — hidden page has clientWidth==0.
  window.addEventListener('pwa:tab', e=>{
    // A chart hover tooltip has no natural "leave" event when the user taps a
    // bottom-nav tab instead of moving the pointer off the canvas — onLeave()
    // never fires, so #tip stays visible, floating over whatever tab opens next.
    const tip = $('#tip'); if (tip) tip.style.display = 'none';
    hoverIdx = null;
    chartsVisible = e.detail === 'charts';
    if(chartsVisible && selected){ lastW=0; draw(); }
    // Load/redraw the Digest perf graph when the Digest tab becomes visible
    // (was hidden → zero clientWidth, or first visit).
    if(e.detail === 'digest') loadDigestPerf();
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
      // Redraw the Digest perf graph on resize (Digest tab may be visible)
      const combined = perfCache.get('__digest_combined__');
      const perfWrap = $('#perf-wrap');
      if(combined && perfWrap && perfWrap.style.display !== 'none') drawPerf(combined);
      if(!chartsVisible || !selected) return;
      const w = ($('#c-price')||{}).clientWidth || 0;
      if(w !== lastW){ lastW=w; draw(); }
    }, 120);
  });
}
