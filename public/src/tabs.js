/**
 * tabs.js — Lean bottom-tab controller for StockScanner PWA.
 * Adapted from family-pwa app.js initTabs() — no subpages, no roles.
 */

const LS_KEY = 'pwa.stocks.tab';

let _current = 'overview';

function show(name) {
  document.querySelectorAll('.page').forEach(p =>
    p.classList.toggle('active', p.id === 'page-' + name));
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.page === name));
  _current = name;
  try { localStorage.setItem(LS_KEY, name); } catch {}
  window.dispatchEvent(new CustomEvent('pwa:tab', { detail: name }));
}

export function currentTab() { return _current; }

export function initTabs() {
  // Wire tab buttons.
  document.querySelectorAll('.tab-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', () => show(btn.dataset.page));
  });

  // External navigation (e.g. table-row tap → Charts).
  window.addEventListener('pwa:navigate', e => {
    if (typeof e.detail === 'string' && document.getElementById('page-' + e.detail)) {
      show(e.detail);
    }
  });

  // Restore last tab (default: overview).
  let saved = 'overview';
  try { saved = localStorage.getItem(LS_KEY) || 'overview'; } catch {}
  if (!document.getElementById('page-' + saved)) saved = 'overview';
  show(saved);
}
