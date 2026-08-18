/**
 * push.js — Web Push subscription toggle for the allocation binary-signal-flip
 * notification (Info tab, button #info-push-toggle).
 *
 * PUBLIC-repo constraint: this file must never contain a scheme name or scheme
 * key literal. The notification title/body is composed entirely server-side
 * (see server/signal_flips.js in the private backend repo); the service worker
 * only renders it verbatim. The only "scheme" value this file ever handles is
 * whatever string already sits in localStorage / the DOM at runtime — never a
 * hardcoded literal.
 *
 * The toggle always reflects the real subscription state (never a local
 * guess): on init it asks the browser for an existing PushSubscription and,
 * if one exists, asks the server whether it's actually registered there.
 */

import { CONFIG } from './config.js';
import { authHeaders, getActiveBase } from './localBridge.js';

/** Converts a URL-safe base64 VAPID public key to the Uint8Array PushManager wants. */
export function urlBase64ToUint8Array(b64) {
  const padding = '='.repeat((4 - b64.length % 4) % 4);
  const base64  = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  const arr     = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// Guards the one-time listener wiring below — initPushToggle() is called
// once from main.js at boot, but the guard keeps it idempotent regardless.
let _wired = false;
let _reg   = null; // cached ServiceWorkerRegistration, set on first call

/** Updates the toggle's label/disabled state. Permission 'denied' always wins. */
function setLabel(btn, state) {
  if (Notification.permission === 'denied') state = 'blocked';
  switch (state) {
    case 'blocked': btn.textContent = '🔕 Blockiert';        btn.disabled = true;  break;
    case 'on':      btn.textContent = '🔔 An';                btn.disabled = false; break;
    case 'busy':    btn.textContent = '…';                    btn.disabled = true;  break;
    case 'off':
    default:        btn.textContent = '🔔 Benachrichtigen';   btn.disabled = false; break;
  }
}

/** Re-renders the button from the real subscription state (never a cached guess). */
async function renderFromTruth(btn) {
  try {
    if (!_reg) _reg = await navigator.serviceWorker.ready;
    const sub = await _reg.pushManager.getSubscription();
    if (!sub) { setLabel(btn, 'off'); return; }

    const r = await fetch(
      getActiveBase() + CONFIG.STOCKS_PUSH_STATUS_PATH + '?endpoint=' + encodeURIComponent(sub.endpoint),
      { headers: authHeaders(), cache: 'no-store', credentials: 'omit' },
    );
    if (!r.ok) { setLabel(btn, 'off'); return; }
    const { enabled } = await r.json();
    setLabel(btn, enabled ? 'on' : 'off');
  } catch {
    setLabel(btn, 'off');
  }
}

async function onToggleClick(btn) {
  if (!_reg) _reg = await navigator.serviceWorker.ready;
  const sub = await _reg.pushManager.getSubscription();
  setLabel(btn, 'busy');

  if (sub) {
    // Disable — server-side removal first, so a failed local unsubscribe
    // can never leave the server pushing to a dead endpoint.
    try {
      const r = await fetch(getActiveBase() + CONFIG.STOCKS_PUSH_SUBSCRIBE_PATH, {
        method: 'DELETE', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      if (!r.ok) throw new Error('Deaktivierung fehlgeschlagen');
      await sub.unsubscribe();
      setLabel(btn, 'off');
    } catch (err) {
      console.warn('[push] disable failed:', err);
      await renderFromTruth(btn); // never assume state after a failure
    }
    return;
  }

  // Enable — resolve the scheme FIRST, before touching permissions at all.
  // Runtime value only — never a literal scheme name/key in this file; the
  // check below is on emptiness only.
  const scheme = localStorage.getItem('ss_active_scheme')
    || document.getElementById('alloc-scheme-sel')?.value
    || '';
  if (!scheme) {
    console.warn('[push] enable aborted: no active scheme yet — open Allokation and activate a scheme first');
    btn.textContent = '🔔 Kein Schema aktiv';
    btn.disabled = false;
    setTimeout(() => setLabel(btn, 'off'), 3000);
    return;
  }

  // Permission is requested ONLY here, never on boot.
  let newSub = null;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { setLabel(btn, 'off'); return; }

    const vapidR = await fetch(getActiveBase() + CONFIG.STOCKS_PUSH_VAPID_PATH, {
      headers: authHeaders(), cache: 'no-store', credentials: 'omit',
    });
    if (!vapidR.ok) throw new Error('VAPID-Key nicht verfügbar');
    const { publicKey } = await vapidR.json();

    newSub = await _reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    const postR = await fetch(getActiveBase() + CONFIG.STOCKS_PUSH_SUBSCRIBE_PATH, {
      method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ subscription: newSub.toJSON(), scheme }),
    });
    if (!postR.ok) throw new Error('Server-Registrierung fehlgeschlagen');

    setLabel(btn, 'on');
  } catch (err) {
    console.warn('[push] enable failed:', err);
    // No silent half-on state: if the browser subscription was created but
    // the server never learned about it, tear it back down.
    if (newSub) { try { await newSub.unsubscribe(); } catch {} }
    setLabel(btn, 'off');
  }
}

async function onSchemeActivated(e) {
  if (!_reg) _reg = await navigator.serviceWorker.ready;
  const sub = await _reg.pushManager.getSubscription();
  if (!sub) return; // not subscribed — nothing to re-point
  try {
    await fetch(getActiveBase() + CONFIG.STOCKS_PUSH_SCHEME_PATH, {
      method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ endpoint: sub.endpoint, scheme: e.detail }),
    });
  } catch (err) {
    console.warn('[push] re-point on scheme change failed:', err);
  }
}

/**
 * Wires and renders the push-notification toggle (called once, from main.js
 * at boot). Idempotent by construction — listener wiring happens only once
 * even if called again; the hidden/support check runs every time this is
 * invoked.
 */
export function initPushToggle() {
  const btn = document.getElementById('info-push-toggle');
  if (!btn) return;

  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;

  if (_wired) return;
  _wired = true;

  btn.addEventListener('click', () => onToggleClick(btn));
  window.addEventListener('ss:scheme-activated', onSchemeActivated);
  renderFromTruth(btn);
}
