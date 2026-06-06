/**
 * main.js — Boot + connection orchestration for the StockScanner PWA.
 *
 * Flow (mirrors the family PWA, trimmed to one data source):
 *   1. Register the service worker (offline shell).
 *   2. initViewer() — wire the table / chart / report-selector UI (no fetch yet).
 *   3. probeBase() — pick the fastest reachable server base (mDNS / LAN / Tailscale).
 *   4. refresh() — if a token is set and the server answers, fetch the bases
 *      (/api/stocks/config), then load the report manifest + newest report.
 *   5. Poll health every 30 s; toggle the offline banner / status dot and reload
 *      the data when the server comes back.
 *
 * The only "internal" value on the device is the shared token (auth.js). The
 * public bundle contains nothing but the generic server.local hostname.
 */
import { probeBase, isLocalAvailable, invalidateLocal, getActiveBase, authHeaders } from './localBridge.js';
import { CONFIG } from './config.js';
import { getToken, setToken, hasToken } from './auth.js';
import { refreshConfig } from './siteConfig.js';
import { initViewer, loadReports, setViewerError } from './viewer.js';

const $ = s => document.querySelector(s);

let lastOnline = null; // tracks offline→online transitions for auto-reload

// ── Status / offline UI ─────────────────────────────────────────────────────
function setStatusDot(online) {
  $('#status-dot')?.classList.toggle('online', online);
  // Only nag about being offline once the user has a token (i.e. expects data).
  $('#offline')?.classList.toggle('visible', hasToken() && !online);
  window.dispatchEvent(new CustomEvent('pwa:server', { detail: online }));
}

function showSetup(show) {
  const card = $('#setup');
  if (card) card.hidden = !show;
}

/** Fetches scheduler status and shows "updated / next scan" under the header. */
async function updateStatusLine() {
  const line = $('#status-line');
  if (!line) return;
  try {
    const r = await fetch(getActiveBase() + CONFIG.STOCKS_STATUS_PATH, {
      headers: authHeaders(), cache: 'no-store', credentials: 'omit',
    });
    if (!r.ok) { line.textContent = ''; return; }
    const s = await r.json();
    const next = s.nextRun ? new Date(s.nextRun).toLocaleString() : '—';
    const parts = [`Nächster Scan: ${next}`];
    if (s.running) parts.unshift('Scan läuft…');
    else if (s.lastRun) parts.unshift(`Letzter Scan: ${new Date(s.lastRun).toLocaleString()} (exit ${s.lastExit})`);
    line.textContent = parts.join(' · ');
  } catch {
    line.textContent = '';
  }
}

// ── Core refresh ─────────────────────────────────────────────────────────────
async function refresh() {
  if (!hasToken()) { showSetup(true); setStatusDot(false); return; }
  showSetup(false);

  const online = await isLocalAvailable();
  setStatusDot(online);
  if (!online) { setViewerError('Server nicht erreichbar.'); return; }

  await refreshConfig();           // cache lan_ip + ts for off-home access
  try {
    await loadReports();           // index + newest report → table + charts
    updateStatusLine();
  } catch (e) {
    if (String(e?.message) === 'unauthorized') {
      showSetup(true);
      setViewerError('Token abgelehnt — bitte erneut eingeben.');
    } else {
      setViewerError('Daten konnten nicht geladen werden.');
    }
  }
}

// ── Setup card wiring ────────────────────────────────────────────────────────
function wireSetup() {
  $('#token-save')?.addEventListener('click', () => {
    const input = $('#token-input');
    const t = (input?.value || '').trim();
    if (!t) return;
    setToken(t);
    if (input) input.value = '';
    invalidateLocal();
    refresh();
  });
  $('#token-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') $('#token-save')?.click();
  });
  // Header gear toggles the setup card (to change/clear the token, or open the
  // certificate-install guide).
  $('#settings-btn')?.addEventListener('click', () => {
    const card = $('#setup');
    if (card) {
      card.hidden = !card.hidden;
      if (!card.hidden && hasToken()) $('#token-input')?.focus();
    }
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  initViewer();
  wireSetup();

  await probeBase();
  await refresh();
  lastOnline = await isLocalAvailable();

  // Poll the server every 30 s: update the dot, and reload data when the
  // server comes back after being unreachable.
  setInterval(async () => {
    if (!hasToken()) return;
    invalidateLocal();
    const online = await isLocalAvailable();
    setStatusDot(online);
    if (online && !lastOnline) refresh();      // offline → online: reload
    else if (online) updateStatusLine();
    lastOnline = online;
  }, 30_000);

  // Reload immediately when the device rejoins a network.
  window.addEventListener('online', () => { invalidateLocal(); refresh(); });
})();
