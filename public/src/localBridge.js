/**
 * localBridge.js — Connection bridge to the local server.
 *
 * Reused from the family PWA. Two responsibilities:
 *
 *  1. **Base-URL routing.** The server is reachable under three hostnames,
 *     but only one is hard-coded in the public bundle:
 *       - `CONFIG.LAN_BASE` (server.local, mDNS) — always known.
 *       - `bases.lan_ip` (direct LAN IP) and `bases.ts` (Tailscale MagicDNS)
 *         are fetched from /api/stocks/config on first contact and cached in
 *         localStorage; see siteConfig.js.
 *     probeBase() races whichever candidates are currently available; the
 *     first to answer wins, and the choice is persisted across reloads so
 *     a cold start doesn't have to race again. On failure we fall back to
 *     the cached Tailscale URL (works off the home network) or LAN_BASE.
 *
 *  2. **Availability + auth helpers.** isLocalAvailable() pings the health
 *     endpoint (cached 30 s) so the UI can show an offline banner.
 *     authHeaders() returns the Bearer-token header (the shared token from
 *     auth.js).
 *
 * The probe is rerun on the browser `online` event so a phone moving from
 * cellular onto home Wi-Fi (or vice versa) picks up the better path.
 */

import { CONFIG } from './config.js';
import { getToken, clearToken } from './auth.js';

// Cached availability result. null means "not checked yet".
let _available = null;
// Timestamp (ms) of the last health check.
let _lastCheck = 0;
// How long to trust the cached result before sending a new health check.
const TTL = 30_000; // 30 seconds

// Persisted across page loads — last base URL that successfully answered the
// health probe. On cold boot, getActiveBase() returns this BEFORE probeBase()
// completes, so isLocalAvailable() and the UI start with a sensible guess.
const ACTIVE_BASE_KEY = 'pwa.activeBase';
let _activeBase = (() => {
  try { return localStorage.getItem(ACTIVE_BASE_KEY); } catch { return null; }
})();

/**
 * Returns the Authorization header needed for local server requests.
 * Returns an empty object if no token is stored yet.
 * @returns {{ Authorization: string } | {}}
 */
export function authHeaders() {
  const t = getToken();
  return t ? { Authorization: 'Bearer ' + t } : {};
}

/**
 * Returns the base URL the rest of the app should use for server calls.
 * Before probeBase() resolves: prefer the persisted active base from the
 * previous session, else the cached Tailscale URL (works off-LAN), else
 * LAN_BASE as a last resort.
 */
export function getActiveBase() {
  if (_activeBase) return _activeBase;
  const bases = readCachedBases();
  return bases.ts || CONFIG.LAN_BASE;
}

// Same localStorage key siteConfig.js writes to.
const BASES_KEY = 'pwa.bases';
function readCachedBases() {
  try { return JSON.parse(localStorage.getItem(BASES_KEY)) || {}; }
  catch { return {}; }
}

/**
 * Probes all candidate base URLs IN PARALLEL and uses whichever responds
 * first: LAN_BASE (mDNS), bases.lan_ip (cached LAN IP), bases.ts (Tailscale).
 * Only LAN_BASE is hard-coded; the others are cached after the first
 * /api/stocks/config fetch. Any HTTP response (even 401) counts as success —
 * we just need to prove TLS + routing work. The winner is persisted as a hint
 * for faster cold-start decisions.
 */
export async function probeBase() {
  const bases = readCachedBases();
  const candidates = [CONFIG.LAN_BASE, bases.lan_ip, bases.ts].filter(Boolean);
  const timeout    = CONFIG.HEALTH_TIMEOUT_MS;

  const racers = candidates.map(async base => {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(base + CONFIG.LOCAL_HEALTH_PATH, {
        signal:      ctrl.signal,
        cache:       'no-store',
        credentials: 'omit',
      });
      console.log(`[probeBase] ${base} → HTTP ${r.status}`);
      return base;
    } catch (e) {
      console.log(`[probeBase] ${base} → failed: ${e?.message || e}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  });

  let chose;
  try {
    chose = await Promise.any(racers); // first success wins
  } catch {
    // All candidates failed. Prefer the cached Tailscale URL if we have one
    // (works off the home network); otherwise fall back to LAN_BASE.
    chose = bases.ts || CONFIG.LAN_BASE;
  }

  const previous = _activeBase;
  _activeBase = chose;
  console.log(`[probeBase] active base = ${chose}`);
  try { localStorage.setItem(ACTIVE_BASE_KEY, chose); } catch {}
  if (previous !== chose) invalidateLocal();
}

// Re-probe whenever the device transitions back online (Wi-Fi reconnect, etc).
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { probeBase(); });
}

/**
 * Checks whether the local server is currently reachable on the active base.
 * Uses a 30-second cache to avoid spamming health checks.
 * @returns {Promise<boolean>}
 */
export async function isLocalAvailable() {
  const now = Date.now();
  if (_available !== null && now - _lastCheck < TTL) return _available;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.HEALTH_TIMEOUT_MS);

  try {
    const r = await fetch(getActiveBase() + CONFIG.LOCAL_HEALTH_PATH, {
      signal:      ctrl.signal,
      cache:       'no-store',
      credentials: 'omit',
      headers:     authHeaders(),
    });
    // Health is public, so a 401 would be unusual; treat anything non-ok as down.
    _available = r.ok;
  } catch {
    _available = false;
  } finally {
    clearTimeout(timer);
    _lastCheck = now;
  }

  return _available;
}

/**
 * Resets the availability cache so the next isLocalAvailable() call sends a
 * fresh health check. Called when a request fails unexpectedly or the active
 * base changed.
 */
export function invalidateLocal() { _available = null; }
