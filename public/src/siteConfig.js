/**
 * siteConfig.js — Fetches the off-LAN bases from the local server and caches
 * them so probeBase() can reach the server via the direct LAN IP or Tailscale
 * (neither of which is shipped in the public bundle).
 *
 * Mirrors the family PWA's siteConfig, trimmed to just the server bases.
 * Called once the token is set and the server is reachable (see main.js).
 */
import { CONFIG } from './config.js';
import { getActiveBase, authHeaders } from './localBridge.js';

const BASES_KEY = 'pwa.bases'; // same key localBridge.readCachedBases() reads

/**
 * GET /api/stocks/config → { bases: { lan_ip, ts } }, cached in localStorage.
 * Returns the parsed config, or null on failure (cached bases stay as-is).
 */
export async function refreshConfig() {
  try {
    const r = await fetch(getActiveBase() + CONFIG.STOCKS_CONFIG_PATH, {
      headers:     authHeaders(),
      cache:       'no-store',
      credentials: 'omit',
    });
    if (!r.ok) return null;
    const cfg = await r.json();
    if (cfg && cfg.bases) {
      try { localStorage.setItem(BASES_KEY, JSON.stringify(cfg.bases)); } catch {}
    }
    return cfg;
  } catch {
    return null;
  }
}
