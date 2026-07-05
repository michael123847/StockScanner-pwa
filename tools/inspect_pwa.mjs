/**
 * inspect_pwa.mjs — Headless inspector for the StockScanner PWA.
 *
 * The PWA is a set of static ES modules in ../public that normally talk to the
 * companion API (:3001, Bearer-gated, no CORS) which only serves same-origin.
 * That combination — token gate + no CORS + Chrome's Default-profile CDP lock —
 * is why the running app can't easily be screenshotted for a look.
 *
 * This tool sidesteps all of it: it serves ../public itself and fulfils every
 * /api/stocks/* request from the on-disk Output/*.json reports via Playwright
 * request interception. No token, no CORS, no live server, no Chrome profile —
 * the real PWA UI renders against real report data in a throwaway context.
 *
 * Usage (from the PWA repo root, after `npm install`):
 *   node tools/inspect_pwa.mjs                       # newest Portfolio report
 *   node tools/inspect_pwa.mjs --list=Watchlist      # pick a list
 *   node tools/inspect_pwa.mjs --report=20260702_Portfolio.json
 *   node tools/inspect_pwa.mjs --tab=Allokation      # switch bottom tab
 *   node tools/inspect_pwa.mjs --headed --wait=4000  # watch it live
 *   node tools/inspect_pwa.mjs --out=C:/tmp/pwa.png
 *   SS_OUTPUT=C:/Projects/StockScanner/Output node tools/inspect_pwa.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PWA_ROOT   = path.resolve(__dirname, '..', 'public');
const OUTPUT_DIR = process.env.SS_OUTPUT || 'C:/Projects/StockScanner/Output';
const INPUT_DIR  = process.env.SS_INPUT  || 'C:/Projects/StockScanner/Input';

// ── CLI args (--flag or --key=value) ─────────────────────────────────────────
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const OUT     = args.out || path.resolve(__dirname, 'pwa_shot.png');
const HEADED  = !!args.headed;
const WAIT_MS = Number(args.wait || 1800);
const LIST    = args.list || null;      // portfolio name, e.g. Watchlist
const REPORT  = args.report || null;    // exact file, e.g. 20260702_Portfolio.json
const TAB     = args.tab || null;       // bottom-tab label, e.g. Charts
const TICKER  = args.ticker || null;    // chart-view ticker, e.g. DCUSAS.SW
const FILTER  = args.filter || null;    // text to type into #filter (debounce test)
const PORT    = Number(args.port || 5177);
// Endpoints to force to HTTP 404 — exercises missing-data paths such as the
// apiJson() over-invalidation fix. e.g. SS_DROP=allocation,series
const DROP    = new Set((process.env.SS_DROP || '').split(',').map(s => s.trim()).filter(Boolean));

// ── Tiny static server for ../public ─────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json',
};
const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    // Neutralise the service worker so its shell cache can't shadow our routes.
    if (p === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end('/* service worker disabled for inspector */');
    }
    const fp = path.join(PWA_ROOT, p);
    if (!fp.startsWith(PWA_ROOT) || !existsSync(fp)) { res.writeHead(404); return res.end('not found'); }
    const body = await readFile(fp);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${PORT}`;

// ── Output/ readers ──────────────────────────────────────────────────────────
const readJson = async name => JSON.parse(await readFile(path.join(OUTPUT_DIR, name), 'utf-8'));
const jres = (route, obj, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
const nowIso = new Date().toISOString();

// Minimal CSV → array-of-row-objects, mirroring server.js's csvParse() shape
// (GET /api/stocks/portfolio returns this directly, not wrapped in {tickers:}).
// No quote-escaping support — Input/*.csv here doesn't need it.
function csvParse(str) {
  if (!str || !str.trim()) return [];
  const lines = str.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length <= 1) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] !== undefined ? vals[i].trim() : ''; });
    return obj;
  });
}

// ── Launch ───────────────────────────────────────────────────────────────────
// --mobile — emulate the app's primary real-world device (phone, portrait).
const VIEWPORT = args.mobile ? { width: 390, height: 844 } : { width: 1400, height: 1000 };
const browser = await chromium.launch({ headless: !HEADED });
const context = await browser.newContext({
  viewport: VIEWPORT, ignoreHTTPSErrors: true,
  ...(args.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : {}),
});

// Seed the shared token + active base BEFORE any page script runs, so the app
// treats itself as connected and skips the setup card.
await context.addInitScript(origin => {
  try {
    localStorage.setItem('pwa.stocks.token', 'inspector-token');
    localStorage.setItem('pwa.activeBase', origin);
    localStorage.setItem('pwa.bases', JSON.stringify({}));
  } catch { /* ignore */ }
}, ORIGIN);

// Fulfil every API call from disk. Matches any host (server.local, LAN, etc.)
// because the app may pick any base — interception happens before DNS.
await context.route('**/api/stocks/**', async route => {
  const u  = new URL(route.request().url());
  const ep     = u.pathname.replace(/.*\/api\/stocks\//, '');
  const method = route.request().method();
  try {
    if (DROP.has(ep) || DROP.has(ep.split('.')[0])) return jres(route, { error: 'dropped' }, 404);
    // Mutating requests (Speichern / Jetzt scannen / Export / list add-delete)
    // are mocked, never persisted — this tool only ever reads Input/Output.
    if (method === 'PUT' && ep === 'portfolio') {
      let n = 0;
      try { n = JSON.parse(route.request().postData() || '[]').length; } catch {}
      return jres(route, { count: n });
    }
    if (method === 'POST' && (ep === 'run' || ep === 'export')) return jres(route, { ok: true });
    if (method !== 'GET') return jres(route, { ok: true });
    if (ep === 'health')  return jres(route, { ok: true, running: false, lastRun: nowIso, lastExit: 0, nextRun: nowIso });
    if (ep === 'config')  return jres(route, { bases: {} });
    if (ep === 'status')  return jres(route, { running: false, lastRun: nowIso, lastExit: 0, nextRun: nowIso });
    if (ep === 'index')   return jres(route, await readJson('index.json'));
    if (ep === 'lists') {
      const idx  = await readJson('index.json');
      const keys = [...new Set(idx.map(e => e.portfolio).filter(Boolean))];
      return jres(route, keys.map(k => ({ key: k, label: k, builtin: k === 'Portfolio' || k === 'Watchlist' })));
    }
    if (ep === 'allocation') {
      const f = path.join(OUTPUT_DIR, 'allocation_scheme5.json');
      return existsSync(f) ? jres(route, JSON.parse(await readFile(f, 'utf-8'))) : jres(route, {}, 404);
    }
    if (ep === 'metrics') {
      const f = path.join(OUTPUT_DIR, 'backtest_metrics.json');
      return existsSync(f) ? jres(route, JSON.parse(await readFile(f, 'utf-8'))) : jres(route, {}, 404);
    }
    if (ep === 'portfolio_exclude') {
      const f = path.join(INPUT_DIR, 'Portfolio_exclude.csv');
      const tickers = existsSync(f) ? csvParse(await readFile(f, 'utf-8')) : [];
      return jres(route, { tickers });
    }
    if (ep === 'research_lists') {
      const dir = path.join(INPUT_DIR, 'research');
      let files = [];
      try { files = readdirSync(dir); } catch {}
      const keys = files.filter(f => f.endsWith('.csv') && !f.startsWith('_')).map(f => f.slice(0, -4)).sort();
      return jres(route, keys.map(key => ({ key, label: key.replace(/_/g, ' ') })));
    }
    if (ep === 'report') {
      const file = u.searchParams.get('file');
      if (file) {
        const f = path.join(OUTPUT_DIR, path.basename(file));
        return existsSync(f)
          ? jres(route, JSON.parse(await readFile(f, 'utf-8')))
          : jres(route, { error: 'not found' }, 404);
      }
      // ?list=&asof= lazy form: the real server spawns `main.py --emit`; this
      // inspector can't, so fall back to the newest already-emitted report for
      // that list (good enough to exercise the "fresh research list" UI flow).
      const list = u.searchParams.get('list');
      if (!list) return jres(route, { error: 'list required' }, 400);
      let files = [];
      try { files = readdirSync(OUTPUT_DIR); } catch {}
      const matches = files.filter(fn => new RegExp(`^\\d{8}_${list}\\.json$`).test(fn)).sort().reverse();
      if (!matches.length) return jres(route, { error: 'not found' }, 404);
      return jres(route, JSON.parse(await readFile(path.join(OUTPUT_DIR, matches[0]), 'utf-8')));
    }
    if (ep.startsWith('digest')) {
      const md = ep.includes('.md');
      const f  = path.join(OUTPUT_DIR, md ? 'digest_latest.md' : 'digest_latest.txt');
      const body = existsSync(f) ? await readFile(f, 'utf-8') : '(no digest on disk)';
      return route.fulfill({ status: 200, contentType: md ? 'text/markdown' : 'text/plain', body });
    }
    if (ep === 'series') {
      const list   = u.searchParams.get('list');
      const ticker = u.searchParams.get('ticker');
      const f = list && path.join(OUTPUT_DIR, 'series', path.basename(list) + '.json');
      if (!f || !existsSync(f)) return jres(route, { error: 'series store not found' }, 404);
      const store = JSON.parse(await readFile(f, 'utf-8'));
      const all = store.tickers || {};
      if (ticker) {
        return all[ticker]
          ? jres(route, { ticker: all[ticker] })
          : jres(route, { error: 'ticker not in store' }, 404);
      }
      return jres(route, store);
    }
    if (ep === 'search') {
      // Fake Yahoo-lookup result so the search-box → click-result → add-row
      // flow is exercisable end-to-end (real endpoint hits the network).
      const q = (u.searchParams.get('q') || '').trim();
      if (!q) return jres(route, []);
      return jres(route, [{ symbol: q.toUpperCase(), name: `${q.toUpperCase()} (fake search result)`, exchange: 'TEST' }]);
    }
    if (ep === 'portfolio_series') {
      const list = u.searchParams.get('list') || 'Portfolio';
      const f = path.join(OUTPUT_DIR, 'series', path.basename(list) + '.perf.json');
      return existsSync(f) ? jres(route, JSON.parse(await readFile(f, 'utf-8'))) : jres(route, {}, 404);
    }
    if (ep === 'portfolio') {
      // Mirrors server.js's resolveListStem(): root Input/<key> if it exists,
      // else Input/research/<key> — returns the parsed array directly
      // (portfolio.js calls .map() on the response).
      const list = u.searchParams.get('list') || 'Portfolio';
      const key  = path.basename(list);
      let base = path.join(INPUT_DIR, key);
      if (!existsSync(base + '.csv') && !existsSync(base + '.json')) {
        base = path.join(INPUT_DIR, 'research', key);
      }
      if (existsSync(base + '.csv')) return jres(route, csvParse(await readFile(base + '.csv', 'utf-8')));
      if (existsSync(base + '.json')) return jres(route, JSON.parse(await readFile(base + '.json', 'utf-8')));
      return jres(route, { error: 'not found' }, 404);
    }
    // search (Yahoo lookup) → benign empty
    return jres(route, []);
  } catch (e) {
    return jres(route, { error: String(e) }, 500);
  }
});

const page = await context.newPage();
const logs = [];
page.on('console',   m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

await page.goto(ORIGIN, { waitUntil: 'networkidle' });

// Optional: pick a specific list or an exact report file.
if (REPORT) {
  await page.evaluate(f => {
    const d = document.querySelector('#report-date');
    if (d && [...d.options].some(o => o.value === f)) { d.value = f; d.dispatchEvent(new Event('change')); }
  }, REPORT).catch(() => {});
} else if (LIST) {
  await page.selectOption('#report', LIST).catch(() => {});
}
if (TAB) {
  // Bottom-nav tabs are .tab-btn[data-page="<lowercase>"] (tabs.js) — match that
  // exactly first. Text-based fallback can otherwise hit an unrelated same-text
  // element rendered earlier in the DOM (e.g. the "Portfolio" *list* tab inside
  // #pf-list-tabs, which precedes the bottom nav and also says "Portfolio").
  const hit = await page.locator(`.tab-btn[data-page="${TAB.toLowerCase()}"]`).first().click({ timeout: 1000 }).then(() => true).catch(() => false);
  if (!hit) await page.locator(`[data-tab="${TAB}"], button:has-text("${TAB}"), a:has-text("${TAB}")`).first().click().catch(() => {});
}
if (TICKER) {
  await page.selectOption('#chart-ticker', TICKER).catch(() => {});
  await page.waitForTimeout(300);
}
// --click="14d,Kerzen" — click a sequence of controls by visible text (window
// buttons, chart-type toggle, etc.) to exercise interactions.
if (args.click) {
  for (const label of String(args.click).split(',').map(s => s.trim()).filter(Boolean)) {
    await page.locator(`button:has-text("${label}"), .btn:has-text("${label}")`).first().click().catch(() => {});
    await page.waitForTimeout(250);
  }
}
if (FILTER) {
  await page.fill('#filter', FILTER).catch(() => {});
  await page.waitForTimeout(400); // let the 150 ms debounce settle
}
// --toggle="#chk-dp,#chk-mllive" — click elements by raw CSS selector (for
// checkboxes / controls that --click's text-match can't reach).
if (args.toggle) {
  for (const sel of String(args.toggle).split(',').map(s => s.trim()).filter(Boolean)) {
    await page.click(sel).catch(() => {});
    await page.waitForTimeout(150);
  }
}
// --select="#table-preset-sel=allocation,#currency-sel=USD" — set <select> values.
if (args.select) {
  for (const pair of String(args.select).split(',').map(s => s.trim()).filter(Boolean)) {
    const [sel, val] = pair.split('=');
    await page.selectOption(sel, val).catch(() => {});
    await page.waitForTimeout(150);
  }
}
// --type="#pf-search-input=AAPL" — fill an arbitrary input/textarea by selector.
if (args.type) {
  for (const pair of String(args.type).split(',').map(s => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf('=');
    await page.fill(pair.slice(0, eq), pair.slice(eq + 1)).catch(() => {});
    await page.waitForTimeout(200);
  }
}
// --reload — full page reload after all the above, to check localStorage-backed
// prefs (chart type, overlay/rec checkboxes, token, active base) survive a cold
// boot the same way they were left, not just within one live session.
if (args.reload) {
  await page.reload({ waitUntil: 'networkidle' });
  if (TAB) await page.locator(`[data-tab="${TAB}"], button:has-text("${TAB}"), a:has-text("${TAB}")`).first().click().catch(() => {});
  if (TICKER) await page.selectOption('#chart-ticker', TICKER).catch(() => {});
  await page.waitForTimeout(300);
}
await page.waitForTimeout(WAIT_MS);
await page.screenshot({ path: OUT, fullPage: true });

// --eval="<js expression>" — evaluate in page context and print the JSON result.
// For layout forensics (scrollWidth vs clientWidth, computed styles, …).
if (args.eval) {
  try {
    const result = await page.evaluate(String(args.eval));
    console.log('eval result  :', JSON.stringify(result, null, 2));
  } catch (e) {
    console.log('eval error   :', e.message);
  }
}

const summary = await page.evaluate(() => ({
  title:  document.title,
  report: document.querySelector('#report')?.value || null,
  date:   document.querySelector('#report-date')?.value || null,
  rows:   document.querySelectorAll('#tbl tbody tr').length,
  err:    document.querySelector('#viewer-error, .error, #offline.visible')?.textContent?.trim() || null,
  recLegend: document.querySelector('#lg-rec')?.textContent?.trim() || null,
  checks: [...document.querySelectorAll('#rec-checks input[type=checkbox], #overlay-checks input[type=checkbox]')]
    .map(el => `${el.id}=${el.checked}`).join(' '),
}));

console.log('=== PWA inspector ===');
console.log('origin       :', ORIGIN);
console.log('output dir   :', OUTPUT_DIR);
console.log('screenshot   :', OUT);
console.log('report shown :', summary.report, summary.date ? `(${summary.date})` : '', '| table rows:', summary.rows);
if (summary.err) console.log('viewer notice:', summary.err);
if (summary.recLegend != null) console.log('rec legend   :', summary.recLegend);
if (summary.checks) console.log('checkboxes   :', summary.checks);
const errs = logs.filter(l => /\[error\]|pageerror|failed|uncaught/i.test(l));
console.log(`console msgs : ${logs.length} total, ${errs.length} error-level`);
errs.slice(0, 15).forEach(l => console.log('   ', l));

await browser.close();
server.close();
