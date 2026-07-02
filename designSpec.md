# StockScanner PWA — Design Specification

Version: v1.6.1  
Status: living document, updated as features ship

---

## What it is

StockScanner is an installable Progressive Web App (PWA) that acts as a mobile-first dashboard for a self-hosted stock scanning server. It has no backend logic of its own — it is a pure frontend shell, hosted as static files on GitHub Pages, that fetches data from a companion server running on the home network or via Tailscale.

---

## Deployment & hosting

- Static files are hosted on GitHub Pages (zero server cost on the frontend side).
- The app must be installable on Android and iOS via the browser "Add to Home Screen" flow (`manifest.webmanifest`, `display: standalone`).
- A service worker (`sw.js`) caches the full app shell on install so the app launches instantly and the UI is usable offline. Only static assets are cached; all data requests always go to the live server.
- The service worker cache key is namespaced (`ss-shell-vN`) to avoid collision with other PWAs on the same GitHub Pages origin.
- `VERSION` in `sw.js` and `APP_VERSION` in `config.js` must always match. Bumping the version triggers a cache refresh on all clients.

---

## Connectivity & authentication

### Server discovery

The app must reach the companion server through whichever network path is currently available. Three candidates are raced concurrently:

| Path | When it works |
|---|---|
| `server.local` (mDNS) | Device is on the home Wi-Fi |
| LAN IP (e.g. `192.168.x.x`) | Device is on the same subnet |
| Tailscale MagicDNS hostname | Device is anywhere with Tailscale active |

- Only the mDNS hostname is hard-coded in the public bundle. The LAN IP and Tailscale hostname are fetched at runtime from `/api/stocks/config` (itself gated by the auth token) and cached in `localStorage` under `pwa.bases`.
- Bootstrap requirement: on first install the device must be on the home Wi-Fi (so mDNS resolves) to seed the cache. After one successful connection all three paths are cached and subsequent cold starts work from anywhere.
- The active base URL is stored in `pwa.activeBase` and reused on subsequent requests until a health check fails.
- Health checks are cached for 30 s to avoid hammering the server on every tab switch.
- Health check requests must abort after `HEALTH_TIMEOUT_MS` (1 500 ms) so an unreachable candidate does not stall the UI.

### Authentication

- Access is controlled by a single shared Bearer token.
- The token is entered once by the user (Info tab → Verbindung) and stored in `localStorage` under `pwa.stocks.token`. It is never transmitted to any third party.
- All requests to the companion server must include `Authorization: Bearer <token>`.
- If no token is set, the app must display the token setup card in the Info tab rather than silently failing.

### Offline / unreachable state

- When the server cannot be reached, a banner (`#offline`) must be shown.
- The app shell must remain usable offline (navigation, cached reports are not available, but the UI must not crash).

---

## Navigation

- Five tabs at the bottom of the screen: **Digest**, **Übersicht**, **Charts**, **Portfolio**, **Info**.
- Only one tab's `<section>` is visible at a time (`class="page active"`).
- Tab switches are driven by a `pwa:tab` custom event; the active tab button and section are toggled accordingly.
- The Charts tab is navigated to programmatically from the Übersicht table (tapping a row in Classic mode) via a `pwa:navigate` custom event.
- A status dot (`#status-dot`) in the app header must reflect the live server connection state at all times (green = reachable, red/grey = unreachable), independently of which tab is active.

---

## Tab: Digest

- Displays `digest_latest.txt` fetched from `GET /api/stocks/digest` as preformatted plain text.
- Shows a timestamp extracted from the file content.
- Provides a manual "Aktualisieren" button to force a fresh fetch.
- Error state must be shown inline if the server is unreachable.

---

## Tab: Übersicht (Overview)

### Report selection

- Reports are listed by `GET /api/stocks/index` which returns a manifest of available scan files (newest first).
- The user selects from two independent dropdowns:
  - `#report` — selects the list name (e.g. Portfolio, Watchlist). Defaults to "Portfolio" if present, otherwise the first entry.
  - `#report-date` — selects the scan date for the chosen list. Defaults to the newest available date.
- Changing the list name must repopulate the date dropdown and auto-load the newest date.
- Changing the date must load that specific report without changing the list selection.

### Table rendering

- The table renders rows from `GET /api/stocks/report?file=<name>` which returns a JSON report object.
- Two rendering modes exist:
  - **Classic**: all metric columns visible; clicking a row navigates to the Charts tab for that ticker.
  - **Compact**: a column preset (`#table-preset-sel`) filters to a small column subset; clicking a row opens a detail bottom-sheet (`openRowSheet`).
- A Darstellung selector (`#table-variant-sel`, located in the Info tab) controls which mode is used:
  - `auto` — Classic in landscape, Compact in portrait (tracks `(orientation: portrait)` media query live).
  - `classic` — always Classic regardless of orientation.
  - `compact` — always Compact regardless of orientation.
- The selected variant is persisted in `localStorage` (`pwa.stocks.tableVariant`).

### Column presets (Compact mode only)

- Three presets: **Holdings**, **Signale**, **Technik** — each is an allowlist of column labels.
- Selected preset persists in `localStorage` (`pwa.stocks.tablePreset`).
- Preset selector is hidden in Classic mode.

### Currency selector

- A `#currency-sel` dropdown (CHF / EUR / USD / GBP / BTC) converts all value/price columns client-side using rates from the report's `fx_rates` object.
- All absolute values display with 4 significant figures and k/m/b magnitude suffixes (`fSig` formatter).

### Filtering

- A free-text `#filter` input matches against ticker, name, sector, and other string fields.
- Filtering happens client-side on the already-loaded report data.

### Detail bottom-sheet (Compact mode row tap)

- A full-width bottom panel slides up with two sections: **Empfehlungen** and **Kennzahlen**.
- **Empfehlungen** lists each active recommender column (Rule, ML, Hindsight, Risk-Opt, Cons.) as a labeled tile (`rs-metric-label` + `rs-metric-value`). Recommenders with no signal are omitted.
- **Kennzahlen** lists all remaining metric columns (excluding Ticker, Name, Cons., and panel columns) as labeled tiles.
- The sheet must be dismissible by tapping outside it.

### Performance chart

- A `#c-perf` canvas shows a portfolio performance chart fetched separately from `GET /api/stocks/portfolio_series?list=<name>`. It is not embedded in the report JSON.
- The chart is shown/hidden alongside the table via `#perf-wrap`.

---

## Tab: Charts

### Ticker selection

- A `#chart-ticker` dropdown is populated with tickers from the current report.
- Selecting the Charts tab from the Übersicht table pre-selects the tapped ticker.

### Chart panels

Price and indicator data are fetched from `GET /api/stocks/series?list=<name>&ticker=<ticker>&asof=<date>` for the selected ticker.

- **Price chart** (`#c-price`): OHLC data rendered as line or candlestick (toggle via Linie/Kerzen buttons).
- **Recommendations chart** (`#c-rec`): time series of the composite recommendation signal.
- **RSI chart** (`#c-rsi`): 14-period RSI with 30/70 overbought/oversold bands.
- Overlays on the price chart: 50-day MA, 200-day MA, Fibonacci retracement levels — each togglable via checkboxes.
- Date range buttons (e.g. 3M, 6M, 1Y, All) zoom the chart viewport without fetching new data.

---

## Tab: Portfolio

### List management

- Multiple named lists are supported. Built-in lists (Portfolio, Watchlist, Screenlist_extended) cannot be deleted. User-defined lists can be created, renamed, and deleted via `GET/POST/PATCH/DELETE /api/stocks/lists`.
- Each list has a tab at the top of the Portfolio section; the active list tab loads that list's holdings.
- Individual list contents are fetched from `GET /api/stocks/portfolio?list=<name>`.

### Holdings table

- Displays the ordered list of tickers in the active list. This is a ticker registry, not a live data table — scan metrics are not shown inline here; they appear in the Übersicht and Charts tabs.
- Rows can be reordered by drag-and-drop (or move up/down controls).

### Adding tickers

- A search input (`#pf-search-input`) queries `GET /api/stocks/search?q=<text>` (Yahoo Finance lookup).
- Search results appear as a dropdown list; selecting one adds the ticker to the active list via `PUT /api/stocks/portfolio?list=<name>`.

### Editing & filtering

- A filter input (`#pf-filter-input`) filters the visible holdings client-side.
- Holdings can be removed from the active list.

### Cross-list operations

- Tickers can be moved or copied between lists via `POST /api/stocks/portfolio/move?from=X&to=Y`.

### Triggers

- A "Scan jetzt starten" button posts to `POST /api/stocks/run` to trigger an immediate scan.
- An "Excel exportieren" button posts to `POST /api/stocks/export?list=<name>` to regenerate the Excel workbook.

---

## Tab: Info

### Diagnostics

- Displays app version, SW cache version, active server base URL, auth token status (set/not set), last health-check result, and scheduler status (fetched from `GET /api/stocks/status` — shows whether the nightly scan job is active and when it last ran).
- A version mismatch between `APP_VERSION` and the cached SW version must be highlighted.
- "Aktualisieren" re-runs all probes and refreshes scheduler status.
- "Cache leeren & neu laden" unregisters the service worker, clears all caches, and reloads.

### Darstellung

- `#table-variant-sel` — Auto/Klassisch/Kompakt selector for the Overview table layout (see Übersicht).
- `#scale-select` — five font/density scale levels (Extra Klein → Extra Gross); selection stored in `localStorage` (`ss.ui.scale`) and applied via `data-scale` on `<html>`.

### Verbindung

- Token setup card (hidden when a token is already stored).
- Link to the certificate installation guide (`setup/`).

---

## Schema compatibility

- Reports follow schema-v2. Schema-v1 reports (lacking certain fields) must be normalised to schema-v2 shape by `normalizeSchema()` before rendering.
- The `DATA.columns` array from the report defines the active recommender axes (panel columns). The set of panel columns varies per report; the UI must render whatever columns are present without hard-coding their names.

---

## Security

- The app must never embed the LAN IP or Tailscale hostname in the public bundle.
- The auth token must never be logged or transmitted outside of `Authorization` headers to the companion server.
- The service worker must not cache requests that carry an `Authorization` header; all authenticated API calls must bypass the SW cache.
- Private network address ranges (mDNS `.local`, `.ts.net`, `100.64/10`, `192.168/16`, `10/8`) must be excluded from SW fetch interception.

---

## Performance & UX constraints

- The app must render the first table within one round-trip of the server (index fetch + report fetch).
- Health check probes must not block tab navigation.
- The SW must use `cache: 'reload'` when pre-caching shell assets to bypass the browser HTTP cache (GitHub Pages sends `max-age=600`).
- `skipWaiting()` must be called on SW install so a new SW activates immediately without waiting for all tabs to close.

---

## REVIEW 1: Inconsistencies

**1. Version mismatch contradiction (lines 20 vs. 186)**
- Line 20 states `VERSION` and `APP_VERSION` "must always match"
- Line 186 requires highlighting when they don't match
- These contradict: if they must always match, a mismatch condition shouldn't need to be detected. The second implies they *can* drift (stale SW cache), which is operationally realistic but conflicts with the first claim.

**2. Cache namespace inconsistency (line 19 vs. lines 45, 96, 101)**
- SW cache namespaced as `ss-shell-vN`
- But localStorage keys use `pwa.*` prefix (`pwa.stocks.token`, `pwa.activeBase`, `pwa.stocks.tableVariant`)
- Mixing `ss-` and `pwa-` prefixes suggests either incomplete naming or unrelated code origins. Should standardize on one convention.

**3. Offline data availability contradiction (lines 18 vs. 52)**
- Line 18: "Only static assets are cached; all data requests always go to the live server"
- Line 52: "cached reports are not available" (offline) — implies reports *are* cached somewhere
- These directly contradict. Either reports are cached or they aren't. Spec needs to clarify offline report caching strategy.

**4. Undefined term: "Cons." (line 118)**
- Referenced as a column to exclude in the detail sheet but never defined elsewhere in the spec
- Likely means "Consensus" or similar; should be explicitly defined on first use

**5. Report fetch endpoint underspecified (line 88)**
- `GET /api/stocks/report?file=<name>` — unclear if `file=` is list name or full file path with date
- Line 83 says user selects both list and date independently, but the endpoint signature doesn't reflect both parameters

**6. Currency selector lacks default (line 106)**
- Five currency options listed, but no default currency specified or storage key mentioned
- Lines 82, 84 specify defaults for report/date; currency should too

**7. Schema normalization flow missing (line 204)**
- States schema-v1 must be normalized by `normalizeSchema()` but never specifies:
  - Where/when this function is called
  - Client-side or server-side?
  - How it integrates with the report fetch flow

**8. Initial `pwa.activeBase` assignment unclear (line 38)**
- Stored and reused per health checks, but bootstrap flow (line 37) doesn't explain initial activeBase selection on cold start when localStorage is empty

---

## VERDICT (Claude Sonnet 4.6 — 2026-06-14)

All eight findings in REVIEW 1 are **valid**. Brief assessment:

| # | Finding | Severity | Assessment |
|---|---|---|---|
| 1 | VERSION / APP_VERSION "must always match" vs mismatch-detection UI | Medium | Real contradiction. Line 20 should say "are kept in sync intentionally; a drift indicates a stale SW" — not "must always match" as an invariant. |
| 2 | `ss-shell-vN` (SW cache) vs `pwa.*` (localStorage) prefix mix | Low | A naming inconsistency but not a runtime bug. Cosmetic. |
| 3 | "All data requests always go live" vs "cached reports not available" | High | The phrase on line 52 is genuinely ambiguous. A reader could parse "cached reports are not available" as *they exist but are inaccessible*, which directly contradicts line 18. Needs to be reworded to "reports are unavailable offline (they are not cached)." |
| 4 | "Cons." undefined | Low | Trivially fixable with a parenthetical on first use. |
| 5 | `/api/stocks/report?file=<name>` missing date param | Medium | Endpoint signature is incomplete relative to the two-dropdown UX described above it. |
| 6 | Currency selector has no documented default or storage key | Low | Minor omission; consistent with how other selectors are documented. |
| 7 | `normalizeSchema()` caller/location unspecified | Medium | Implementation risk: a developer reading only the spec has no signal on when or where normalization runs. |
| 8 | Bootstrap cold-start leaves `pwa.activeBase` undefined | Medium | The race-three-candidates flow is described but the spec never says which winner is written to `pwa.activeBase` or when. |

**Additional inconsistencies not in REVIEW 1:**

**9. `ss.ui.scale` breaks the localStorage naming convention (line 193)**
- Every other localStorage key uses `pwa.*` (`pwa.bases`, `pwa.activeBase`, `pwa.stocks.token`, `pwa.stocks.tableVariant`, `pwa.stocks.tablePreset`).
- The scale key uses `ss.ui.scale` — a different root prefix, different separator style.
- REVIEW 1 compares SW cache `ss-` to localStorage `pwa.*`, but the real inconsistency is *within* localStorage itself.

**10. `Cons.` in Empfehlungen vs explicit Kennzahlen exclusion is contradictory (lines 117–118)**
- Line 117 lists "Cons." as one of the active recommender columns shown in the Empfehlungen section.
- Line 118 says Kennzahlen excludes "Ticker, Name, Cons., and panel columns" — naming Cons. *separately* from "panel columns".
- If Cons. is a panel/recommender column it should fall under "panel columns" in the exclusion rule; listing it separately implies it is *not* a panel column, contradicting line 117.

**Summary:** findings 3, 5, 7, 8, and 10 carry the most implementation risk. The rest are clarity/style issues.

---

## REVIEW 2: UX Comments (Claude Sonnet 4.6 — 2026-06-14)

### Onboarding & first-run

**UX-1. Bootstrap constraint is invisible to the user (line 37)**
The spec requires the device to be on home Wi-Fi on first install to seed the URL cache. This is a hard prerequisite that will silently break first-time setup if not met — the user will see a generic "server unreachable" state with no explanation. An onboarding screen or setup-tab copy should state this requirement explicitly before the user hits it.

**UX-2. Token error vs. unreachable server are indistinguishable (lines 47–51)**
A wrong token returns HTTP 401; an unreachable server never responds. Both result in the offline banner (`#offline`). The spec should require these to be surfaced differently: a 401 should prompt the user to re-enter the token, not show a network error.

**UX-3. Version mismatch highlighted but no remediation path (line 186)**
The spec says a mismatch "must be highlighted" but does not say what the user should do. Unless a highlighted mismatch is paired with an explicit instruction (e.g. "tap 'Cache leeren & neu laden' to update"), most users will not know how to resolve it.

---

### Navigation

**UX-4. Row tap navigates to a different tab silently (line 61)**
In Classic mode, tapping a row in Übersicht switches the active tab to Charts. No visual transition or breadcrumb is specified. On a phone this is disorienting — the user tapped a row and the whole screen changed. A brief animation or a visible tab highlight should accompany the switch.

**UX-5. Compact and Classic row taps do fundamentally different things (lines 90–91)**
Classic tap → tab switch; Compact tap → bottom sheet. The behaviour changes based on orientation (in `auto` mode) without any affordance that this is happening. A user rotating their phone will lose the bottom-sheet pattern and gain tab-switching unexpectedly. The spec should at minimum acknowledge this asymmetry and consider whether a visual hint (e.g. a chevron icon on Classic rows) is needed.

**UX-6. Status dot uses two terms for one failure state (line 62)**
"red/grey = unreachable" lists two colors as equivalent. Red and grey carry different semantic weight (error vs. unknown/loading). If the implementation uses both, each needs its own defined meaning; if only one color is used, the other should be removed from the spec.

---

### Übersicht

**UX-7. No loading state specified for dropdown repopulation (line 83)**
When the list name changes, the date dropdown is repopulated and a new report is auto-loaded. Between the change and the new data arriving, the table still shows the previous report. The spec doesn't require a loading indicator or table clear, so a user who changes the dropdown quickly may see stale data with no feedback that a load is in progress.

**UX-8. Darstellung selector is in the Info tab, not Übersicht (line 92)**
The table layout control lives in a different tab from the table it controls. This is a discoverability problem: a user who wants to change from Compact to Classic must leave the Übersicht tab, navigate to Info, change the selector, then navigate back. Consider moving the selector into the Übersicht tab header or at minimum documenting the rationale for this placement.

**UX-9. Preset selector disappears without explanation when switching to Classic (line 102)**
The preset selector is hidden in Classic mode. If a user switches from Compact to Classic (manually or via rotation in `auto` mode), the selector vanishes with no indication that their preset is preserved. The spec should require the selector to remain visible-but-disabled, or add a tooltip/label explaining why it's gone.

**UX-10. Bottom-sheet dismiss: tap-outside only; no swipe-down (line 119)**
Tap-outside is the desktop pattern. On mobile, the ergonomic standard for bottom sheets is a downward swipe gesture. The spec does not mention swipe-to-dismiss. This should be added or explicitly excluded with a rationale.

**UX-11. Error state in Digest: replace or stack? (line 71)**
After a successful load of `digest_latest.txt`, if the user taps "Aktualisieren" and the server is now unreachable, the spec says "error state must be shown inline." It doesn't say whether the last known content should remain visible beneath the error (preferable — the stale digest is still useful) or be replaced by the error. Specify the behaviour.

---

### Charts

**UX-12. Charts tab is populated from "current report" but current report is Übersicht-local (line 132)**
The `#chart-ticker` dropdown is populated with tickers from the current report. But the "current report" is whatever list/date was selected in Übersicht. If the user navigates to Charts directly (not via row tap), it's unclear which report's tickers are used, and whether switching list or date in Übersicht silently changes the Charts ticker list without the user knowing.

**UX-13. Overlays have no visual grouping or labelling convention (line 142)**
Three overlay checkboxes (50 MA, 200 MA, Fibonacci) are mentioned but no layout or grouping is specified. On a narrow mobile screen these checkboxes compete with the Linie/Kerzen toggle buttons and the date range buttons. The spec should at least note the intended layout region for controls vs. chart area.

---

### Portfolio

**UX-14. Drag-and-drop reorder has no mobile fallback specification (line 158)**
Drag-and-drop on touch is unreliable (scroll vs. drag ambiguity, long-press threshold varies by device). "Move up/down controls" are mentioned as an alternative but the spec gives no detail: are they always visible, revealed on long-press, or shown in an edit mode? Without this, implementations will diverge.

**UX-15. No success feedback after adding a ticker (line 163)**
Selecting a search result adds the ticker silently. No confirmation message, row highlight, or scroll-to-new-row is specified. On a long list the user may not see the addition happened, especially if the filter input is active.

**UX-16. "Scan jetzt starten" has no defined feedback states (line 176)**
The button POSTs to `/api/stocks/run`. The spec doesn't say what happens next: should the button disable? Show a spinner? Display a success/failure message? A scan that takes minutes leaves the user with no indication that anything is happening.

**UX-17. Built-in lists are delete-protected but rename-protection is unspecified (line 151)**
The spec says built-in lists "cannot be deleted." It does not say whether they can be renamed. If rename is also blocked, the spec should say so. If rename is allowed, the API's PATCH verb applies and the UI should expose it even for built-in lists — creating a partial edit state that needs clarification.

---

### Info tab

**UX-18. Scale selector has no live-preview behaviour specified (line 193)**
Five font scale levels are listed. The spec says the selection is stored and applied via `data-scale` on `<html>`, but doesn't say when it takes effect: instantly on change (live preview) or only after save/reload? Live application is standard and expected; if it works differently, the spec should say so.

**UX-19. "Cache leeren & neu laden" is destructive with no confirmation (line 188)**
This action unregisters the service worker, clears all caches, and reloads — effectively a factory reset of the client state. The spec doesn't require a confirmation dialog. A single mis-tap resets all stored URLs and forces the user back through the bootstrap flow. A "are you sure?" prompt should be required.

---

## REVIEW 3: Compact mode & detail sheet ambiguities (Claude Sonnet 4.6 — 2026-06-14)

**C-1. Preset column lists are never defined (line 100)**
The spec says each preset is "an allowlist of column labels" but never lists what those columns are. A developer reading this spec cannot implement Holdings, Signale, or Technik without out-of-band knowledge. The allowlist for each preset must be enumerated (or referenced to a separate data file).

**C-2. "Remaining metric columns" in Kennzahlen is ambiguous (line 118)**
"All remaining metric columns (excluding Ticker, Name, Cons., and panel columns)" — remaining from what? The full report column set, or the columns surviving the active preset? If the sheet always shows all report columns minus the four exclusions, the sheet reveals data the Compact table deliberately hides. If it only shows preset columns minus the exclusions, the sheet content changes with every preset switch. The spec must state which scope "remaining" refers to.

**C-3. "Active recommender column" is undefined (line 117)**
Empfehlungen shows "each active recommender column." Two interpretations: (a) columns present in `DATA.columns` for this report, or (b) columns that have a non-null/non-zero value in the tapped row. These are different: (a) always shows the same recommenders; (b) varies per row and may differ from what the table header shows. The spec should define "active" precisely, and also clarify whether this definition is the same as or derived from `DATA.columns` (line 205).

**C-4. "No signal" is undefined (line 117)**
"Recommenders with no signal are omitted." What value counts as no signal? `null`? `0`? An empty string? A specific sentinel like `"n/a"`? Without a definition, two implementations of `openRowSheet` may show or hide different tiles for the same row data.

**C-5. Sheet has no ticker identity header (lines 116–119)**
The sheet opens on row tap but the spec doesn't say it shows the ticker name or company name. On a long scrollable table the user may have tapped a row that has scrolled partially off-screen; without a header confirming which stock is shown, they have no way to verify they tapped the right row.

**C-6. Currency conversion scope in the sheet is unspecified (lines 106, 116–118)**
The currency selector converts "all value/price columns" in the table. Does the same conversion apply to Kennzahlen tiles in the sheet? It should, since the sheet shows the same data — but the spec never says so. An implementation that converts the table but not the sheet will show inconsistent numbers for the same ticker.

**C-7. Tile display order is unspecified (lines 117–118)**
The spec lists recommenders in a fixed order (Rule, ML, Hindsight, Risk-Opt, Cons.) for Empfehlungen, but doesn't say if this is the required display order or just an example. For Kennzahlen, no order is stated at all. Implementations will diverge unless the ordering rule is explicit (e.g. "follow `DATA.columns` order for Empfehlungen; alphabetical for Kennzahlen").

**C-8. Signale preset likely duplicates Empfehlungen (lines 100, 117)**
If the Signale preset includes recommender columns in the Compact table, those same values will also appear in the Empfehlungen section of the sheet when that row is tapped. The user sees the same data twice with no obvious reason. The spec should either (a) note this and accept it, or (b) specify that Empfehlungen in the sheet is suppressed or de-emphasised when the active preset already surfaces recommender columns in the table.

---

## REVIEW 4: Digest & Portfolio investment utility + mockup gaps (Claude Sonnet 4.6 — 2026-06-14)

*Based on spec reading, the prior conversation, and five UI screenshots (Info, Portfolio×2, Charts, detail sheet).*

---

### Digest — investment utility

**D-1. Digest is a dead end for decision-making (line 68)**
As specced, the Digest is a plain-text blob with no interactivity. If it names a ticker, there is no path from that mention to the Charts or Übersicht view for that ticker. A user who reads "CALN.SW looks interesting" must manually navigate away and find the stock themselves. Minimum viable fix: auto-detect ticker symbols in the text and render them as tappable links that navigate to Charts.

**D-2. Only "latest" is accessible — no history (line 68)**
The endpoint is `GET /api/stocks/digest` returning `digest_latest.txt`. There is no date picker, no archive. The digest cannot be used to track how the narrative has evolved over days or weeks. If the server retains past digests, a date selector (matching the pattern already used in Übersicht) would make the tab significantly more useful.

**D-3. No search or navigation within the digest (line 68)**
On a long digest, the user cannot search for a specific ticker. Standard browser find-in-page (`Ctrl+F`) does not work reliably inside a PWA `<pre>` block in standalone mode. A simple in-page search input would close this gap.

---

### Portfolio — investment utility

**D-4. Spec says "no metrics inline" but mockup shows Exposure and Ccy (line 157)**
The spec states "scan metrics are not shown inline here." The Portfolio mockup shows Exposure (e.g. 366.66 CHF, 14283.5 CHF) and Ccy columns per ticker. These are not scan metrics — they appear to be portfolio-specific fields (position size / currency). The spec should acknowledge these columns, define what they represent, and clarify that "scan metrics" means the recommender/technical signals, not position data.

**D-5. Exposure column is empty for Watchlist+ but shown (mockup)**
In the Watchlist+ screenshot, the Exposure and Ccy columns exist but are blank for every row. An empty column taking up screen space on a narrow mobile screen wastes layout. The spec should either suppress columns with no data for the active list, or document that Exposure/Ccy are Portfolio-only fields and should be hidden for lists that don't carry position data.

**D-6. No signal visible per holding — the key question goes unanswered**
The Portfolio tab shows which stocks you own but not how they're rated. A user's first question when opening the Portfolio is "which of my holdings has a sell signal right now?" That answer requires navigating to Übersicht, selecting the same list, and scanning the table. Adding a single summary signal column (e.g. the Consensus value) inline in the Portfolio table would directly serve investment decision-making without cluttering the list.

**D-7. "Speichern" implies a staged edit model not mentioned in the spec (mockup)**
The Portfolio mockup shows "+ Zeile", "Speichern", and "Neu laden" buttons. The spec describes add/remove operations as immediate API calls (PUT, DELETE). The presence of "Speichern" implies edits are locally staged and only committed on save — a fundamentally different interaction model. The spec must define: are mutations immediate or staged? What does "Speichern" submit? What does "Neu laden" discard?

**D-8. "+ Zeile" is unexplained in both spec and mockup (line 162)**
The spec describes one add path: search → select from Yahoo Finance results. The mockup shows a separate "+ Zeile" button alongside the search field. Its behaviour is not specified. Does it add a blank row for manual ticker entry? Is it an alternative to the search flow? Is it for adding position data (Exposure/Ccy) to an existing row? Needs definition.

**D-9. No drag handle visible — reorder affordance is invisible (line 158)**
The spec says rows can be reordered by drag-and-drop. The mockup shows only a ⇄ icon per row, which from context appears to be the cross-list move control (line 172), not a drag handle. There is no visible grip/handle for drag-and-drop reordering. Either the drag handle is missing from the UI, or ⇄ serves dual purpose (move + reorder) — neither is documented. The up/down controls mentioned in the spec as an alternative are also absent.

**D-10. Name column truncation makes the list hard to read (mockup)**
Company names are cut to 5–7 characters ("BBG ...", "UBS ...", "Wisd..."). On a 13-row Portfolio list with similar fund names this makes rows nearly indistinguishable. The spec doesn't specify truncation rules or a reveal mechanism (e.g. tap-to-expand name, tooltip). Long names should either wrap to a second line or be accessible via a long-press.

---

### Charts tab — spec vs. mockup gaps

**D-11. Date range labels differ from spec (line 143)**
The spec lists example date range buttons as "3M, 6M, 1Y, All." The Charts mockup shows "Full, 120d, 60d, 14d." These are not equivalent (120d ≠ 6M, 14d is not mentioned at all). The spec should list the actual button labels and their viewport durations.

**D-12. "Swing" recommender is unspecced (line 117, mockup)**
The Charts header line and the detail sheet both show a "Swing" recommender (value: "Wait" in the screenshots). The spec's recommender list is "Rule, ML, Hindsight, Risk-Opt, Cons." — Swing is absent. Either the spec is incomplete or Swing was added after the spec was last updated. It must be added to the recommender list and its signal semantics (what values can it take beyond "Wait"?) documented.

**D-13. Asterisk on signal values is unexplained (mockup)**
ML shows "Buy\*" and Risk-Opt shows "Strong Buy\*" in both the Charts header and the detail sheet. The asterisk is never defined in the spec. It likely denotes a qualifier (e.g. low-confidence, based on limited data, extrapolated) but a user has no way to know. The asterisk meaning must be defined in the spec and a legend or tooltip added in the UI.

**D-14. Report metadata bar is unspecced (mockup)**
The Übersicht screen shows a bar above the table reading "Risk-On (2026-06-14) · Portfolio · 13 tickers · generated 2026-06-14 13:23:40." The spec describes no such bar. This is high-value context (market regime, scan freshness) that deserves a spec entry: what fields are shown, where the data comes from, and what "Risk-On/Risk-Off" means in this context.

**D-15. "→ Chart" button in detail sheet is unspecced but critical (mockup)**
The detail sheet has a full-width "→ Chart" button at the bottom that navigates to the Charts tab for the current ticker. This directly resolves the dead-end concern raised in UX-4/UX-5. It is the app's primary path from signal (Empfehlungen) to analysis (chart). The spec omits it entirely — it must be documented as a required element of the sheet, including: it should pre-select the ticker in Charts (matching the row-tap behaviour described on line 133) and dismiss the sheet on navigate.

**D-16. Charts header recommender summary is unspecced (mockup)**
Below the ticker dropdown in Charts, the mockup shows a compact inline summary: "CALN.SW · SIX · Rule Buy · ML Buy\* · Hindsight Buy · Risk-Opt Strong Buy\* · Swing Wait." This gives the user all signals at a glance without opening the sheet. The spec doesn't mention this summary line. Its content rules (which recommenders, in what order, which fields), colour coding, and update trigger (does it refresh when the ticker changes?) need to be specced.

---

## REVIEW 5: Observations from second mockup batch (Claude Sonnet 4.6 — 2026-06-14)

*Based on five new screenshots: Holdings preset picker, list picker, Übersicht full table + perf chart, Holdings table full view, Digest tab.*

---

### Compact table / Übersicht

**R5-1. Company name subtitle per row is unspecced (screenshots 1, 3, 4)**
Every row in the Compact table shows the company name on a second line below the ticker (e.g. "CALN.SW / CALIDA", "NUCL.L / VanEck Uranium and N..."). This is the single most important readability feature in the table and the spec never mentions it. It must be documented: is it always shown, or only in Compact mode? Is it part of the row data returned by the report API, or resolved separately? What truncation rule applies?

**R5-2. "Mixed ⚠" is an undocumented signal value (screenshots 1, 4)**
COIN, BRK-B, and BTC-USD show a yellow/amber "Mixed ⚠" badge in the Cons. column. The spec never defines this signal level — it only implies Buy/Sell/Hold variants. "Mixed" with a warning icon is a distinct semantic state (recommenders disagree) that needs a spec entry: what combination of recommender values produces it, what colour/icon it uses, and whether it can appear in other recommender columns or only in Cons.

**R5-3. "—" dash confirms the no-signal representation (screenshot 3, 4 — LS9UKD)**
LS9UKD shows "—" in the Cons. column. This answers C-4 from REVIEW 3: the no-signal representation is a dash. The spec should state this explicitly so it is implemented consistently across all recommender columns and in the detail sheet.

**R5-4. Holdings preset column set is now visible — clarifies C-1 partially (screenshot 4)**
The Holdings preset shows four columns: Ticker (with name subtitle), Δ1D, Cons., Value. This partially answers C-1 (preset column lists never defined). The spec should now enumerate all three presets explicitly. Holdings is confirmed; Signale and Technik remain unspecified.

**R5-5. Fourth column header is clipped on narrow screens (screenshots 1, 3, 4)**
The rightmost column header "Va..." is cut off on all three Übersicht screenshots — it appears to be "Value" but cannot be confirmed from the header alone. Four columns are tight on a portrait phone. The spec should either name this column precisely or require a horizontal scroll affordance with a visible overflow indicator.

**R5-6. "(exit 0)" exposes a process exit code to the user (screenshot 4)**
The scan status line reads "Letzter Scan: 14.6.2026, 13:40:48 (exit 0) · Nächster Scan: 15.6.2026, 00:00:00." The "(exit 0)" is internal system information — a Unix process exit code — that is meaningless to an end user and could be alarming if it ever shows a non-zero value without explanation. The spec should define what diagnostic information is shown in the scan status line and explicitly exclude raw exit codes from user-facing text.

**R5-7. Two timestamps conflict without explanation (screenshot 4)**
The metadata bar shows "generated 2026-06-14 13:23:40" while the scan status line shows "Letzter Scan: 14.6.2026, 13:40:48." These are 17 minutes apart and refer to different events (report generation vs. scan completion), but no label distinguishes them. A user seeing both will not understand why the times differ. The spec must define what each timestamp represents and require distinct labels.

**R5-8. List picker and preset picker are custom bottom sheets, not dropdowns (screenshots 1, 2)**
Both pickers open as scrollable bottom sheets with radio-button lists, not native `<select>` elements. The spec refers to them as dropdowns (`#report`, `#table-preset-sel`) which implies a very different component. This matters for: dismiss behaviour (tap-outside? swipe? back button?), keyboard accessibility, and whether a search/filter field is needed when the list grows long. The component type should be specified.

**R5-9. No visual distinction between built-in and user-created lists in the picker (screenshot 2)**
The list picker shows currencies, Watchlist, Screenlist_extended, SP500, SMI, Portfolio, Opportunity_Learning, Nasdaq100, Portfolio_old all with identical styling. The spec says built-in lists (Portfolio, Watchlist, Screenlist_extended) cannot be deleted — but the picker gives no visual cue about which lists are protected. A user cannot tell which lists they may manage. Built-in lists should be visually differentiated (e.g. a lock icon or a section divider).

**R5-10. "Portfolio_old" reveals an unspecced archiving convention (screenshot 2)**
A list named "Portfolio_old" appears in the picker alongside "Portfolio." The spec has no concept of versioned or archived lists — only built-ins and user-defined lists. If users can accumulate stale lists with no housekeeping guidance, the picker will grow without bound. The spec should address list naming conventions or provide a delete/archive flow.

**R5-11. Performance chart has no date range controls (screenshot 3)**
The portfolio performance chart shows all available history with no zoom or range buttons. The spec says it is "shown/hidden alongside the table via #perf-wrap" and says nothing else about it. Unlike the Charts tab (which has Full/120d/60d/14d buttons), the perf chart is always full-range. This should be a deliberate design decision that is stated in the spec, not an omission.

---

### Digest tab

**R5-12. Digest content is richer than the spec implies — D-1 requires nuancing (screenshot 5)**
The actual digest content is substantive: market regime with score, portfolio buy/sell signals, top movers by 4-day and 1-day return, Watchlist buy signals with entry dates, momentum leaders across the broader universe. This is materially useful for investment decisions. The earlier finding D-1 ("Digest is a dead end") remains valid in terms of *interactivity* (no ticker links, no drill-down), but the informational content is strong. The spec should describe the digest structure — sections, what data each covers — so the server-side generator and the PWA display are aligned on what the user expects to see.

**R5-13. Tickers in the Digest are plain text — D-1 confirmed (screenshot 5)**
"Auf KAUF stehen: BRK-B, BTC-USD, CALN.SW, COIN, DCUSAS.SW..." lists actionable tickers in plain text with no tap targets. This is the clearest case for ticker auto-linking in the app: these are the exact stocks the user should investigate next, and the app already has charts for all of them.

**R5-14. Umlauts are absent throughout the digest text (screenshot 5)**
"Groesste", "Schwaechste", "ueber" appear instead of "Größte", "Schwächste", "über." The server generates ASCII-only text. For a German-language app targeting Swiss/German users, this is a significant quality issue. The spec should either require UTF-8 output from the digest generator, or note that umlaut substitution is intentional (e.g. for legacy terminal compatibility) — but it should not be silent.

**R5-15. Digest timestamp is shown next to the refresh button — but spec doesn't mention it (screenshot 5)**
The "Aktualisieren" button is followed by "18:15:37" — the time of the last successful fetch. This is useful (it tells the user when the data was last retrieved, distinct from the scan timestamp embedded in the text). The spec mentions only a timestamp "extracted from the file content" (line 69), which is the scan time. The fetch time is a second, different timestamp displayed in the UI and not described in the spec.

**R5-16. "Seit mind." signals data gaps — not explained to the user (screenshot 5)**
Watchlist signals include "BAC (seit mind. 2025-08-18)" — "since at least," meaning the signal existed before the earliest available data point. This is a data-quality qualifier embedded in prose. A user who doesn't notice "mind." will misread the entry date. The spec should acknowledge data-gap handling in the digest and consider a more explicit indicator.

---

## REVIEW 6: Technik and Signale preset observations (Claude Sonnet 4.6 — 2026-06-14)

*Based on two new screenshots showing the Technik and Signale presets in the Übersicht Compact table.*

---

### Preset column sets — C-1 now largely resolved

**R6-1. All three preset column sets are now confirmed from mockups**
The screenshots resolve C-1 (preset column lists never defined in the spec):

| Preset | Columns visible |
|---|---|
| Holdings | Ticker+name, Δ1D, Cons., Value |
| Signale | Ticker+name, Rule, ML, Risk-Opt (+ more off-screen) |
| Technik | Ticker+name, RSI, 200DMA, 50DMA, [4th truncated — likely Mom14] |

These must be formally enumerated in the spec. The 4th columns of Signale and Technik remain unconfirmed due to truncation (see R6-2).

---

### Layout

**R6-2. Column header truncation is a systematic layout bug, not an edge case**
Both Technik ("Mo...") and Signale ("Risk-C...") clip their rightmost visible column header. The same problem appeared in Holdings ("Va...") in REVIEW 5. Every preset clips at least one header on a portrait phone. This means users cannot reliably know what the rightmost column contains. The spec must define a maximum column count per preset that fits without truncation, or require horizontal scrolling with sticky Ticker column and a visible overflow affordance (e.g. a fade or scroll indicator on the right edge).

---

### Signal vocabulary

**R6-3. "Sell" is an undocumented signal value (Signale preset screenshot)**
The Rule column shows a red "Sell" badge for COIN, BRK-B, and BTC-USD. The spec lists recommender tiles showing values like "Buy" and "Strong Buy" but never mentions "Sell." The complete signal vocabulary must be defined: at minimum Buy / Sell / Strong Buy / Wait / Mixed are confirmed from mockups. Are there others (Strong Sell, Hold, Neutral)? Each needs a colour, and each needs to be listed in the spec.

**R6-4. "Sell" (Rule) + "Buy\*" (ML) = "Mixed" Cons. — the derivation is unspecced**
COIN, BRK-B, and BTC-USD all show Rule=Sell alongside ML=Buy\*, and in the Holdings preset those same tickers showed "Mixed ⚠" in the Cons. column. This confirms that Mixed is produced by recommender disagreement. The spec must define the Cons. derivation rule: which recommenders are inputs, what combination of values produces Mixed vs. Buy vs. Strong Buy, and what the warning icon (⚠) means relative to "Mixed" without one.

**R6-5. ML Buy\* appears on every visible row — the asterisk may be a per-recommender flag, not per-signal**
In the Signale preset, every ML cell shows "Buy\*" — the asterisk is universal across all rows, not selective. If the asterisk were a per-signal qualifier (low confidence, limited data), it would be expected to vary by row. Its uniformity across all rows suggests it is a permanent attribute of the ML recommender itself (e.g. "ML model is experimental" or "predictions are probabilistic"). This is a materially different meaning from a per-row qualifier. The spec must clarify what the asterisk means and whether it belongs in the spec's recommender definition or in the per-signal data.

**R6-6. Risk-Opt shows Strong Buy for every visible holding — discriminatory value is unclear**
All eight visible rows in the Signale preset show Risk-Opt = Strong Buy. If Risk-Opt consistently outputs the same signal regardless of the stock, it adds no decision value to the Signale preset column. This may be a legitimate model characteristic (Risk-Opt is a portfolio-level optimiser that happens to be bullish in a Risk-On regime) or a data quality issue. The spec should describe what Risk-Opt measures and under what conditions it produces non-Buy signals, so users understand its role.

**R6-7. Rule and ML regularly disagree — no guidance on how to interpret the conflict**
COIN: Rule=Sell, ML=Buy\*. BRK-B: Rule=Sell, ML=Buy\*. BTC-USD: Rule=Sell, ML=Buy\*. These disagreements are the most actionable signal in the whole table — they flag stocks where two systems diverge — but the app provides no interpretation guidance. The Cons. column collapses the disagreement into "Mixed" without explaining what to do with it. The spec (and ideally the UI via a tooltip or legend) should describe the intended response to a Mixed signal: wait, investigate further, prefer one recommender over the other?

---

### Technik preset — data interpretation

**R6-8. 200DMA and 50DMA are shown as absolute prices, making cross-stock comparison meaningless**
The Technik preset shows 200DMA and 50DMA as raw price values (CALN.SW: 13.51 / 16.01; BTC-USD: 77.64k / 73.9k). A user scanning down the column cannot compare these numbers across stocks — a 200DMA of 13.51 for CALN.SW and 490.4 for BRK-B are on completely different scales. The analytically useful value is the *distance* from current price (e.g. price is 12% above its 200DMA), not the absolute DMA level. The spec should consider whether Technik columns should show relative distance (%) rather than absolute price, or at minimum note why absolute values were chosen.

**R6-9. The 4th Technik column is truncated and its sign appears meaningful**
The rightmost column in Technik is clipped to "Mo..." and shows partial red values for at least COIN ("-1...") and BTC-USD ("-1..."). Red colouring implies negative momentum. This column is likely Mom14 (14-day momentum), which appeared in the detail sheet Kennzahlen in the previous batch. If it is indeed a momentum metric, negative values are the most important signal in a technical preset — a user may never see the full value due to the truncation bug (R6-2).

---

## UX DESIGN CRITIQUE — Mockup gold standard (Claude Sonnet 4.6 — 2026-06-14)

*Note: REVIEWS 1–6 above mix spec-vs-mockup mismatches with UX observations. This section supersedes them for UX purposes. The mockups are treated as ground truth. Only real user experience problems are listed here, prioritised by impact.*

---

### P0 — Misleads or blocks the user

**U-1. The signal system has no legend anywhere in the app**
Users see green/red/amber badges (Buy, Sell, Strong Buy, Mixed ⚠), asterisks (Buy\*), dashes (—), and colour-coded percentages with no reference point anywhere. A first-time user — or a returning user who forgot — has no way to know that red means Sell, amber means disagreement, or that \* qualifies the ML recommender specifically. A persistent legend (even a single info icon that expands to a key) is the minimum fix. Without it the entire signal layer is opaque.

**U-2. "Mixed ⚠" tells the user nothing actionable**
The Cons. column collapses recommender disagreement into a single amber badge. From the mockups: COIN, BRK-B, and BTC-USD all show Rule=Sell alongside ML=Buy\* — the most interesting case in the portfolio, where two systems actively disagree. The user who sees "Mixed ⚠" on three of their thirteen holdings has no guidance: does Mixed mean wait? Investigate? Prefer one recommender? The badge surfaces a conflict but provides zero help resolving it. At minimum, tapping Mixed should open the detail sheet directly at Empfehlungen so the user can see which recommenders are disagreeing.

**U-3. The asterisk on ML signals means something but nothing tells the user what**
Every single ML cell shows "Buy\*" — the asterisk is universal, not per-row. A user scanning the Signale preset sees Buy\* for all holdings and has no idea whether the asterisk is a warning, a confidence qualifier, or a data-quality flag. If it marks the ML recommender as experimental or probabilistic, that context belongs in the column header or a tooltip, not silently appended to every value with no explanation.

**U-4. Rule=Sell and ML=Buy\* diverge on the same stock with no interpretation guidance**
Three holdings show a direct conflict between the two most prominent recommenders. The app collapses this to "Mixed" and moves on. A user looking at COIN (Rule=Sell, ML=Buy\*) is left with the hardest possible investment question — which signal to follow — and receives no help. The UI should at minimum indicate which recommender has the stronger recent track record, or link directly to the Chart where the historical signal accuracy is visible.

---

### P1 — Significant friction or data misread risk

**U-5. Column headers are truncated in every preset on a portrait phone**
Holdings clips "Va...", Signale clips "Risk-C...", Technik clips "Mo...". The clipped columns are not decorative — they contain position value, the top recommender, and momentum. A user cannot reliably know what they are reading in the rightmost column of any preset. Fix: either reduce each preset to three columns that fit, or implement horizontal scroll with a sticky Ticker column and a visible right-fade overflow indicator.

**U-6. Technik DMA columns are absolute prices — cross-stock comparison is impossible**
200DMA and 50DMA are raw price values (13.51 for CALN.SW, 490.4 for BRK-B, 77.64k for BTC-USD). Scanning down the column tells the user nothing meaningful because the scales are incomparable. The value a trader wants is the distance from current price — e.g. "price is 8% above its 200DMA" — not the raw moving average level. Showing percentage distance would make this column scannable and directly useful.

**U-7. Tickers named in the Digest are plain text with no tap target**
The Digest explicitly lists buy signals: "Auf KAUF stehen: BRK-B, BTC-USD, CALN.SW, COIN, DCUSAS.SW, GGRW.SW, NUCL.L, QQQ, SPICHA.SW, UHRN.SW, URTH." These are the stocks the user should investigate next. Tapping any of them does nothing. This is the clearest missed connection in the app: the Digest produces a ranked action list but the app provides no path from that list to the Chart or Übersicht for any of the named tickers.

**U-8. Two timestamps in Übersicht with no labels explaining the difference**
The metadata bar reads "generated 2026-06-14 13:23:40" and the line below reads "Letzter Scan: 14.6.2026, 13:40:48." These are 17 minutes apart. A user who notices both will be confused about which one reflects the data they are looking at. They refer to different events (report file creation vs. scan process completion) but there is no label explaining this. Rename "generated" to "Bericht erstellt" and the scan line already says "Letzter Scan" — the distinction just needs to be visible.

**U-9. "(exit 0)" is developer output exposed in the scan status line**
"Letzter Scan: 14.6.2026, 13:40:48 (exit 0)" shows a Unix process exit code to end users. Exit 0 is invisible noise today; a future exit 1 or exit 2 will alarm users without explaining what went wrong. Remove the exit code from the display entirely, or translate it: exit 0 → nothing shown, non-zero → "Scan fehlgeschlagen" with an error code for diagnostics.

**U-10. Darstellung (table layout) control is buried in the Info tab**
The selector that switches between Holdings, Signale, and Technik presets is visible in Übersicht directly. But the control that switches between Compact and Classic modes lives in the Info tab. A user who wants to change the display mode must leave Übersicht, navigate to Info, change the setting, and navigate back. Settings that visually control one tab should live on that tab, or at minimum be reachable without a tab switch.

**U-11. "Cache leeren & neu laden" has no confirmation and its consequence is invisible**
The button's amber border is the only warning signal. Tapping it clears all stored URLs and forces the user through the bootstrap Wi-Fi requirement again. On a phone away from home, this makes the app non-functional until the user is back on home Wi-Fi. A single confirmation dialog ("Alle lokal gespeicherten Daten werden gelöscht. Fortfahren?") would prevent accidental resets.

---

### P2 — Polish and readability

**U-12. Company names are truncated too aggressively in the Portfolio list**
In the Portfolio editor, names like "BBG ..." and "UBS ..." are cut to 5–7 characters. When multiple holdings are similar fund names, rows become indistinguishable. The two-line layout used in Übersicht (full ticker on line 1, company name on line 2 with graceful truncation) should be applied to the Portfolio list as well.

**U-13. No swipe-down to dismiss the detail bottom sheet**
Tap-outside is the only dismiss path. On mobile, the standard gesture for a bottom sheet is a downward swipe. The absence of swipe-to-dismiss feels broken on Android and iOS, even if tap-outside technically works.

**U-14. The performance chart has no date range control**
The portfolio value chart below the Übersicht table shows all available history with no zoom. Every other chart in the app (Charts tab) has range buttons. A user who wants to see only the last 3 months of portfolio performance has no way to do so. A minimal set of range buttons (3M, 6M, 1Y, All) would make the chart far more useful.

**U-15. Umlauts are absent throughout the Digest text**
"Groesste", "Schwaechste", "ueber" instead of "Größte", "Schwächste", "über" throughout the German-language digest. For a Swiss/German-market app this is a noticeable quality signal. The server-side digest generator should output UTF-8.

**U-16. The list picker grows without bound and has no search**
The list dropdown already contains 9+ lists (currencies, Watchlist, Screenlist\_extended, SP500, SMI, Portfolio, Opportunity\_Learning, Nasdaq100, Portfolio\_old). As users create more lists, the picker becomes a scroll hunt with no way to jump to a specific name. A search/filter field at the top of the picker would cost little and scale to any number of lists.

---

## UX REDUNDANCY & INCONSISTENCY AUDIT (Claude Sonnet 4.6 — 2026-06-14)

*Based on all mockups. Mockup is ground truth.*

---

### Redundancy — same data shown multiple times

**RI-1. Recommender signals appear in three separate places for the same stock**
When a user opens a stock from Übersicht (Compact) and taps "→ Chart," they see recommender signals three times:
1. Signale preset table row (Rule / ML / Risk-Opt columns)
2. Detail sheet Empfehlungen section (all six recommenders as large tiles)
3. Charts tab header summary line (inline "Rule Buy · ML Buy\* · ...")

Each repetition uses a different visual treatment (column badge → labeled tile → inline text). The user gains no new information on the second or third encounter. The Charts header summary is the most compact and contextually useful; the table columns serve their purpose for scanning. The detail sheet Empfehlungen sits between them and adds little beyond what the table already showed for a user arriving from the Signale preset.

**RI-2. Δ1D and Value are duplicated between the Holdings table and the detail sheet**
Holdings preset shows Δ1D and Value per row. Tapping that row opens the detail sheet, where Kennzahlen immediately repeats Δ1D and Value as the first two tiles. The user sees the same two numbers they just read in the table. The detail sheet should complement the table, not repeat it — prioritise metrics not visible in the current preset.

**RI-3. RSI is shown in three places for the same ticker**
RSI appears in the Technik preset table, in the detail sheet Kennzahlen, and as a dedicated sub-chart in the Charts tab. The number is identical in all three. A single consistent place (the Charts tab, where context and history are visible) is the authoritative home for RSI; the other appearances are redundant once the user learns this.

**RI-4. "Aktualisieren" button exists in two tabs doing different things**
Digest tab: "Aktualisieren" fetches a fresh digest file. Info tab: "Aktualisieren" re-runs all connection and health probes. Same label, same visual style, completely different actions. A user who remembers tapping "Aktualisieren" once may tap the wrong one. Rename one of them — e.g. "Verbindung prüfen" in Info — to make the distinction explicit.

**RI-5. List selection is duplicated across two tabs with two different UI patterns**
Both Übersicht and Portfolio allow the user to select a list. In Übersicht it is a dropdown that opens a scrollable radio-button sheet. In Portfolio it is a row of horizontal chip buttons. The same set of lists is selectable in both places through entirely different interactions. If the goal is to review a list's scan results, the user may not realise they need to go to Übersicht — the chip row in Portfolio implies they can do it there. Consider making list selection a single shared control, or clearly differentiate the purpose of each view (Portfolio = edit members, Übersicht = view scan results).

---

### Inconsistency — same concept treated differently

**RI-6. Date format used five different ways in the same app**
Across the visible screens, dates appear as:
- `2026-06-14` — ISO, in metadata bar and Digest header
- `14.6.2026` — German dot format, in scan status line
- `2026-06-14 · 13` — ISO with scan index, in date dropdown
- `14. Juni 2026` — full German long form, in Digest body text
- `2026-05-11` — ISO again, inside the Digest watchlist section

A user reading the scan status line and the metadata bar in the same view sees two different date formats for the same day. Pick one format (German short form `14.06.2026` is conventional for the target audience) and apply it everywhere.

**RI-7. Ticker + company name order is inconsistent across tabs**
- Übersicht table: ticker on line 1, company name as smaller subtitle on line 2 (`CALN.SW` / `CALIDA`)
- Charts dropdown: full name first, ticker in parentheses (`CALIDA (CALN.SW)`)
- Detail sheet header: ticker prominent, name and exchange after a dot (`CALN.SW` then `CALIDA · SIX`)
- Portfolio table: ticker and name in separate fixed-width columns, both at the same visual weight

The user's mental model of "which is the primary identifier" should be consistent. Ticker is the scannable key; name provides context. The Übersicht two-line layout is the most readable pattern — it should be the standard used everywhere.

**RI-8. Signal values are rendered four different ways**
The same Buy/Sell/Strong Buy signal for the same stock appears as:
- A coloured pill badge with rounded corners (Übersicht table columns)
- A large tile with a label row and a value row (detail sheet Empfehlungen)
- Small inline coloured text with a dot separator (Charts header summary)
- Plain uppercase text (Digest body)

There is no visual system tying these together. A user who learns to recognise a green "Buy" badge in the table will not immediately connect it to "Buy" as plain text in the Digest or as a large tile in the sheet. A consistent signal token (same shape, same colour palette, same typography weight) used at appropriate sizes across all contexts would make the signal vocabulary learnable once and readable everywhere.

**RI-9. Navigation to Charts requires a different number of taps depending on mode**
- Classic mode: 1 tap on a row → arrives in Charts
- Compact mode: 1 tap on a row → bottom sheet opens → 1 tap on "→ Chart" → arrives in Charts

This is a 2× difference in tap cost for identical user intent. In `auto` mode (portrait → Compact, landscape → Classic) the tap cost changes when the user rotates their phone. The inconsistency is not just cosmetic — users who mostly use portrait mode pay a consistent tax that Classic users do not.

**RI-10. Currency precision is inconsistent for the same value**
CALN.SW Exposure appears as `366.66` in the Portfolio editor and `366.7` in the detail sheet Kennzahlen. The same CHF amount rendered at different decimal places will make a user distrust either number. A single formatting rule (the `fSig` 4-significant-figures formatter already used in Übersicht) should apply uniformly to monetary values in every view.

**RI-11. Button visual language does not communicate action hierarchy**
Across the app, buttons look nearly identical regardless of their consequence:
- "+ Zeile", "Speichern", "Neu laden", "Jetzt scannen", "Export" in Portfolio — all same pill shape, same weight
- "Aktualisieren" and "Cache leeren & neu laden" in Info — same pill shape; only the amber border distinguishes the destructive action
- "→ Chart" in the detail sheet — full-width, different weight

There is no consistent system: primary actions, secondary actions, and destructive actions all look similar. At minimum, destructive actions (cache clear) should use a distinct colour (red or outlined), and primary call-to-action buttons (→ Chart, Jetzt scannen) should have a filled primary colour to stand out from utility buttons.

---

## DIGEST UX DEEP-DIVE (Claude Sonnet 4.6 — 2026-06-14)

*The Digest content is genuinely strong — market regime, buy/sell signals, momentum leaders, watchlist entry dates. The problems are entirely in how that content is presented. Every suggestion below is about surfacing what's already there.*

---

### The content has a natural hierarchy that the UI ignores

The Digest text has four distinct sections with very different urgency levels:

1. **Action items** — current buy/sell signals for owned holdings (highest urgency)
2. **Market context** — regime, breadth, VIX (medium urgency, read once)
3. **Watchlist signals** — opportunities not yet owned (medium urgency)
4. **Broad universe** — momentum leaders across 700+ stocks (low urgency, exploratory)

All four are rendered as undifferentiated paragraphs in a monospace card. A user opening the app to act on today's signals must read the entire text to find them. The hierarchy should be visual: action items at the top as a scannable section, context below, watchlist and universe below that — collapsed by default if the user has already read them.

---

### The single most important line is buried in prose

**DX-1. "Auf KAUF stehen" is the Digest's primary deliverable — it needs to be the first thing the user sees**
The buy-signal list ("BRK-B, BTC-USD, CALN.SW, COIN, DCUSAS.SW, GGRW.SW, NUCL.L, QQQ, SPICHA.SW, UHRN.SW, URTH") is in the third sentence of the second paragraph. On a phone, this is below the fold and buried inside a dense paragraph. These are the stocks the system recommends acting on today. They should appear at the very top of the tab as a horizontal scrollable row of tappable ticker chips — visible the instant the Digest tab opens, before the user reads a single word of prose.

**DX-2. "Aktuell keine Position auf VERKAUF" is equally important but has no visual presence**
When there are no sell signals, this line is a quiet reassurance buried in prose. When there *are* sell signals, they will presumably also appear in prose — which is the worst possible treatment for urgent information. A sell signal on a holding is the most time-sensitive alert in the app. It should render as a visually distinct block (red banner, prominent badge) regardless of whether there are one or ten sell signals. The current prose treatment makes sell signals look the same as everything else.

---

### Actionability gaps

**DX-3. Watchlist buy signals with entry dates are presented as a paragraph, not a list**
"APH (seit 2026-05-11), BAC (seit mind. 2025-08-18), CME (seit mind. 2025-08-18), D5BI.DE (seit 2025-11-11), DCUSAS.SW (seit 2025-09-09) ...und 17 weitere." This is a data table disguised as prose. Each entry has exactly two fields: ticker and entry date. Rendering it as an actual list or table — one ticker per row, entry date right-aligned — makes it scannable in seconds instead of requiring line-by-line reading. The entry date is valuable (it tells the user how long a signal has been active, which affects conviction) and gets lost in the current format.

**DX-4. "...und 17 weitere" hides actionable data with no way to expand**
The Watchlist buy signal list is truncated. 22 tickers are on buy signal but the user sees 5. There is no "show all" button, no link to Übersicht pre-filtered to Watchlist buy signals, nothing. The 17 hidden tickers include potential trades the user may not notice. Either show all of them (it's a list, not a paragraph — length is manageable) or provide a "Alle anzeigen in Übersicht" tap target that navigates directly to Watchlist scan results.

**DX-5. Momentum leaders in the broad universe are unactionable without a direct path to add them**
"Staerkste Dynamik (21 Tage): CURV +40.4%, SNDR +31.8%, MGM +30.9%, DNUT +30.2%, VRNS +23.4% ...und 6 weitere." These are stocks not in the user's watchlist that showed the strongest momentum in a 700+ ticker universe. This is discovery content — exactly what a scanner exists for. But tapping any of these tickers does nothing. A long-press or swipe action to add a ticker directly to the Watchlist from this list would close the full loop: discover in Digest → add to Watchlist → include in next scan.

---

### Presentation issues

**DX-6. Market regime appears as a badge in Übersicht but as buried prose in Digest**
"Risk-On (2026-06-14)" is rendered as a prominent green badge in the Übersicht metadata bar. In the Digest, the same information reads "Das Marktregime ist konstruktiv (Risk-On)." The badge is far more scannable and takes less reading time. The Digest should open with the same Risk-On / Risk-Off badge — identical to Übersicht — as a one-glance status before the user reads anything else.

**DX-7. Monospace font is the wrong choice for prose content**
The Digest is displayed in what appears to be a monospace or quasi-monospace typeface (consistent character width visible in the screenshot). Monospace is correct for code, terminal output, or fixed-column data. For a German-language narrative text with variable-length words and natural line breaks, a proportional sans-serif font would be significantly easier to read and would fit more content per line.

**DX-8. The fetch timestamp and the scan timestamp are both visible but never connected**
"Aktualisieren 18:15:37" (fetch time) sits next to the button. The text begins "Bericht basiert auf dem Scan von 13:23 Uhr" (scan time). The 5-hour gap between these two times is not surfaced — a user skimming may assume the data is from 18:15 when it actually reflects a scan completed 5 hours earlier. A single unified freshness indicator ("Scan 13:23 · Abgerufen 18:15") directly under the header would make data age immediately visible.

