/**
 * main.js — Boot + connection orchestration for the StockScanner PWA.
 *
 * Flow (mirrors the family PWA, trimmed to one data source):
 *   1. Register the service worker (offline shell).
 *   2. initTabs() — wire bottom-tab navigation.
 *   3. initViewer() — wire the table / chart / report-selector UI (no fetch yet).
 *   4. initInfo() — wire the Info & Diagnose tab.
 *   5. probeBase() — pick the fastest reachable server base (mDNS / LAN / Tailscale).
 *   6. refresh() — if a token is set and the server answers, fetch the bases
 *      (/api/stocks/config), then load the report manifest + newest report.
 *   7. Poll health every 30 s; toggle the offline banner / status dot and reload
 *      the data when the server comes back.
 *
 * The only "internal" value on the device is the shared token (auth.js). The
 * public bundle contains nothing but the generic server.local hostname.
 */
import { probeBase, isLocalAvailable, invalidateLocal, getActiveBase, authHeaders } from './localBridge.js';
import { CONFIG } from './config.js';
import { fmtDateTime } from './format.js';
import { getToken, setToken, hasToken } from './auth.js';
import { refreshConfig } from './siteConfig.js';
import { initViewer, loadReports, setViewerError } from './viewer.js';
import { initTabs } from './tabs.js';
import { initInfo } from './info.js';
import { initPortfolio } from './portfolio.js';
import { initDigest } from './digest.js';

const $ = s => document.querySelector(s);

let lastOnline  = null; // tracks offline→online transitions for auto-reload
let lastRunning = null; // tracks scan running→done transitions for digest refresh

// ── Status / offline UI ─────────────────────────────────────────────────────
// Showing the offline banner is debounced (delayed) so a transient false
// reading before the first health probe settles doesn't flash it at boot;
// hiding it stays instant once the server answers.
let offlineBannerTimer = null;
function setStatusDot(online) {
  const dot = $('#status-dot');
  dot?.classList.toggle('online', online);
  dot?.classList.toggle('offline', !online);
  // Only nag about being offline once the user has a token (i.e. expects data).
  const shouldShow = hasToken() && !online;
  if (shouldShow) {
    if (!offlineBannerTimer) {
      offlineBannerTimer = setTimeout(() => {
        offlineBannerTimer = null;
        $('#offline')?.classList.add('visible');
      }, 1500);
    }
  } else {
    if (offlineBannerTimer) { clearTimeout(offlineBannerTimer); offlineBannerTimer = null; }
    $('#offline')?.classList.remove('visible');
  }
  window.dispatchEvent(new CustomEvent('pwa:server', { detail: online }));
}

function showSetup(show) {
  const card = $('#setup');
  if (card) card.hidden = !show;
}

/** Fetches scheduler status, updates the status line, and returns { running } or null on error. */
async function updateStatusLine() {
  const line = $('#status-line');
  if (!line) return null;
  try {
    const r = await fetch(getActiveBase() + CONFIG.STOCKS_STATUS_PATH, {
      headers: authHeaders(), cache: 'no-store', credentials: 'omit',
    });
    if (!r.ok) { line.textContent = ''; return null; }
    const s = await r.json();
    const next = s.nextRun ? fmtDateTime(s.nextRun) : '—';
    const parts = [`Nächster Scan: ${next}`];
    if (s.running) parts.unshift('Scan läuft…');
    else if (s.lastRun) parts.unshift(`Letzter Scan: ${fmtDateTime(s.lastRun)} (exit ${s.lastExit})`);
    line.textContent = parts.join(' · ');
    return { running: !!s.running };
  } catch {
    line.textContent = '';
    return null;
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
}

// ── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  initTabs();
  initViewer();
  initInfo();
  initPortfolio();
  initDigest();
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
    if (online && !lastOnline) {
      refresh();                               // offline → online: reload everything
    } else if (online) {
      const status = await updateStatusLine();
      // scan just finished: running flipped true → false → new digest available
      if (status && lastRunning === true && !status.running) {
        window.dispatchEvent(new CustomEvent('pwa:scan-done'));
      }
      if (status) lastRunning = status.running;
    }
    lastOnline = online;
  }, 30_000);

  // Reload immediately when the device rejoins a network.
  window.addEventListener('online', () => { invalidateLocal(); refresh(); });
})();
