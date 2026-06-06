/**
 * auth.js — Minimal shared-token store for the StockScanner PWA.
 *
 * Unlike the family PWA (per-device enrollment + roles), this app uses a single
 * shared Bearer token, entered once by the user and kept in localStorage. The
 * token is the only "internal" thing on the device — it is never in the public
 * repo. localBridge.authHeaders() attaches it to every server request.
 *
 * The public API mirrors the bits localBridge.js imports from the family
 * auth.js (getToken / clearToken), so localBridge can be reused verbatim.
 */
const TOKEN_KEY = 'pwa.stocks.token';

/** The stored token, or '' if none has been set yet. */
export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

/** Stores (or, with a falsy value, clears) the token. */
export function setToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else   localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode / storage disabled — ignore */ }
}

/** Removes the stored token (e.g. after the server rejects it with 401). */
export function clearToken() { setToken(''); }

/** True once a token has been entered. */
export function hasToken() { return !!getToken(); }
