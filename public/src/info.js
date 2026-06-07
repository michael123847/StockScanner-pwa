/**
 * info.js — Info & Diagnose tab for StockScanner PWA.
 * Adapted from family-pwa src/modules/info.js — no weather/ultrasound.
 */

import { CONFIG } from './config.js';
import { isLocalAvailable, getActiveBase } from './localBridge.js';

/** Human-readable label for the currently-active server base URL. */
function connectionPath() {
  const base = getActiveBase() || '';
  if (base === CONFIG.LAN_BASE || /\.local/.test(base)) return 'Heim-LAN (mDNS)';
  if (/\.ts\.net/.test(base))                  return 'Tailnet';
  if (/192\.168\.|\/\/10\./.test(base))        return 'Heim-LAN (IP)';
  return base ? 'Direkt' : 'Unbekannt';
}

/** Compact OS · Browser label from the user agent. */
function platformLabel() {
  const ua = navigator.userAgent;
  let os = 'Unbekannt';
  if (/iPhone|iPad|iPod/.test(ua))      os = 'iOS';
  else if (/Android/.test(ua))          os = 'Android';
  else if (/Windows/.test(ua))          os = 'Windows';
  else if (/Macintosh|Mac OS/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua))            os = 'Linux';

  let br = 'Browser';
  if (/Edg\//.test(ua))                 br = 'Edge';
  else if (/CriOS|Chrome\//.test(ua))   br = 'Chrome';
  else if (/Firefox\//.test(ua))        br = 'Firefox';
  else if (/Safari\//.test(ua))         br = 'Safari';

  return os + ' · ' + br;
}

/** The version tag embedded in the Service Worker shell cache (e.g. "v1.1.0"). */
async function swCacheVersion() {
  try {
    const shell = (await caches.keys()).find(k => k.startsWith('shell-'));
    return shell ? shell.replace('shell-', '') : '—';
  } catch {
    return '—';
  }
}

function row(label, value, tone) {
  const cls = tone ? ' ' + tone : '';
  return `<div class="info-row">` +
    `<span class="info-label">${label}</span>` +
    `<span class="info-value${cls}">${value}</span>` +
    `</div>`;
}

async function render() {
  const box = document.getElementById('info-content');
  if (!box) return;

  const [server, swVer] = await Promise.all([
    isLocalAvailable(),
    swCacheVersion(),
  ]);

  const versionMatch = CONFIG.APP_VERSION === swVer;
  box.innerHTML = [
    row('App-Version',  CONFIG.APP_VERSION, versionMatch ? 'good' : 'warn'),
    row('Service Worker', swVer),
    row('Heim-Server', server ? 'Online' : 'Offline', server ? 'good' : undefined),
    row('Verbindung',  connectionPath(),
        /\.local|192\.168\./.test(getActiveBase()) ? 'good' : undefined),
    row('Netzwerk',    navigator.onLine ? 'Online' : 'Offline'),
    row('Gerät', platformLabel()),
  ].join('');
}

/**
 * Unregisters the SW, clears every cache, and reloads — forces a completely
 * fresh copy of the app.
 */
async function hardReload() {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
  } catch { /* best effort */ }
  location.reload();
}

export function initInfo() {
  if (!document.getElementById('info-content')) return;

  document.getElementById('info-refresh')?.addEventListener('click', render);
  document.getElementById('info-reload')?.addEventListener('click', hardReload);

  // Re-render every time the Info tab is activated.
  window.addEventListener('pwa:tab', e => { if (e.detail === 'info') render(); });

  render();
}
