import { authHeaders, getActiveBase } from './localBridge.js';
import { CONFIG } from './config.js';

const FALLBACK = [
  { key: 'Portfolio', label: 'Portfolio', builtin: true },
  { key: 'Watchlist', label: 'Watchlist', builtin: true },
];

let _cache = null;

export async function loadLists() {
  try {
    const r = await fetch(
      getActiveBase() + CONFIG.STOCKS_LISTS_PATH,
      { headers: authHeaders(), cache: 'no-store', credentials: 'omit' },
    );
    if (!r.ok) throw new Error('HTTP ' + r.status);
    _cache = await r.json();
  } catch {
    if (!_cache) _cache = [...FALLBACK];
  }
  return _cache;
}

export function labelFor(key) {
  return (_cache || FALLBACK).find(l => l.key === key)?.label ?? key;
}

export function isBuiltin(key) {
  return !!(_cache || FALLBACK).find(l => l.key === key)?.builtin;
}
