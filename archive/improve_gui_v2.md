# StockScanner PWA — Permanent responsive overview (v1.6.0)

Self-contained guide for a single Sonnet instance. Frontend only (`C:\Projects\StockScanner-pwa`),
vanilla JS/CSS, no new deps, match existing terse style. Work the phases **in order**; run each
phase's `node --check` + sanity review before continuing. Do **not** commit/push — a prepared git
block is at the end for the user.

This **supersedes** the experimental v1.5.1 variant dropdown (`improve_gui.md`). v1.5.1 is already
implemented and pushed; this plan converts it into a permanent, automatic design and removes the
parts we drop.

---

## Goal

Make the overview **orientation-driven by default** for **all lists**, while **keeping the v1.5.0
"Darstellung" selector** as a manual override:

- **Landscape** → **Classic** full table (exactly today's behaviour); row tap → Charts.
- **Portrait** → **Compact mechanics** (row tap → detail bottom-sheet) but showing the **Profile
  preset columns** (Holdings / Signale / Technik). The preset selector stays available in portrait.
- **Selector override:** the existing Darstellung dropdown gains an **Auto** option = the orientation
  behaviour above (default). The user can override to a fixed **Klassisch** (Classic) or **Kompakt**
  (Compact). The **Profile** and **Cards** options are removed — Profile's preset columns are now part
  of Compact. The **preset** selector (Holdings/Signale/Technik) remains and drives Compact's columns.
- **Detail sheet** shows **all Classic info for that one ticker** (every column Classic would show),
  and its background must be **opaque** (current sheet is too transparent — see Fix in Phase 3).
- **Number formatting (global, all lists, both orientations):** every absolute value/price display
  uses **4 significant figures with k / m / b suffixes** (e.g. `12.35k`, `1.235m`). Percentages and
  RSI keep their current formats.
- **Archive the Cards variant** (remove cards + heatmap + sparklines).

Version → **v1.6.0**.

---

## Current state (v1.5.1 — what exists now, in `public/src/viewer.js` unless noted)

- `getTableVariant()` (~L53), `getPreset()/setPreset` (~L57) + localStorage `pwa.stocks.tableVariant`,
  `pwa.stocks.tablePreset`.
- `fNum=(v,d=2)=>…` (~L144), `fPct` (~L145), `rsiCell`, `pctCell`.
- `renderHead(cols)` (~L514), `renderBody(cols,rowOnClick)` (~L540) — already parameterised by column
  set + row click handler. **KEEP.**
- `heatColor(v,kind)` (~L572), `drawSparkline(cv,closes)` (~L585) — Cards only. **REMOVE.**
- `openRowSheet(ticker)` (~L605) — backdrop + `.row-sheet` with "Empfehlungen" (panel glyphs +
  consensus) + "Kennzahlen" (a *subset*) + "→ Chart" button. **CHANGE** (full metrics) and **fix CSS
  alpha**.
- `renderCompact()` (~L652), `renderCards()` (~L667), `renderOverview()` (~L709) — **CHANGE**
  renderOverview: `auto` → orientation dispatch, else honour the explicit variant; **KEEP**
  renderCompact; **REMOVE** renderCards.
- `setupCanvas(cv)` (~L808) — keep (used by the charts).
- Listener `pwa:table-variant` (~L1084). **KEEP**, and **ADD** an orientation listener too.
- `index.html`: `#table-variant-sel` + hint in the Info DARSTELLUNG section (**KEEP** — add an
  `auto` option as default, remove the `profile`/`presets` and `cards` options); `#table-preset-sel`
  in `.overview-controls` (**KEEP**, shown whenever the Compact view is active).
- `info.js`: wiring for `#table-variant-sel` (**KEEP**; default value `auto`); keep `#scale-select`.
- `style.css`: `.cell-sub` (~L241, keep), `.row-sheet*` (~L243-258, keep + alpha fix + `.rs-metrics`),
  `#cards-wrap` + `.ov-card*` + `.ov-spark` (~L261-272, **REMOVE**).

Column presets (already defined; keep): **Holdings** = Ticker, Value, Δ1D, Δ21D, Cons. ·
**Signale** = Ticker, Rule, ML, Risk-Opt, Cons. · **Technik** = Ticker, RSI, 50DMA, 200DMA, Mom14.
Default preset: Portfolio report → Holdings, else → Signale.

---

## Phase 1 — Global number format `fSig` (4 sig figs + k/m/b), all lists

1. In `viewer.js`, add:
   ```js
   const fSig=v=>{ if(!isNum(v)) return '—';
     const a=Math.abs(v); let div=1,suf='';
     if(a>=1e9){div=1e9;suf='b';} else if(a>=1e6){div=1e6;suf='m';} else if(a>=1e3){div=1e3;suf='k';}
     let s=(v/div).toPrecision(4); if(s.indexOf('.')>=0) s=s.replace(/\.?0+$/,''); // trim trailing zeros
     return s+suf; };
   ```
2. Route **absolute-value / price / currency** displays through `fSig`:
   - `buildCols()` numeric formatters for **Price, 200DMA, 50DMA** (and any other plain-value cell)
     → use `fSig(v)` instead of `fNum(v,2)`.
   - `convertCHF()` — replace the `fNum(result,2)` / BTC `toFixed(6)` branches with `fSig(result)`
     (+ the currency code/`BTC` suffix as today). So Value shows e.g. `12.35k CHF`.
   - Tooltip `showTip()` — O/H/L/C and MA values → `fSig`.
   - Chart y-axis `yfmt` (price chart) → `fSig` (replace the `toFixed` formatter).
   - Detail sheet metrics (Phase 3) inherit this automatically by reusing the column formatters.
3. **Leave unchanged:** `fPct` (Δ1D/Δ21D/Mom14) and `rsiCell` (RSI) — percentages and RSI keep their
   current display. `fNum` may remain for any non-value count (e.g. `↕200`).
4. **Verify:** `node --check public/src/viewer.js`; spot-check mentally: 1 234 567 → `1.235m`,
   12 345 → `12.35k`, 123.45 → `123.5`, 0.1542 → `0.1542`.

## Phase 2 — Orientation default + selector override

1. `viewer.js`: add `const isPortrait=()=>window.matchMedia('(orientation: portrait)').matches;`.
   Define two render-path helpers (factor out of the current renderCompact/classic code):
   - `renderClassic()` → `renderHead(COLS); renderBody(COLS, classicRowClick)`, where
     `classicRowClick(ticker)` = existing `select(ticker)` + `dispatch pwa:navigate → 'charts'`;
     hide `#table-preset-sel`; ensure `#tbl` visible.
   - `renderCompact()` → preset subset (`applyPresetCols()` / filter `COLS` by the active preset's
     labels); `renderHead(presetCols); renderBody(presetCols, openRowSheet)`; show `#table-preset-sel`
     (default per list, persisted). (Compact always uses the detail sheet.)
2. Rewrite `renderOverview()` to honour the selector, **all lists** (no Portfolio-only gating):
   - `const v = getTableVariant();` (default `'auto'`).
   - `auto`    → `isPortrait() ? renderCompact() : renderClassic()`.
   - `classic` → `renderClassic()`.
   - `compact` → `renderCompact()` (preset columns + tap → sheet).
   - Keep `#currency-sel` / `#perf-wrap` shown when `DATA.fx` in every branch.
3. `index.html` `#table-variant-sel`: options **Auto** (`auto`, default, „Automatisch (Ausrichtung)“),
   **Klassisch** (`classic`), **Kompakt** (`compact`). **Remove the `profile`/`presets` and `cards`
   options.** Reword the `.hint` to „Auto folgt der Bildschirm-Ausrichtung; manuell überschreibbar.“
4. `getTableVariant()`: default `'auto'`, allow-list `['auto','classic','compact']` (drop `presets`/`cards`).
   `info.js`: keep the `#table-variant-sel` wiring (read saved value, set it, on `change` save +
   `dispatch pwa:table-variant`).
5. Listeners in `initViewer()`: **keep** `window.addEventListener('pwa:table-variant', ()=>{ if(DATA) renderOverview(); })`
   **and add** `window.matchMedia('(orientation: portrait)').addEventListener('change', ()=>{ if(DATA) renderOverview(); })`
   (orientation only changes the result when variant is `auto`; harmless otherwise).
6. Preset selector: on `#table-preset-sel` change → save `pwa.stocks.tablePreset` + `renderOverview()`.
7. **Verify:** `node --check`. Selector = Auto: rotate → portrait compact-presets (tap→sheet),
   landscape classic (tap→chart). Override to Klassisch/Profile/Kompakt → that view regardless of
   orientation. Works on Portfolio **and** large lists.

## Phase 3 — Detail sheet = all Classic info + opacity fix

1. `openRowSheet(ticker)` "Kennzahlen" section: render the **full Classic metric set** for the row,
   not a subset. Build it by iterating the **full Classic `COLS`** (the unfiltered `buildCols()`
   output), skipping the columns already shown elsewhere — Ticker, Name, and the panel/consensus
   columns (those stay in "Empfehlungen") — and rendering each remaining column as a
   label→value pair via its own formatter: `col[2](col[1](r), r)`. This guarantees the sheet shows
   exactly what Classic would (Price, Δ1D, RSI, 200DMA, ↕200, 50DMA, Δ21D, Mom14, and Value/holding
   on holdings reports), now formatted with `fSig`/`fPct` from Phase 1.
   - Keep "Empfehlungen" (full panel incl. Hindsight + Consensus) and the "→ Chart" button
     (`select(ticker)` + `pwa:navigate → 'charts'` + close).
2. **Alpha fix (the reported "zu durchscheinend"):** `.row-sheet-panel` currently uses
   `background:var(--card)` = `rgba(255,255,255,.07)` (translucent). Change it to an **opaque**
   surface so the sheet content is solid over the backdrop — e.g.
   `background:#1e1e34;` (a solid dark that matches the theme; or add a `--surface:#1e1e34` token and
   use it). Keep the backdrop `rgba(0,0,0,.55)`. Verify the sheet is no longer see-through.
3. **Verify:** `node --check`; open the sheet on a holdings and a non-holdings row — all Classic
   metrics present for that ticker; background opaque.

## Phase 4 — Archive the Cards variant

1. `viewer.js`: remove `renderCards()`, `heatColor()`, `drawSparkline()`, the cards branch/usage in
   `renderOverview()`, and any `#cards-wrap` creation/teardown. (Git history is the archive — no need
   to keep dead code; you may reference `improve_gui.md` for the old spec.)
2. `style.css`: remove `#cards-wrap`, `.ov-card*`, `.ov-spark` rules. Keep `.cell-sub`, `.row-sheet*`,
   `.rs-metrics`.
3. **Keep** `pwa.stocks.tableVariant` (now stores `auto`/`classic`/`compact`) and
   `pwa.stocks.tablePreset`. Remove the **`profile`/`presets`** and **`cards`** options from
   `#table-variant-sel` and from the `getTableVariant()` allow-list.
4. **Verify:** `node --check`; no references to removed identifiers remain (grep
   `renderCards|heatColor|drawSparkline|ov-card|ov-spark`) and no `cards` option remains in the
   dropdown.

## Phase 5 — Version + final verification

1. Bump `CONFIG.APP_VERSION` (`public/src/config.js`) and `VERSION` (`public/sw.js`):
   `v1.5.1` → **`v1.6.0`**.
2. `node --check public/src/viewer.js public/src/info.js public/src/config.js public/sw.js`.
3. On device after deploy + "Cache leeren & neu laden":
   - Portrait: compact preset list on every list; tap → opaque sheet with all Classic metrics +
     panel + "→ Chart"; preset selector switches columns.
   - Landscape: unchanged Classic full table; tap → chart.
   - Values everywhere show 4 sig figs with k/m/b suffixes (table, sheet, tooltip, chart axis), all
     lists. Percentages/RSI unchanged. Currency selector + perf graph still work on holdings reports.
   - Selector: **Auto** follows rotation; overriding to Klassisch/Kompakt forces that view in any
     orientation; **Profile** and **Cards** are no longer listed.

## Definition of done
Darstellung selector kept with **Auto** default (orientation: landscape→Classic, portrait→Compact)
plus manual overrides Klassisch/Kompakt (Profile and Cards removed; Compact carries the preset
columns + detail sheet); applies to all lists; detail sheet shows all Classic info per ticker and is
opaque; `fSig` (4 sig figs + k/m/b) on all value displays across all lists; Cards/heatmap/sparklines
removed; `node --check` clean; version `v1.6.0`.

## Git (prepare only — do NOT run; the user commits)
```powershell
git -C C:\Projects\StockScanner-pwa add public/index.html public/src/viewer.js public/src/info.js public/style.css public/src/config.js public/sw.js
git -C C:\Projects\StockScanner-pwa commit -m "v1.6.0: orientation-default overview with manual override (auto/classic/compact), full-info opaque detail sheet, 4-sig-fig k/m/b number format; remove profile+cards variants"
git -C C:\Projects\StockScanner-pwa tag v1.6.0
git -C C:\Projects\StockScanner-pwa push
git -C C:\Projects\StockScanner-pwa push --tags
```
