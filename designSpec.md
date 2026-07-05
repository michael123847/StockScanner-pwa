# StockScanner PWA — Design Spec

Version: v1.8.5 · living document, rewritten 2026-07-05 (the prior version was a stale
mockup-review log from the June design pass — see git history if that context is ever needed).

## What it is

An installable PWA (GitHub Pages, no backend of its own) that renders results from the
StockScanner companion server (`../StockScanner`). Five bottom-nav tabs: **Digest**, **Übersicht**,
**Charts**, **Portfolio**, **Info**. One `<section class="page active">` visible at a time, driven
by a `pwa:tab` custom event. A status dot (`#status-dot`) reflects server reachability at all times.

## Connectivity & auth

Three base URLs raced concurrently: `server.local` (mDNS, the only one hard-coded in the public
bundle), LAN IP, Tailscale MagicDNS — the other two come from `/api/stocks/config` and are cached
in `localStorage` (`pwa.bases`, `pwa.activeBase`). A single shared Bearer token (`pwa.stocks.token`)
gates every request; missing it shows the token-setup card in Info → Verbindung. Health checks are
cached 30s, abort after `HEALTH_TIMEOUT_MS` (1500ms).

## Tab: Digest

Two sub-tabs (`#digest-subtab-bar`): **Digest** (`digest_latest.txt`, plain text, "Aktualisieren"
button) and **Allokation** (portfolio-wide, not tied to any report/list):
- A scheme dropdown (`#alloc-scheme-sel`) selects **Hybrid 55/15/15/15** (shipped, real-money) or
  **#5 Sharpshooter** (staged research target) — only these two have live per-sleeve weight data.
  Selecting one shows only that scheme's table + metrics; switching hides the other.
- Below the table: **recommended trades** to transform the *entire* current portfolio
  (`Input/Portfolio.csv` total value) into the selected scheme's target weights. Holdings outside
  the scheme are full sells; scheme instruments not yet held are full buys from cash. Uses each
  position's *live* conviction-scaled target (not the static long-run weight). Positions listed in
  `Input/Portfolio_exclude.csv` (same schema as `Portfolio.csv` — e.g. an ESAP plan handled
  manually) are excluded entirely from the pool and never recommended for sale.
- Buy/sell trade cells use the same green/red convention as the Order column (below).

## Tab: Übersicht (Overview)

- Report picker: `#report` (list) + `#report-date` (date), driven by `GET /api/stocks/index`.
  `Portfolio` defaults first. A **"…" button** (`#report-research-toggle`) reveals
  `Input/research/*.csv` lists (training/research universes, hidden by default) in a separate
  `<optgroup>`; selecting one with no existing report triggers a lazy `?list=&asof=` fetch.
- Classic (full columns, row click → Charts) vs Compact (column preset, row click → bottom sheet)
  — `auto`/`classic`/`compact` via `#table-variant-sel` (Info tab), persisted in `localStorage`.
- Column presets (Compact only): **holdings** (Ticker/Value/Δ1D/Order/ML), **chancen**
  (Ticker/ML/RSI/Δ21D), **backtest** (Ticker/CAGR B&H/Sharpe B&H/ΔCAGR/ΔSharpe/MaxDD — works on
  desktop too, unlike the other two). Panel columns resolve by `{panelKey:'ml_risk'}`, not label
  string, so a stale/relabeled report doesn't silently drop the ML column.
- Currency selector (CHF/EUR/USD/GBP/BTC) converts value/price columns client-side.
- Detail bottom sheet (Compact row tap): **Empfehlungen** (panel columns as glyph tiles) →
  **Kennzahlen** (remaining metrics) → **Backtest** (if `ensureMetrics()` resolved for this ticker)
  → **Ordervorschlag** (if `order_hint` present on the ticker: type + price, green/red by
  direction, plus the rationale text). Double-tap any tile for its explanation popup.

## Tab: Charts

Ticker dropdown (`#chart-ticker`) from the current report. Price / Recommendations / RSI canvases,
fed by `GET /api/stocks/series`. Overlays: 50DMA, 200DMA, Fibonacci (checkboxes). Candlestick or
line toggle. Chart tooltip is dismissed on tab switch (no stale hover state).

## Tab: Portfolio

Multi-list management (`GET/POST/PATCH/DELETE /api/stocks/lists`), search-to-add (Yahoo lookup),
drag reorder, cross-list move, manual scan trigger, Excel export.

## Tab: Info

Version/SW-cache/base-URL/token/scheduler diagnostics. Darstellung (table variant, font scale).
Token setup.

## Recommender panel (schema v2)

`functions/panel.py`'s `REGISTRY` (backend) is the single source of truth for labels/descriptions;
this app's `EXPLAIN` map (`viewer.js`) is a client-only fallback, not authoritative — relabels must
touch both. Current cards: **Rule** (validated, deterministic), **ML** (production, no badge — the
shipped model by construction, not "experimental"), **DP (Oracle)** (look-ahead, blank near the
live edge, not tradeable), **The Bet** (legacy, experimental), **Swing** (validated, tactical).
Consensus is shown only in the row-sheet popup, not as a table column.

## Order-execution hint

`functions/order_hint.py` collapses the ML panel's 5-band signal (Strong Sell/Reduce/Hold/
Buy/Strong Buy) to Buy/Sell and derives a market-vs-limit order type + price from already-computed
levels (MA50, Bollinger, Fibonacci, RSI) — no new data source. Green (`buy`) / red (`sell`) via the
same `.num.pos`/`.num.neg` tokens used throughout the app. Validated against real history
(`scripts/backtest_order_hint.py`, `docs/stockscanner.md` §5): limits fill ~70% within 20 days at a
real median price edge over an immediate market order, but ~17% of all limit recommendations sit
through a significant adverse move without filling — a known, documented cost of the current design.

## Backend layout (for reference)

`../StockScanner` root has `input/`, `output/`, `models/` (`.model` classifier artifacts),
`scripts/` (train/backtest/digest/alloc research drivers), `docs/stockscanner.md` (all findings).
`main.py` is the live scan/API entrypoint; everything else moved to `scripts/`.
