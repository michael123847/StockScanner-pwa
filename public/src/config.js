/**
 * config.js — Central configuration for the StockScanner PWA.
 *
 * Security note about server URLs (same approach as the family PWA):
 *   Only LAN_BASE (the generic mDNS hostname server.local) is hard-coded here.
 *   The direct LAN IP and the Tailscale MagicDNS name are NOT shipped in the
 *   public GitHub Pages bundle — they would identify the home network to anyone
 *   reading the JS. The PWA fetches them at runtime from the local server's
 *   /api/stocks/config endpoint (gated by the shared token) and caches them in
 *   localStorage. See src/siteConfig.js and src/localBridge.js -> probeBase().
 *
 *   Bootstrap path for a fresh install: the device must be on the home Wi-Fi
 *   so mDNS resolves server.local; after one successful connection the bases
 *   are cached and subsequent cold starts (incl. off-home via Tailscale) work.
 */
export const CONFIG = {
  // Single source of truth: version.js (loaded before this module by
  // index.html; sw.js importScripts the same file). Bump ONLY version.js.
  // Fallback covers non-browser/module-only contexts (tests, tooling).
  APP_VERSION: globalThis.__APP_VERSION || 'dev',

  // Only the generic mDNS hostname is public; lan_ip + ts come from
  // /api/stocks/config and are cached in localStorage (see siteConfig.js).
  LAN_BASE:   'https://server.local:8443',
  LOCAL_BASE: 'https://server.local:8443',

  // Endpoints on the companion server (proxied by Caddy under /api/stocks/*).
  LOCAL_HEALTH_PATH:  '/api/stocks/health',  // public probe target
  STOCKS_CONFIG_PATH: '/api/stocks/config',  // { bases: { lan_ip, ts } }
  STOCKS_INDEX_PATH:  '/api/stocks/index',   // report manifest (newest first)
  STOCKS_REPORT_PATH: '/api/stocks/report',  // ?file=<name>.json
  STOCKS_STATUS_PATH: '/api/stocks/status',  // scheduler status
  STOCKS_RUN_PATH:       '/api/stocks/run',        // POST → trigger a scan now
  STOCKS_EXPORT_PATH:    '/api/stocks/export',     // POST ?list=Portfolio  regen Excel
  STOCKS_PORTFOLIO_PATH: '/api/stocks/portfolio',  // GET/PUT ?list=Portfolio
  STOCKS_LISTS_PATH:     '/api/stocks/lists',      // GET/POST/PATCH/DELETE list registry
  STOCKS_MOVE_PATH:      '/api/stocks/portfolio/move', // POST ?from=X&to=Y
  STOCKS_SEARCH_PATH:    '/api/stocks/search',     // GET ?q=<text>  Yahoo Finance lookup
  STOCKS_SERIES_PATH:    '/api/stocks/series',     // GET ?list=&ticker=&asof=  per-list series store
  STOCKS_DIGEST_PATH:    '/api/stocks/digest',     // GET → digest_latest.txt as text/plain
  STOCKS_DIGEST_MD_PATH: '/api/stocks/digest.md',  // GET → digest_latest.md as text/markdown
  STOCKS_PORTFOLIO_SERIES_PATH: '/api/stocks/portfolio_series', // GET ?list=<label>
  STOCKS_ALLOCATION_PATH: '/api/stocks/allocation', // GET → allocation_scheme5.json (scheme-#5 sleeves)

  // Abort a health check after this long to avoid long waits on unreachable
  // candidates while probeBase() races them.
  HEALTH_TIMEOUT_MS: 1500,
};
