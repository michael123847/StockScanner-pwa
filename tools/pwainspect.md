# Inspecting the StockScanner PWA

Why this needs a document: the running app can't simply be opened and screenshotted.
The PWA is static ES modules (`public/`) talking to the companion API (`:3001`),
which is Bearer-token-gated, same-origin only (no CORS), and the user's Chrome
profile holds the token behind a CDP lock. Every inspection method below sidesteps
that triad the same way: **serve `public/` yourself and answer `/api/stocks/*` from
the real on-disk `StockScanner/Output/*.json` files** — real UI, real data, no
token, no live server, and read-only by construction.

There are two tools. Use the first unless you specifically need the second.

---

## 1. `tools/inspect_pwa.mjs` — headless Playwright inspector (primary)

The repo's purpose-built tool. Serves `../public` on `:5177`, neutralises the
service worker (`/sw.js` → empty stub so the shell cache can't shadow routes),
seeds `localStorage` (`pwa.stocks.token`, `pwa.activeBase`) via an init script so
the setup card never appears, and fulfils every `/api/stocks/*` request from disk
via Playwright request interception — any host, because interception happens
before DNS. Mutating requests (PUT portfolio, POST run/export) are mocked and
never persisted.

```
node tools/inspect_pwa.mjs                            # newest Portfolio report, desktop shot
node tools/inspect_pwa.mjs --list=Watchlist           # pick a list
node tools/inspect_pwa.mjs --report=20260702_Portfolio.json
node tools/inspect_pwa.mjs --tab=Allokation           # bottom-nav tab by label
node tools/inspect_pwa.mjs --mobile                   # 390x844, touch, DPR 3
node tools/inspect_pwa.mjs --headed --wait=4000       # watch it live
node tools/inspect_pwa.mjs --out=tools/final_backtest.png
SS_OUTPUT=C:/Projects/StockScanner/Output node tools/inspect_pwa.mjs
```

Interaction flags (all optional, applied in this order: report/list → tab →
ticker → click → filter → toggle → select → type → reload → screenshot):

| Flag | Meaning |
|---|---|
| `--tab=Charts` | click a bottom-nav tab (`.tab-btn[data-page=…]`, text fallback) |
| `--ticker=DCUSAS.SW` | select in `#chart-ticker` |
| `--click="14d,Kerzen"` | click buttons by visible text, in sequence |
| `--toggle="#chk-dp,#chk-mllive"` | click by raw CSS selector (checkboxes) |
| `--select="#table-preset-sel=backtest,#currency-sel=USD"` | set `<select>` values |
| `--type="#pf-search-input=AAPL"` | fill an input |
| `--filter=text` | type into `#filter` (tests the 150 ms debounce) |
| `--reload` | full reload after the above — proves localStorage prefs survive cold boot |
| `--eval="<js>"` | evaluate in page context, print JSON — layout forensics |
| `SS_DROP=allocation,series` | force endpoints to 404 — exercises missing-data paths |

Every run prints a summary (report shown, table rows, viewer error if any,
checkbox states) plus console-message counts with error lines — check that
before trusting the screenshot.

**Screenshot naming convention** (see the ~60 PNGs in this directory):
iterate-then-confirm. Prefix shots by feature (`bt_desktop`, `bt_indices`,
`bt_mobile`, `bt_rowsheet`…), fix the source between shots, and when the last
one is clean save it as `final_<feature>.png` — the proof shot that the feature
was verified working before it was reported done.

**`--eval` layout forensics** — the pattern that finds real bugs (example from
the 2026-07-10 sweep that caught the off-screen Aktivieren button):

```
node tools/inspect_pwa.mjs --mobile --tab=Digest --eval="(() => {
  const r = s => { const e = document.querySelector(s); if(!e) return null;
    const b = e.getBoundingClientRect(); return {w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x)}; };
  return { viewport: innerWidth,
           overflow: document.documentElement.scrollWidth - innerWidth,
           sel: r('#alloc-scheme-sel'), btn: r('#alloc-activate-btn') };
})()"
```

Anything with `x >= innerWidth` is unreachable; any wrapper where
`scrollWidth - clientWidth > 0` without `overflow-x: auto` is a clipped-content
bug.

---

## 2. Live interactive session in the Claude Code browser pane (secondary)

For exploratory, many-step interactive driving (click around, measure, click
again) without composing one long CLI invocation. A prior session's recipe,
reconstructed and battle-tested 2026-07-10:

1. **Mock server**: `C:\Users\User\AppData\Local\Temp\sspwa-dev.cjs` — a
   dependency-free Node http server on `:8000` that serves `public/` and answers
   the same `/api/stocks/*` endpoint set from `Output/`/`Input/` files (GET only;
   POST/PUT → 405). Recreate it if Temp was wiped — it mirrors this file's §1
   endpoint list; the launch entry survives in the session repo's
   `.claude/launch.json` as `"sspwa"` (port 8000).
2. **Bootstrap the app** onto the mock (once per fresh browser context, via
   javascript_tool):
   ```js
   localStorage.setItem('pwa.stocks.token', 'dev-mock');          // any non-empty value
   localStorage.setItem('pwa.activeBase', 'http://localhost:8000');
   localStorage.setItem('pwa.bases', JSON.stringify({lan_ip: 'http://localhost:8000'}));
   location.reload();
   ```
   The `pwa.bases` entry matters: `probeBase()` only races *known candidates*
   (`server.local:8443` + cached bases), so localhost must be injected as one to
   win the race and be persisted.

### Pane-specific pitfalls (each cost real time — read before driving)

- **`computer` screenshots can time out** in this pane while the page is
  perfectly healthy. Don't fight it: use `read_page` for structure/text and
  `javascript_tool` for geometry. Playwright (§1) is the screenshot path.
- **Hidden tab panes measure 0.** All five main-tab panes stay in the DOM;
  `textContent` reads fine from a hidden pane but every
  `getBoundingClientRect()` in it returns 0×0. Activate the tab (click the
  `nav` button, then the sub-tab button) before measuring, or every "finding"
  is an artifact.
- **Transient offline banner**: "📵 Server nicht erreichbar" shows briefly at
  boot until the probe resolves — not a connectivity failure of the mock.
- **Service worker**: the mock does *not* stub `/sw.js` (the Playwright tool
  does). In a throwaway pane context this hasn't bitten, but if you see stale
  shell content: Info tab → "Cache leeren & neu laden", or add the same
  one-line sw stub to the mock.
- Measure with a batched JS probe rather than one call per element:
  viewport, `document.documentElement.scrollWidth - innerWidth` (page-level
  overflow), per-element rects, wrapper `scrollWidth - clientWidth`
  (needs-scroll), computed `padding`/`cursor`, and vertical gaps between
  consecutive section rects — that single pattern surfaced every finding in
  the 2026-07-10 sweep.

### What NOT to do

- Don't point any inspection at the live `:3001` API or type the real
  `STOCKS_TOKEN` anywhere — the on-disk `Output/` files *are* the API responses;
  there is never a reason to authenticate for inspection.
- Don't trust a finding measured while the wrong tab was active (see above).
- Don't leave mutating endpoints functional in a mock — both tools stub them
  deliberately.

---

## Choosing

| Need | Tool |
|---|---|
| Screenshot / proof shot | `inspect_pwa.mjs` |
| Mobile emulation (real touch/DPR) | `inspect_pwa.mjs --mobile` |
| One-shot layout probe | `inspect_pwa.mjs --eval` |
| Missing-data / 404 paths | `inspect_pwa.mjs` + `SS_DROP` |
| Long exploratory click-and-measure session | browser pane + `sspwa` mock |
| CI-ish scripted regression sweep | `inspect_pwa.mjs` in a loop |
