/**
 * digest.js — Fetch and render the daily digest in the Digest tab.
 * Tries digest_latest.md (rich Markdown); falls back to digest_latest.txt (<pre>).
 */
import { CONFIG } from './config.js';
import { getActiveBase, authHeaders } from './localBridge.js';
import { fmtDateTime } from './format.js';
import { selectTickerIfPresent } from './viewer.js';

const $ = s => document.querySelector(s);

let _loaded = false;

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderInline(text) {
  const out = [];
  let last = 0;
  const re = /\[([^\]]+)\]\(ticker:([^)]+)\)|\*\*([^*]+)\*\*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(esc(text.slice(last, m.index)));
    if (m[1] !== undefined) {
      out.push(`<button class="digest-ticker-chip" data-ticker="${esc(m[2])}">${esc(m[1])}</button>`);
    } else {
      out.push(`<strong>${esc(m[3])}</strong>`);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(esc(text.slice(last)));
  return out.join('');
}

function renderMd(md) {
  let scanTime = '';
  md = md.replace(/^<!--\s*generated:([^-]+)-->\r?\n?/m, (_, ts) => { scanTime = ts.trim(); return ''; });

  const lines = md.split('\n');
  const html = [];
  let inList = false;
  let inSell = false;

  for (const line of lines) {
    if (!line.trim()) {
      if (inList) { html.push('</ul>'); inList = false; inSell = false; }
      continue;
    }

    // Regime callout: **Regime:** State (Score +0.60)
    if (line.startsWith('**Regime:**')) {
      const m = line.match(/\*\*Regime:\*\*\s*([^(]+?)\s*\(Score ([^)]+)\)/);
      const state = m ? m[1].trim() : '';
      const score = m ? m[2].trim() : '';
      const cls = state === 'Risk-On' ? 'sig-buy' : state === 'Risk-Off' ? 'sig-sell' : 'sig-hold';
      html.push(`<div class="digest-regime"><span class="glyph regime-badge ${esc(cls)}">${esc(state)}</span> Score ${esc(score)}</div>`);
      continue;
    }

    // Section heading: ## Heading
    if (line.startsWith('## ')) {
      if (inList) { html.push('</ul>'); inList = false; inSell = false; }
      html.push(`<h2 class="digest-md-h2">${esc(line.slice(3))}</h2>`);
      continue;
    }

    // List item: - text
    if (line.startsWith('- ')) {
      if (!inList) {
        html.push(inSell ? '<ul class="digest-md-list digest-md-sell">' : '<ul class="digest-md-list">');
        inList = true;
      }
      html.push(`<li>${renderInline(line.slice(2))}</li>`);
      continue;
    }

    // Paragraph / prose
    if (inList) { html.push('</ul>'); inList = false; }
    const isSellLabel = /^Auf VERKAUF:/.test(line);
    inSell = isSellLabel;
    html.push(`<p class="digest-md-p${isSellLabel ? ' digest-md-sell-label' : ''}">${renderInline(line)}</p>`);
  }
  if (inList) html.push('</ul>');

  return { html: html.join('\n'), scanTime };
}

function showToast(msg) {
  let t = document.getElementById('digest-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'digest-toast';
    t.className = 'digest-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2400);
}

function fmtHHMM(iso) {
  const s = fmtDateTime(iso);
  return s.length >= 5 ? s.slice(-5) : s;
}

async function loadDigest() {
  const prePre  = $('#digest-body');
  const mdDiv   = $('#digest-body-md');
  const err     = $('#digest-error');
  const stamp   = $('#digest-stamp');

  if (!prePre && !mdDiv) return;
  if (err) err.style.display = 'none';

  const base = getActiveBase();
  const hdrs = { headers: authHeaders(), cache: 'no-store', credentials: 'omit' };

  // Try Markdown first
  try {
    const r = await fetch(base + CONFIG.STOCKS_DIGEST_MD_PATH, hdrs);

    if (r.status === 404) {
      // Markdown not yet generated — fall back to plain text
      await loadTxt(base, hdrs, prePre, mdDiv, err, stamp);
      return;
    }

    if (!r.ok) {
      if (err) { err.textContent = `Fehler ${r.status}`; err.style.display = 'block'; }
      return;
    }

    const md = await r.text();
    const fetchTime = new Date().toISOString();
    const { html, scanTime } = renderMd(md);

    if (prePre) { prePre.style.display = 'none'; prePre.textContent = ''; }
    if (mdDiv)  { mdDiv.innerHTML = html; mdDiv.style.display = ''; }

    _loaded = true;
    if (stamp) {
      const scan = scanTime ? `Scan ${fmtHHMM(scanTime)} · ` : '';
      stamp.textContent = `${scan}Abgerufen ${fmtHHMM(fetchTime)}`;
    }
  } catch {
    if (err) { err.textContent = 'Digest konnte nicht geladen werden.'; err.style.display = 'block'; }
  }
}

async function loadTxt(base, hdrs, prePre, mdDiv, err, stamp) {
  try {
    const r = await fetch(base + CONFIG.STOCKS_DIGEST_PATH, hdrs);
    if (!r.ok) {
      const msg = r.status === 404
        ? 'Noch kein Digest vorhanden — Scan ausstehend.'
        : `Fehler ${r.status}`;
      if (err) { err.textContent = msg; err.style.display = 'block'; }
      if (prePre) prePre.textContent = '';
      return;
    }
    const text = await r.text();
    if (mdDiv) mdDiv.style.display = 'none';
    if (prePre) { prePre.textContent = text; prePre.style.display = ''; }
    _loaded = true;
    if (stamp) stamp.textContent = fmtHHMM(new Date().toISOString());
  } catch {
    if (err) { err.textContent = 'Digest konnte nicht geladen werden.'; err.style.display = 'block'; }
  }
}

export function initDigest() {
  $('#digest-refresh')?.addEventListener('click', loadDigest);

  // Ticker chip clicks — delegate once on the persistent container
  $('#digest-body-md')?.addEventListener('click', e => {
    const chip = e.target.closest('.digest-ticker-chip');
    if (!chip) return;
    const sym = chip.dataset.ticker;
    if (!selectTickerIfPresent(sym)) showToast(`${sym} nicht im aktuellen Report.`);
  });

  window.addEventListener('pwa:tab', e => {
    if (e.detail === 'digest' && !_loaded) loadDigest();
  });

  window.addEventListener('pwa:server', e => {
    if (e.detail && document.getElementById('page-digest')?.classList.contains('active')) {
      loadDigest();
    }
  });

  window.addEventListener('pwa:scan-done', () => {
    _loaded = false;
    if (document.getElementById('page-digest')?.classList.contains('active')) {
      loadDigest();
    }
  });
}
