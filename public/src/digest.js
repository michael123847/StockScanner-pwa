/**
 * digest.js — Fetch and render the daily digest in the Digest tab.
 */
import { CONFIG } from './config.js';
import { getActiveBase, authHeaders } from './localBridge.js';

const $ = s => document.querySelector(s);

let _loaded = false;

async function loadDigest() {
  const body  = $('#digest-body');
  const err   = $('#digest-error');
  const stamp = $('#digest-stamp');

  if (!body) return;
  err.style.display = 'none';

  try {
    const r = await fetch(getActiveBase() + CONFIG.STOCKS_DIGEST_PATH, {
      headers: authHeaders(),
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!r.ok) {
      const msg = r.status === 404
        ? 'Noch kein Digest vorhanden — Scan ausstehend.'
        : `Fehler ${r.status}`;
      err.textContent = msg;
      err.style.display = 'block';
      body.textContent = '';
      return;
    }
    const text = await r.text();
    body.textContent = text;
    _loaded = true;
    if (stamp) stamp.textContent = new Date().toLocaleTimeString();
  } catch {
    err.textContent = 'Digest konnte nicht geladen werden.';
    err.style.display = 'block';
  }
}

export function initDigest() {
  $('#digest-refresh')?.addEventListener('click', loadDigest);

  // Load once when the tab is first activated.
  window.addEventListener('pwa:tab', e => {
    if (e.detail === 'digest' && !_loaded) loadDigest();
  });

  // Reload when server comes back online (same pattern as viewer).
  window.addEventListener('pwa:server', e => {
    if (e.detail && document.getElementById('page-digest')?.classList.contains('active')) {
      loadDigest();
    }
  });

  // Auto-refresh when the nightly scan completes.
  window.addEventListener('pwa:scan-done', () => {
    _loaded = false;   // invalidate cache
    if (document.getElementById('page-digest')?.classList.contains('active')) {
      loadDigest();    // tab is open: reload immediately
    }
    // if tab is closed, _loaded=false ensures it fetches fresh on next open
  });
}
