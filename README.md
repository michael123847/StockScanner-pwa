# StockScanner PWA

An installable Progressive Web App that shows the latest [StockScanner](../StockScanner) results —
the summary table and the dependency-free price / recommendation / RSI charts from `viewer.html`,
wrapped in an offline-capable app shell.

It is hosted on **public GitHub Pages over HTTPS**, but contains **no internal data**: it fetches
everything at runtime from the local companion server (`C:\Projects\StockScanner\server`) over the
existing family Caddy edge (LAN + Tailscale, installed certificate). The public bundle hard-codes
only the generic `server.local` hostname; the LAN IP, the Tailscale name, the access token, and all
portfolio data live on the device / server only.

## How it works

```
PWA (https://<user>.github.io/StockScanner-pwa/)
  │  fetch + Authorization: Bearer <token>   (same-origin CORS already allowed)
  ▼
Caddy :8443  ──/api/stocks/*──▶  127.0.0.1:3001  (companion server)
```

- `src/config.js` — only `server.local` is public; other bases come from `/api/stocks/config`.
- `src/localBridge.js` — reused from the family PWA: races mDNS / LAN-IP / Tailscale bases, caches
  the winner, and exposes `isLocalAvailable()` + `authHeaders()`.
- `src/auth.js` — a single shared Bearer token kept in `localStorage` (entered once via the gear menu).
- `src/viewer.js` — the table + canvas-chart engine lifted from `StockScanner/viewer.html`, fed from
  `/api/stocks/index` + `/api/stocks/report`. Also renders:
  - the **Allokation** sub-tab: a scheme picker whose entire option list and labelling is
    data-driven — populated at runtime from the allocation JSON's `schemes` map (key →
    `short_label`), with no scheme names or weights hard-coded in the PWA. Each scheme block
    carries a `kind` (`positions` or `sleeves`) that the renderer branches on instead of any
    literal scheme identifier, so the PWA never needs a code change when a scheme is added,
    renamed, or removed on the backend. It also renders portfolio-wide trade recommendations
    (Jetzt/Ziel/Trade columns appear from ~700 px up; narrow phones keep Position/Order and one
    tap opens the detail sheet), and a combined **deposit / withdrawal planner** — a positive
    "Neue Einzahlung" says where new cash should go, a negative amount plans **withdrawal sells**
    out of each leg's excess over its target.
  - the per-signal order-execution hint (green buy / red sell) in the Übersicht "Order" column and
    the row-sheet popup, plus each holding's **ISIN** (copyable) and price **proxy** ("Kurs via …")
    surfaced in the row detail sheet and the Portfolio editor.
  - touch affordances: column headers open an info sheet on double-tap (not just desktop `title=`
    hover); trade rows open their detail sheet on tap or double-click.
- `src/portfolio.js` — the editable multi-list portfolio editor (add/remove/move rows, per-list
  scan/export), with a read-only ISIN sub-line under each holding name.
- `src/main.js` — boot, probe, 30 s health poll, offline banner (debounced so a transient
  boot-time probe miss doesn't flash it), token setup.
- `sw.js` — caches the app shell; **never** intercepts local-server requests.
- `setup/` — one-time certificate-install guide (same mkcert root CA as the family PWA).

## Local development

```powershell
# 1. Run the companion server (see ../StockScanner/README.md → Companion API + deployment)
$env:STOCKS_TOKEN = "dev-token"; node C:\Projects\StockScanner\server\server.js

# 2. Serve this folder (a plain static server is enough)
python -m http.server 8000 --directory C:\Projects\StockScanner-pwa\public
# open http://localhost:8000 → gear ⚙ → paste the token
```

Because the dev server is plain HTTP on localhost while the API is HTTPS on `server.local`, local
testing works best on the same machine/network where `server.local` resolves and the cert is trusted.

## Deploy to GitHub Pages

1. Create a GitHub repo named `StockScanner-pwa` under the same account whose origin is already
   allow-listed in the Caddyfile (`https://michael123847.github.io`).
2. Push this folder to `main`:
   ```powershell
   cd C:\Projects\StockScanner-pwa
   git init; git add .; git commit -m "StockScanner PWA"
   git branch -M main
   git remote add origin https://github.com/michael123847/StockScanner-pwa.git
   git push -u origin main
   ```
3. The `.github/workflows/pages.yml` action publishes `public/` to
   `https://michael123847.github.io/StockScanner-pwa/`.

> Same-origin note: GitHub Pages project sites all share the `https://<user>.github.io` **origin**
> (only the path differs), so the family Caddy's existing CORS allow-list already covers this PWA —
> no server change is needed. A *different* account or a custom domain would require adding that
> origin to the Caddyfile.

Bump `CONFIG.APP_VERSION` (config.js) and `VERSION` (sw.js) together on each deploy.
