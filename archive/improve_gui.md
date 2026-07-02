# StockScanner PWA — Overview Table Display Variants (v1.5.0)

Self-contained implementation guide for a single Sonnet instance. Work through the phases
**in order, top to bottom**. After each phase, run the per-phase verification before moving on.
Take your time; correctness over speed. Do **not** commit/push until the final step (a prepared,
un-run git block is provided for the user).

Repo: `C:\Projects\StockScanner-pwa`. Frontend only — no backend/server/Python changes.
Vanilla JS + CSS, **no new dependencies**, match the existing terse style (`const $ = s => document.querySelector(s)`).

---

## Goal

Add a **Darstellung dropdown in the Info tab** that switches the Übersicht (overview) table
between **4 variants**, rendered client-side from the already-loaded report (no refetch):

1. **Classic** — today's full table (unchanged behaviour).
2. **Presets** — column profiles (Holdings / Signale / Technik).
3. **Compact** — 3 columns + a detail bottom-sheet on row tap.
4. **Cards** — one card per row with heatmap-coloured key metrics + detail bottom-sheet.

Default = Classic. Persist the choice in `localStorage` (`pwa.stocks.tableVariant`).
The 4 variants are the consolidation of two independent UX reviews (both ranked
Presets > Detail-Sheet > Heatmap > Scroll-polish > Cards; Cards kept because it is ideal for the
small Portfolio list).

**Scope (this phase): variants apply to the Portfolio report only.** For every other list (Watchlist,
S&P 500, etc.) the overview always renders **Classic**, regardless of the dropdown — the large-list
screening use-case stays exactly as-is for now. The dropdown is global but gated to the Portfolio
report in `renderOverview()` (see Phase 0). This bound (~10–20 holdings) is what makes per-row
sparklines feasible in the Cards variant.

---

## Invariants (must keep working in every variant)

- The filter input `#filter`, column sorting, and the report selector `#report`.
- Holdings reports (those with `DATA.fx`): the currency selector `#currency-sel`, the **Value**
  column/value, and the 200-day perf graph (`#perf-wrap` / `loadPerfAndDraw`).
- The regime badge in `#meta`, and the existing row-tap → Charts behaviour in Classic.
- Switching variant or preset **re-renders the loaded report without a network call**.
- **Non-Portfolio reports always render Classic**, regardless of the selected variant (this phase).

---

## Code you build on (read these first)

`public/src/viewer.js`
- `buildCols()` → returns `COLS`, an array of column tuples `[label, r=>value, (value,r)=>html, align, meta?]`
  where `align ∈ {'l','n','b'}` and `meta` may carry `{panelCol}` or `{isValue:true}`.
  Panel columns come from `DATA.columns` (each `{key,label,axis,badge}`); the **Value** column is
  only present when `DATA.fx` exists.
- `renderHead()` / `renderBody()` iterate `COLS` to fill `#tbl`. Row `onclick` calls `select(ticker)`
  then dispatches `pwa:navigate → 'charts'`.
- `select(ticker)` fills the Charts detail (`#d-name`, `#d-sub`), lazy-loads the series, draws.
- `glyph(cell, col)` → signal pill HTML. `convertCHF(valueCHF, currency, fx)` → formatted string.
- `load(json)` sets `DATA`, `ROWS` (`{...ticker, s:summary}`), `COLS=buildCols()`, then
  `renderHead(); renderBody();`, then shows/hides `#currency-sel` + `#perf-wrap` by `json.fx`.
- Row object `r`: `r.ticker, r.name, r.exchange, r.s` (summary fields incl. `Current_Price`, `RSI`,
  `200DMA`, `50DMA`, `Change_21D`, `Momentum`, `change_1d`, `above_200DMA`), `r.panel`,
  `r.consensus`, `r.holding` (`{value_chf,…}` on holdings reports).

`public/src/info.js` — `initInfo()`, `applyScale()`; the DARSTELLUNG dropdown pattern
(`#scale-select`, localStorage `ss.ui.scale`). Mirror this for the new variant dropdown.

`public/index.html` — `#page-overview .overview-controls` (holds `#report`, `#currency-sel`,
`#filter`), `.table-scroll > #tbl`, `#perf-wrap`; the Info tab **DARSTELLUNG** section containing
`#scale-select`.

`public/style.css` — table styles (~lines 81–100), `.glyph` (~107–117), the scale section (~217+).
`public/src/config.js` `APP_VERSION`, `public/sw.js` `VERSION` (both → `v1.5.0` at the end).

---

## Column presets (defined once, by label)

Filter `buildCols()` output by these label allowlists (Ticker cell will also show the name as a
small subtitle, so no separate Name column is needed):

- **Holdings:** `Ticker, Value, Δ1D, Δ21D, Cons.`
- **Signale:**  `Ticker, Rule, ML, Risk-Opt, Cons.`
- **Technik:**  `Ticker, RSI, 50DMA, 200DMA, Mom14`

Panel labels (`Rule, ML, Hindsight, Risk-Opt`) come from `DATA.columns[].label`; match by that
label. `Value` exists only on holdings reports. Default preset: **Holdings** when
`DATA.portfolio === 'Portfolio'` (or `DATA.fx` present), else **Signale**. Persist
`pwa.stocks.tablePreset`.

> **Sparklines — included, Portfolio-only.** Because variants apply only to the Portfolio report
> (~10–20 holdings), a per-row series fetch is cheap (reuse `ensureSeries(ticker)`), so the
> fetch-storm risk that rules sparklines out on large lists does not apply. Evidence they help:
> Tufte's sparklines ("data-intense, design-simple, word-sized graphics") and their ubiquity in
> finance dashboards (Yahoo Finance, Bloomberg, Revolut) for at-a-glance trend reading — both UX
> reviews rated them a strong enhancer and deferred them only for the breadth reason that no longer
> applies here. Heatmap colouring stays the cheap default; sparklines add the trend dimension in the
> Cards variant.

---

## Phase 0 — Variant scaffolding (Classic still the only visible behaviour)

1. `index.html`, Info tab DARSTELLUNG section (next to `#scale-select`): add a labelled
   `<select id="table-variant-sel">` with options (German):
   `classic`="Klassisch (alle Spalten)", `presets`="Profile (Holdings/Signale/Technik)",
   `compact`="Kompakt (+ Detail)", `cards`="Karten". Reuse the `.scale-select` class for styling.
   Add a small `.hint` caption under it: „Gilt aktuell nur für die Portfolio-Liste.“
2. `viewer.js`: add helpers near the top —
   `const TABLE_VARIANT_KEY='pwa.stocks.tableVariant'; const TABLE_PRESET_KEY='pwa.stocks.tablePreset';`
   `function getTableVariant(){ try{const v=localStorage.getItem(TABLE_VARIANT_KEY); if(['classic','presets','compact','cards'].includes(v))return v;}catch{} return 'classic'; }`
   and a `getPreset()/setPreset()` pair (default computed per report as above).
3. `viewer.js`: introduce `function renderOverview(){ … }` that dispatches on `getTableVariant()`:
   `classic` → existing `renderHead(); renderBody();`. (Other branches added in later phases; until
   then they fall back to classic.) Replace the `renderHead(); renderBody();` call inside `load()`
   with `renderOverview();`. Keep `renderHead`/`renderBody` intact for the classic branch.
   **Gating (important):** at the very top of `renderOverview()`, if the active report is not the
   Portfolio report — `!(DATA && DATA.portfolio === 'Portfolio')` — render the classic table and
   `return`. Only the Portfolio report honors the variant this phase; every other list stays Classic.
4. Wiring: in `info.js initInfo()`, read saved variant, set the select value, and on `change`
   save it and `window.dispatchEvent(new CustomEvent('pwa:table-variant'))`. In `viewer.js`
   `initViewer()`, add `window.addEventListener('pwa:table-variant', ()=>{ if(DATA) renderOverview(); });`
5. **Verify:** `node --check public/src/viewer.js public/src/info.js` (and that `index.html` parses).
   Behaviour unchanged (variant defaults to classic). Manually confirm the dropdown appears in Info.

## Phase 1 — Presets variant

1. `index.html` `.overview-controls`: add `<select id="table-preset-sel" style="display:none">`
   with options Holdings / Signale / Technik (German labels OK: "Holdings", "Signale", "Technik").
2. `viewer.js`: `function applyPresetCols(){ const allow = PRESETS[getPreset()]; return COLS.filter(c => allow.includes(c[0])); }`
   where `PRESETS` is the 3 label arrays above. Add a `renderPresets()` that temporarily renders
   `#tbl` using the filtered column set (refactor `renderHead`/`renderBody` to accept an optional
   `cols` argument defaulting to `COLS`, so both classic and presets reuse them).
3. `renderOverview()`: `presets` branch → show `#table-preset-sel`, compute/restore the preset,
   render with `applyPresetCols()`. Other variants hide `#table-preset-sel`.
4. Ticker cell: in the presets (and later compact/cards) views, render ticker with a small name
   subtitle, e.g. `<div>TICKER</div><div class="cell-sub">Name</div>` (add `.cell-sub` CSS:
   small, dimmed, ellipsis). Keep the Classic ticker cell as-is.
5. Preset `change` → save `pwa.stocks.tablePreset` and `renderOverview()` (no refetch). Keep the
   currency selector working (Value column appears in Holdings preset on holdings reports).
6. **Verify:** `node --check`. On a Portfolio report the default preset is Holdings (≤5 columns, no
   horizontal scroll on mobile); switching presets re-renders instantly; currency selector still
   re-expresses Value.

## Phase 2 — Compact variant + detail bottom-sheet

1. `viewer.js`: `renderCompact()` renders `#tbl` with exactly 3 columns:
   - **Ticker** (+ name subtitle),
   - **Cons.** (reuse the consensus glyph renderer from `buildCols`),
   - **context**: Value (holdings reports, via `convertCHF`) else Δ1D (`pctCell`).
   Header shows those 3; sorting still works on them.
2. Row tap in compact → `openRowSheet(ticker)` (NOT navigate to charts).
3. `openRowSheet(ticker)`: build (once) and show a fixed bottom-sheet DOM element (mirror the
   action-sheet pattern in `portfolio.js showMoveMenu`: create a div, append to `body`, dismiss on
   backdrop click). Content:
   - Header: ticker + name + exchange.
   - **Full recommender panel**: iterate `DATA.columns` → `glyph(r.panel[col.key], col)` (include
     Hindsight here), plus the consensus glyph.
   - **All summary metrics**: Price, Δ1D, Δ21D, RSI, 50DMA, 200DMA, ↕200, Mom14 (and Value +
     holding block for holdings reports), formatted with the existing `fNum`/`pctCell`/`rsiCell`.
   - A **"→ Chart"** button → `select(ticker); dispatch pwa:navigate→'charts'; close sheet`.
4. CSS: `.row-sheet` (fixed, bottom, slide-up, `z-index` above tab-bar), `.row-sheet-backdrop`
   (full-screen dim), `.row-sheet-panel` (card bg, rounded top, max-height ~70vh, scroll). Respect
   `env(safe-area-inset-bottom)`.
5. `renderOverview()` `compact` branch → `renderCompact()`.
6. **Verify:** `node --check`. Compact list is calm (3 cols); tapping a row opens the sheet with the
   full panel + metrics; "→ Chart" jumps to the chart for that ticker; backdrop closes the sheet.

## Phase 3 — Cards variant + heatmap

1. `viewer.js`: add `function heatColor(v, kind)` returning an `rgba` background:
   - `kind:'pct'` (Δ values): green for positive, red for negative, alpha by `min(1, |v|/0.05)`.
   - `kind:'rsi'`: red tint ≥70, green tint ≤30, transparent in between.
   Use the existing `--buy`/`--sell` hues (hard-code the rgb or read from a small constant).
   Also add `function drawSparkline(cv, closes)`: a minimal single-path close-price line on a tiny
   canvas (no axes/grid/labels), coloured green if `last ≥ first` else red; guard empty/short arrays
   (≤1 point → draw nothing). Reuse the `setupCanvas(cv)` helper for DPR-correct sizing.
2. `renderCards()`: hide `#tbl`; render into a container (reuse `.table-scroll` or a new
   `#cards-wrap`) a list of `.ov-card` elements, one per filtered/sorted row:
   - Header: **Ticker** (bold) + **Name** (dim).
   - Metrics row with heatmap backgrounds: Δ1D, Δ21D, RSI (use `heatColor`). For holdings reports
     also show the consolidated Value (via `convertCHF`).
   - Panel glyphs (`DATA.columns` → `glyph`) + consensus glyph.
   - **Sparkline** (Portfolio-only, so fetches are bounded): a `<canvas class="ov-spark">` showing
     the close-price trend (last ~90 bars). Call `ensureSeries(r.ticker)` then
     `drawSparkline(cv, (r.series && r.series.close || []).slice(-90))`. Skip gracefully if the
     series is unavailable. Because Cards only runs for the Portfolio report (~10–20 rows), this is
     ~10–20 cached lazy fetches, not a storm.
   - Card tap → `openRowSheet(ticker)` (reuse Phase 2).
   Keep the filter (`#filter`) and the current sort applied to the card order.
3. CSS: `.ov-card` (card bg/border/radius/padding/margin), `.ov-card-head`, `.ov-card-metrics`
   (flex/grid of small chips), chip styling for the heatmapped metrics, and
   `.ov-spark{width:100%;height:36px;display:block}`.
4. `renderOverview()` `cards` branch → `renderCards()`. When leaving cards for another variant,
   ensure `#tbl` is shown again and any `#cards-wrap` is cleared/hidden.
5. **Verify:** `node --check`. Cards render with sensible heatmap colours; tap opens the sheet;
   filter/sort still apply; Classic/Presets/Compact still work when switched back.

## Phase 4 — Polish, version, finalize

1. Light polish shared by table variants (A/E): ensure numeric cells are right-aligned (already the
   default), and add a subtle right-edge scroll shadow on `.table-scroll` for Classic (CSS only,
   e.g. a `mask`/gradient or a sticky pseudo-element) so "more columns" is discoverable.
2. Make sure variant/preset selectors show/hide correctly per variant and that the holdings
   currency selector + perf graph remain visible/functional on holdings reports in every variant.
3. Bump `CONFIG.APP_VERSION` in `public/src/config.js` and `VERSION` in `public/sw.js`:
   `v1.4.2` → **`v1.5.0`**.
4. **Final verification:**
   - `node --check public/src/viewer.js public/src/info.js public/src/config.js public/sw.js`.
   - Logic self-review against the Invariants list (currency, perf graph, filter, sort, regime).
   - On-device after deploy + "Cache leeren & neu laden": cycle all 4 variants on a Portfolio
     report and on a large screening report (e.g. S&P 500); confirm no horizontal scroll in
     Presets/Compact/Cards on mobile, the detail sheet works, and Classic is byte-for-byte the old
     behaviour.

---

## Definition of done
All 4 variants selectable from the Info DARSTELLUNG dropdown, persisted across reloads; **variants
affect the Portfolio report only — every other list renders Classic**; Classic unchanged;
Presets/Compact/Cards fit a ~380px phone with no horizontal scroll; the detail bottom-sheet shows
the full panel + metrics + "→ Chart"; Cards show per-row sparklines; the holdings currency selector,
Value, and perf graph keep working in every variant; `node --check` clean; version `v1.5.0`.

## Git (prepare only — do NOT run; the user commits)
```powershell
git -C C:\Projects\StockScanner-pwa add public/index.html public/src/viewer.js public/src/info.js public/style.css public/src/config.js public/sw.js
git -C C:\Projects\StockScanner-pwa commit -m "v1.5.0: overview table display variants (presets, compact+sheet, cards+heatmap) selectable in Info"
git -C C:\Projects\StockScanner-pwa tag v1.5.0
git -C C:\Projects\StockScanner-pwa push
git -C C:\Projects\StockScanner-pwa push --tags
```
