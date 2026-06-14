/**
 * sw.js — Service Worker for the StockScanner PWA (offline app shell).
 *
 * Adapted from the family PWA. One cache:
 *
 *  APP_SHELL ("shell-vN"): all static files that make up the app (HTML, CSS,
 *    JS). Strategy: cache-first — serve from cache, fall back to network and
 *    store the result. Bump VERSION to push a new shell to all clients.
 *
 * Local server requests (server.local, *.ts.net, Tailscale/LAN IP ranges) are
 * NEVER intercepted: they carry the Authorization header and must always return
 * fresh data, so caching them here would break auth and show stale reports.
 *
 * Keep VERSION in sync with CONFIG.APP_VERSION in src/config.js.
 */
const VERSION   = 'v1.6.0';
// App-specific prefix avoids cross-contamination with other PWAs on the same
// GitHub Pages origin whose caches are visible via the shared caches API.
const APP_SHELL = 'ss-shell-' + VERSION;

// Static files cached on install. If any fails to download, install aborts.
const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './src/main.js',
  './src/config.js',
  './src/auth.js',
  './src/localBridge.js',
  './src/siteConfig.js',
  './src/viewer.js',
  './src/tabs.js',
  './src/info.js',
  './src/portfolio.js',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(APP_SHELL);
    // Fetch shell assets with cache:'reload' so we bypass the browser HTTP cache
    // (GitHub Pages sends max-age=600). Otherwise a still-fresh stale copy can get
    // baked into this SW cache and, since SW caches ignore max-age, served forever.
    await cache.addAll(SHELL_ASSETS.map(u => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    // Only delete caches that belong to this app (own prefix or legacy unprefixed
    // names). Never touch caches owned by other apps on the same origin.
    await Promise.all(
      keys.filter(k =>
        k !== APP_SHELL && (k.startsWith('ss-shell-') || k.startsWith('shell-'))
      ).map(k => caches.delete(k))
    );
    self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // ── Local / private server (LAN, mDNS, Tailscale) ────────────────────
  // Never intercept — these need auth headers and fresh data. Returning
  // without calling e.respondWith() lets the browser handle them directly.
  if (url.hostname.endsWith('.local') ||
      url.hostname.endsWith('.ts.net') ||
      /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(url.hostname) ||
      /^192\.168\./.test(url.hostname) ||
      /^10\./.test(url.hostname)) {
    return;
  }

  // ── App shell (same origin = GitHub Pages) ───────────────────────────
  // Cache-first; on a miss, fetch and store so the app works offline.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(APP_SHELL).then(c => c.put(e.request, copy));
        }
        return resp;
      }))
    );
  }
  // Anything else: let the browser handle it (there are no third-party APIs).
});
