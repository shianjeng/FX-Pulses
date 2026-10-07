<div align="center">
  <img src="extension/icons/icon.svg" alt="FX Pulse logo" width="112" height="112" />

  # FX Pulse

  **Exchange rates at a glance — live market quotes, official references, and instant webpage conversion.**

  A privacy-friendly Chrome extension that works out of the box: rates come from a free static backend on GitHub Pages, or from your own FastAPI server.

  [What's New](#whats-new-in-283) · [Quick Start](#quick-start) · [Features](#features) · [Data Sources](#data-sources) · [API](#api) · [中文简介](#中文简介)

  <p>
    <a href="https://github.com/shianjeng/FX-Pulses/actions/workflows/ci.yml"><img src="https://github.com/shianjeng/FX-Pulses/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
    <img src="https://img.shields.io/badge/version-2.8.3-36D9A0" alt="Version 2.8.3" />
    <img src="https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white" alt="Python 3.12" />
    <img src="https://img.shields.io/badge/FastAPI-0.116-009688?logo=fastapi&logoColor=white" alt="FastAPI 0.116" />
    <img src="https://img.shields.io/badge/Chrome-Manifest_V3-4285F4?logo=googlechrome&logoColor=white" alt="Chrome Manifest V3" />
    <img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL 16" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-F5C542" alt="MIT License" /></a>
  </p>
</div>

---

## What is FX Pulse?

FX Pulse brings a compact exchange-rate dashboard and webpage hover converter into one browser extension. It keeps **market observations** separate from **daily official reference rates**, so every number has a clear meaning and source.

The extension and hover converter share the same backend, one-minute cache, watchlist, target currency, and language preference. No Tampermonkey script is required. The optional 2.5.0 userscript also reads quotes through the extension; it no longer requests ER-API or Frankfurter or keeps a separate persistent quote cache.

> **Market midpoint** = `(bid + ask) / 2`. It is not a bank settlement rate, card-network rate, or central-bank fixing.

## What's new in 2.9.0

Ideas taken from comparable converters: the yearly charts of XE, Wise and the Currencies app, the select-to-convert of Currency Converter Pro, and the calculator built into Currencies.

- **A one-year chart.** The trend chart has a **1Y** tab. It draws the ECB's daily reference rates for the last year, read once from the ECB's full history file and kept for a year, so every pair the ECB covers (about 30 currencies) has a real year-long line. Its axis and tooltip carry the year.
- **Select a price to convert it.** With hover conversion on, selecting a price opens the same card as hovering. Double-clicking the figure of a price that a shop writes in pieces ("¥" and "26,990") works too. The card stays while the price is selected. Selecting two prices, a long passage, or text in a form field opens nothing. This also works on pages where hovering cannot read the price.
- **Sums in the converter.** Either box takes a sum: `1200/3`, `(80+45)*2`, or a percentage of the figure before it, so a 20% discount is `1000-20%`. Full-width input from a Chinese or Japanese keyboard works. The other box follows as you type, and Enter turns the sum into its result.
- **Maintenance.** FastAPI 0.142.2, SQLAlchemy 2.1.3, Ruff 0.16.10, ESLint 10.12 and jsdom 30.1.2. A patched source-map-js fixes an npm audit finding in the development tools; nothing shipped in the extension was affected.

## What's new in 2.8.5

- **Real one-month and three-month charts.** Collection began on 23 September 2026, so 7 days, 1 month and 3 months all showed that one week. Until the collector's own quotes span a range, the chart now draws the ECB's daily reference rates for the last 90 days. They are read once from the ECB's official 90-day file and kept current by the daily fetch. That gives every pair the ECB covers a real long-range line (about 30 currencies, EUR/KRW included), and a caption under the chart names the source.
- **Live rates.** The popup, hover cards, the toolbar icon and target alerts now use live mid-market rates from Coinbase's public API, refreshed about once a minute while in use, for about 160 currencies. Against Wise's live mid-market rate the median difference was 0.006% across 14 currencies. Before, quotes could be up to three hours old. The trend chart still uses collected history. On by default, and one switch in Settings turns it off. Coinbase sees your IP address; nothing from the page and no settings are sent. See [Live rates](#live-rates).
- **A smoother trend chart.** The line is now a smooth curve that still never invents a high or low between samples. It has a round-numbered price scale on the right, dates or hours underneath, and headroom above and below. The tooltip also shows the move since the range began. Outages show as a faint dashed span, and the line draws itself in, with no animation when the system asks for reduced motion.
- **Hover works on more shops.** Amazon writes prices in pieces ("¥" and "26,990" in separate elements, "$29.99" in four), and Mercari lays them over thumbnails where the pointer passes straight through. Hover now reads both, looks inside open shadow roots, and is no longer switched off by pages that stop mouse events or by carousels that scroll on their own.
- **Rate on the toolbar icon (optional).** In Settings, choose a pair under **Toolbar icon** and its rate appears on the extension icon: 6.70, 157, .043. It updates every 30 minutes and whenever the popup opens, turns grey when the quote is old, and costs no extra requests. Off by default.
- **Keyboard shortcut.** Alt+Shift+F opens the popup. Change it at `chrome://extensions/shortcuts`.
- **The converter works both ways.** Either box takes an amount: type 1,000 into the CNY box and the JPY box reads 23,533; type into the JPY box instead and the CNY box works out the yuan. Swapping or changing currencies keeps the figure you typed and recomputes the other box. Thousands separators and full-width digits are accepted.
- **Amounts read the way the currency is written.** The converter shows yen and won without decimals (157,431 JPY) and three decimals for currencies that have them, like the hover card already did. Small results keep two significant digits instead of rounding to 0.00.
- **Clearer sources.** The status line says how old the quote is ("9/29 23:21 (5 hours ago)"). The hover card names central banks in your language, and a bridged reference is translated in both parts.
- **Fixes.** Hovering an amount already in the target currency shows 1:1 instead of "not collected". The trend chart works with a pen or touch screen. The detailed view no longer shows a horizontal scrollbar.
- **Fewer gaps in the data.** A timed-out Alpha Vantage request is retried once, and a pair that still misses its round is picked up within minutes instead of hours. On 29 September two timeouts had left USD/CNY and USD/JPY 13 hours behind. The publishing schedule also asks four times an hour, because GitHub starts only a fraction of scheduled runs.

## What's new in 2.8.4

- **More accurate official references.** When several central banks publish a pair, the extension used to take whichever reference was newest. On Monday mornings that was almost always the People's Bank of China, whose administered CNY fixing ran 0.3-0.4% away from the market, and every cross rate through it inherited the gap (USD/KRW +0.37%, EUR/USD −0.28%). The popup and the hover card now prefer the most accurate source: measured against market quotes across 37 currencies, the median error was 0.05% for the Bank of Canada, 0.08% for the ECB, 0.27% for the PBOC, 0.53% for the Bank of Japan and 0.54% for the Federal Reserve. The reference date still matters, but only between sources within four days of the newest.
- Market quotes from Alpha Vantage were checked against same-moment quotes and were accurate (within 0.05%); they are unchanged.

## What's new in 2.8.3

Maintenance release; the extension behaves as in 2.8.2.

- **Security updates.** The backend moves to FastAPI 0.141 with Starlette 1.7, which fixes published Starlette advisories (Host-header path poisoning, ignored form limits, Range-header DoS). Uvicorn, SQLAlchemy 2.1, psycopg, pydantic-settings and APScheduler are current, and so are the dev tools: pytest 9 (fixes a tmpdir advisory), Ruff 0.16, ESLint 10 and jsdom 30.
- **Fresher data.** GitHub ran the hourly publishing schedule only about five times a day, so quotes were sometimes more than six hours old and shown as outdated. The job now collects once data is three hours old, still within the Alpha Vantage budget, and accepts an external pinger that fills GitHub's gaps without spending extra calls. See [Keeping the data fresh](#keeping-the-data-fresh).
- **CI.** Workflows use the current major versions of the GitHub actions, which run on Node 24.

## What's new in 2.8.2

- **Hover card.** A tighter card with amounts in each currency's own decimals (195.22 CNY, 2,351 JPY). It opens above a price near the bottom of the window instead of covering it, offers alternatives only when a currency sign is ambiguous (¥, $), lists every covered currency in both pickers, and labels official references as such.
- **Popup.** The simple view fits without scrolling; the detailed view has a slim scrollbar.
- **Fresher data.** The publishing job now tries every hour and collects once the data is about four hours old, so a skipped GitHub schedule no longer leaves quotes stale.

## What's new in 2.8.1

- **Redesigned popup.** Picking a pair, reading the rate and converting now happen in one card, with the rate as the largest element. A dark theme follows the system appearance.
- **Watchlist of any pairs.** Choose any two currencies in the picker and add them to the watchlist. Each saved pair shows its rate; select a row to switch to it.
- **Less repetition.** For a pair with only an official reference, the source is stated once instead of three times.

## What's new in 2.8.0

- **No server needed.** The extension now reads a public backend that this repository publishes to GitHub Pages every four hours. Install it and open it; rates are there. No Docker, no server, and no Alpha Vantage key.
- **Your own server still works.** The settings page now recognises both a running API and a static host, and stores which one an address is. An address you saved before 2.8.0 keeps being reached as an API; only installs that never changed the address move to the public backend.

## What's new in 2.7.0

- **Simple view by default.** The popup opens on the midpoint and the converter. Bid/ask, official references, the trend chart and target alerts are one click away under **Show details**, and your choice is remembered. The simple view does not request history or official comparisons at all, so opening the popup costs fewer calls.
- **Clearer trend chart.** One line over a soft fill, with markers only on the period high and low. The statistics below it — High, Low, Average and Change — all describe the selected range (24h, 7d, 1m or 3m). Collection outages stay visible as gaps rather than being bridged.
- **Optional static backend.** The read-only API can be exported as JSON and published on GitHub Pages by a scheduled workflow, so the extension can run without anyone operating a server. See [Static backend on GitHub Pages](#static-backend-on-github-pages).


### Rate display

Rates below 1 show at least six decimal places, with more precision for smaller values. Extremely small rates use scientific notation to avoid displaying zero. Quotes, bid/ask prices, chart values, and official references share this formatting rule. Conversion uses the unrounded stored rate; the result is rounded only for display, to the target currency's own minor unit (none for JPY and KRW, two for most, three for KWD), and an amount below one keeps two significant digits. The popup and the hover card share this rule. The converter shows the unit rate and a rounding explanation.

## Features

| | Capability | Details |
| --- | --- | --- |
| 📊 | Currency explorer | Select any two available currencies and view their rate, source and date |
| ⭐ | Watchlist | Save up to eight pairs of any currencies and switch between them in one click |
| 👁️ | Simple view | Opens on the midpoint and converter; full detail is one click away |
| ↕️ | Market quote detail | Bid, ask, midpoint, spread, freshness, and 24-hour movement (detailed view) |
| 📈 | Trend chart | Smooth 24-hour to 1-year lines with a price scale, time axis, high and low markers, and range statistics; ECB daily history fills ranges the collector has not reached |
| 🏛️ | Official references | Compare market midpoints with central-bank reference observations |
| ⚡ | Hover conversion | Point at or select an amount on a webpage to convert it without leaving the page, including prices shops split into pieces (Amazon, Mercari) |
| 🧮 | Quick converter | Choose source and target currencies, type an amount or a sum in either box, swap direction, and see the rate source and date |
| 🔔 | Optional alerts | Local target-price alerts powered by `chrome.alarms` |
| 🏷️ | Rate on the icon | Optionally show one pair's rate on the toolbar icon, grey when the quote is old |
| ⌨️ | Shortcut | Alt+Shift+F opens the popup; change it at `chrome://extensions/shortcuts` |
| 🌐 | Three languages | Complete Chinese, English, and Japanese interfaces |
| 🌙 | Dark mode | The popup follows the system's light or dark appearance |
| 🔒 | Privacy first | No account, analytics SDK, or server-side storage of personal preferences |

Hover conversion is **off by default**. Enable it from Settings, grant access only to the websites you choose, and refresh those pages. If using Tampermonkey, update the script to 2.5.0 and reload webpages. To let the legacy userscript drive the data instead, also enable userscript compatibility in Settings (off by default); the native hover card then yields once per page. Otherwise, disable older scripts.

## Data sources

FX Pulse labels each data layer instead of presenting unrelated rates as if they were interchangeable.

### Chart history

The chart draws the collector's own market quotes when they span the selected range: always for 24 hours, and for longer ranges once enough has been collected. Otherwise it draws the European Central Bank's daily reference rates. That covers pairs the market feed does not track, and 1 month, 3 months or a year before the collector reaches that far back. Market quotes are kept for 90 days, so the one-year chart always draws the ECB's line.

- **Where the history comes from.** A collection that finds fewer than 200 of the last year's ECB dates reads the ECB's official history file (`eurofxref-hist.xml`, about 8 MB, every day since 1999) once and keeps the last year. The daily reference fetch keeps it current. The ECB's tables are kept for a year; other institutions' tables follow the 90-day retention.
- **What is published.** The export publishes it as `reference-history.json`: one column per currency against EUR, about 58 KB (19 KB compressed). A cross is one column divided by another, the same arithmetic the API uses for official quotes. The API serves the same data at `/api/v1/reference-history`.
- **How it is drawn.** One point per business day; weekends and holidays are not treated as outages, and the tooltip shows a date. The caption under the chart says which source is drawn.

### Live rates

The extension's background worker reads `https://api.coinbase.com/v2/exchange-rates?currency=USD`, Coinbase's documented public endpoint: no key, about 160 currencies in one response, updated about once a minute. One request covers every pair, and the worker's shared one-minute cache means the popup, all open pages, the toolbar icon and target alerts together make at most one request a minute, and only while one of them is in use.

- **Preference.** A live rate is preferred wherever it covers both currencies. Otherwise the backend's market quote is used, then an official daily reference.
- **Labels.** The popup says "Live · Coinbase" and the hover card carries a "Live" badge.
- **What is not accepted.** Crypto assets and precious metals are excluded. So is a response whose rates for the collected pairs differ from the backend's last quotes by more than 5%. A copy more than ten minutes old is no longer shown as live.
- **What stays on the backend.** History, bid/ask and the official comparisons still come from the backend.
- **Onshore and offshore yuan.** Live CNY follows the international (offshore-influenced) market. Outside Chinese trading hours it can differ from the onshore rate by about 0.1%.

Turn it off under **Live rates** in Settings to use only the backend.

| Layer | Source | Refresh model | Meaning |
| --- | --- | --- | --- |
| Live rates | Coinbase public exchange-rate API | About once a minute while in use | Mid-market reference for about 160 currencies, no bid or ask |
| Market quotes | Alpha Vantage | Configurable; free profile defaults to four hours | Bid, ask, and arithmetic midpoint |
| Demo quotes | Built-in deterministic provider | Local | Development and interface testing only |
| Official references | European Central Bank | Daily on business days | Indicative reference observations |
| Official references | Bank of Canada | Daily on business days | Indicative reference observations |
| Official references | Federal Reserve Board | H.10 business-day release | Daily exchange-rate observations |
| Official references | Bank of Japan | Tokyo business days | USD/JPY spot rate at 17:00 JST |
| Official references | People's Bank of China | Business days | RMB central parity reference |

The main dashboard and converter share two currency selectors and one selected-pair card. Selecting a pair updates conversion, official comparisons, and the history panel together. Direct market quotes are preferred; reverse quotes use reciprocal prices, with bid/ask sides swapped. Market history is inverted when only the reverse pair is tracked. Pairs without market history show an explicit notice. Your last selection is saved.

The popup discovers available currencies from `/api/v1/currencies` and the live-rate table instead of limiting selection to the three default market pairs. It prefers a live rate, then direct or inverse market quotes, then the most accurate official reference for the chosen pair: the Bank of Canada and the ECB first, then the People's Bank of China and the Bank of Japan, then the Federal Reserve, whose H.10 release arrives about a week late. A reference more than four days older than the newest one available drops out, so a source that stopped publishing does not win on reputation. Official coverage depends on successfully collected tables. A pair may use one institution or triangulate across two institutions through a shared currency; the latter retains both sources, the bridging currency, and the older reference date. Missing rates are shown explicitly. History and target alerts continue to use configured market pairs.

Official cross-rates retain their institution, reference date, fetch time, source URL, and an `is_derived` marker. They are never described as live or tradable quotes.

The PBOC source uses a website data endpoint rather than a documented statistical API. Verify all configured official sources after setup:

```dotenv
OFFICIAL_SOURCES=ecb,bank_of_canada,federal_reserve,bank_of_japan,pboc
```

```bash
cd backend
python -m app.check_official
```

## Architecture

```mermaid
flowchart TD
    Script["Tampermonkey Userscript · Optional"]

    subgraph Extension["Browser Extension · Chrome / Edge"]
        Popup["Toolbar Popup"]
        Hover["Built-in Hover Interface"]
        Bridge["Read-Only Userscript Bridge"]
        Worker["Background Service Worker · Shared Cache"]

        Popup --> Worker
        Hover --> Worker
        Bridge --> Worker
    end

    Script --> Bridge
    Worker --> API["FastAPI Backend"]
    API --> DB[("Exchange Rate Database")]
    Alpha["Alpha Vantage · Market Quotes"] --> Collector["Scheduled Collector"]
    Banks["ECB · BoC · Fed · BoJ · PBOC"] --> Collector
    Collector --> DB
```

The optional userscript sends read-only snapshot or official-pair requests through the extension bridge. The bridge never returns the backend URL, API keys, or preferences. These public quote events are visible to the host page and can be forged by page scripts; use the native extension interface on untrusted pages.

The browser never contacts upstream rate providers directly. A standalone collector validates and stores observations before the API serves them from the database. Browser requests therefore do not consume Alpha Vantage quota.

In static mode the FastAPI process is replaced by files. A scheduled GitHub Actions job runs the collector once, exports every endpoint with `python -m app.export_static`, and publishes the result to GitHub Pages. The background worker maps each API path onto its file, so the popup and hover behave identically in both modes.

User watchlists, targets, language selection, hover preferences, and per-site currency choices stay in `chrome.storage.local`.

## Quick start

FX Pulse works out of the box. The extension reads a public backend that this repository refreshes every few hours on GitHub Pages, so you do not need Docker, a server, or an API key.

### 1. Install the extension

FX Pulse is not in the Chrome Web Store yet, so it is added as an unpacked extension. It takes about a minute and works in Chrome and Microsoft Edge.

**Download**

1. [Download the ZIP](https://github.com/shianjeng/FX-Pulses/archive/refs/heads/main.zip), or click the green **Code** button on this page and choose **Download ZIP**.
2. Unzip it. You get a folder named `FX-Pulses-main`; the extension is the `extension` folder inside it.
3. Move `FX-Pulses-main` somewhere permanent, such as your Documents folder. The browser loads the extension from this folder every time, so deleting or moving it later removes the extension.

**Add it to Chrome**

1. Type `chrome://extensions` in the address bar and press Enter.
2. Turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked** in the top-left corner.
4. Select the `extension` folder — the one that contains `manifest.json`, not the outer `FX-Pulses-main` folder.
5. Click the puzzle-piece icon in the toolbar and pin **FX Pulse**.
6. Click the FX Pulse icon. Rates appear immediately.

**Microsoft Edge**: go to `edge://extensions`, turn on **Developer mode** in the left sidebar, click **Load unpacked**, then follow steps 4–6.

**Updating**: download the ZIP again and replace the old `FX-Pulses-main` folder **at the same location** (or run `git pull` if you cloned it), then click the reload button ↻ on the FX Pulse card in `chrome://extensions`. Your watchlist and settings are kept. The browser identifies an unpacked extension by its folder path, so loading the new copy from a different place installs a second, empty FX Pulse instead.

**If something looks wrong**

| What you see | What to do |
| --- | --- |
| "Manifest file is missing or unreadable" | You selected the outer folder. Select `FX-Pulses-main/extension` instead. |
| A reminder to disable developer-mode extensions | Normal for extensions installed outside the Web Store. Keep FX Pulse enabled. |
| The popup says it cannot connect | Check your internet connection, then click refresh in the popup. If you changed the backend address on the settings page, enter `https://shianjeng.github.io/FX-Pulses/api/v1` there to return to the default. |
 The extension reads `https://shianjeng.github.io/FX-Pulses/api/v1`; to use your own backend instead, enter its address on the settings page.

### 2. Run your own backend (optional)

Only needed if you want your own schedule, currency pairs, or database. You need Docker Desktop or Docker Engine with Compose, and a private key from [Alpha Vantage](https://www.alphavantage.co/support/#api-key).

```bash
cp .env.example .env
```

Edit `.env` before starting:

```dotenv
FX_PROVIDER=alpha_vantage
ALPHA_VANTAGE_API_KEY=your_private_key
```

```bash
docker compose up -d --build
```

Alpha Vantage is the default provider. A missing key prevents startup with a configuration error; there is no silent demo fallback. For explicit development without a key, set `FX_PROVIDER=mock`.

| Service | Address |
| --- | --- |
| Health check | <http://localhost:8000/health> |
| Latest rates | <http://localhost:8000/api/v1/rates> |
| Interactive API docs | <http://localhost:8000/docs> |

Then open the extension's settings page and enter `http://localhost:8000/api/v1`. The page checks the backend before saving and remembers whether it is a running API or a static host.

### 3. Upgrading

**To 2.8.x**: reload the extension in `chrome://extensions` and verify version **2.8.3**. If you never changed the backend address, the extension now reads the public backend and you can stop a local stack you ran only for it. If you saved your own address, nothing changes.

**Self-hosted, from 2.6.x** no database migration is needed. Pull, rebuild, and reload the extension:

```bash
git pull
docker compose up -d --build
```

Reload the extension in `chrome://extensions` and verify version **2.8.3**. Since 2.7.0 the popup opens in the simple view; choose **Show details** once to bring back the full layout. The choice is remembered.

**From 2.5.0**, the notes below also apply. The 2.6.0 compatibility patch is based on commit `5816065` (including PR #14). It preserves the opt-in userscript bridge, per-source health checks, triangulated official rates, stale-source labels, and saved unavailable currencies.

Keep your existing database and edit your existing `.env`; do not overwrite it with an example file. Set `FX_PROVIDER=alpha_vantage` and your own `ALPHA_VANTAGE_API_KEY`, then rebuild:

```bash
docker compose up -d --build --force-recreate
docker compose logs --tail=100 collector
```

Reload the extension in `chrome://extensions`, verify version **2.8.3**, then refresh open webpages. The optional Tampermonkey interface remains compatible with `userscript/fx-pulse-hover.user.js` version 2.5.0. Enable hover, approve website access, and opt in to userscript compatibility in extension settings. Without the bridge, the userscript reports unavailable data instead of contacting another provider.

Confirm that `/health` reports `"provider": "alpha_vantage"`. Its `collector` array carries one heartbeat per configured official source, so a source that quietly stopped publishing surfaces instead of hiding behind the ones that still work. Initial collection may take time; existing demo observations remain marked as mock until replaced. The userscript keeps separate appearance, target-currency and calibration preferences; only the data service is shared.

The included profile collects three pairs every four hours (18 scheduled calls/day), spaces requests by 15 seconds, and caps attempts at 25 per rolling 24-hour window. [Alpha Vantage documents a standard free limit of 25 requests/day](https://www.alphavantage.co/support/). Restarts and retries also consume attempts. Adding pairs requires adjusting the interval or using a higher-quota key. Browser refreshes do not trigger upstream collection.

Official references remain clearly labelled daily fallbacks for broader currency coverage. Unified sources does not mean all supported currencies have streaming Alpha Vantage quotes.

## Static backend on GitHub Pages

The API is read-only and only ever returns what the collector stored, so it can be served as plain files. [`publish.yml`](.github/workflows/publish.yml) does this every few hours: it collects one round, exports the API to JSON, and deploys it to GitHub Pages. No server runs between collections, and extension users never need an Alpha Vantage key.

One-time setup in the repository:

1. **Settings → Secrets and variables → Actions**: add `ALPHA_VANTAGE_API_KEY`.
2. **Settings → Pages**: set **Source** to **GitHub Actions**.
3. Make sure no branch named `data` exists. The workflow keeps the collected history there as a single force-pushed commit, so the repository does not grow with every run.

Then run **Actions → Publish static backend → Run workflow** once. The API appears at `https://<user>.github.io/<repo>/api/v1/`.

This repository's build already points at `https://shianjeng.github.io/FX-Pulses/api/v1`. A fork publishes to its own Pages address; to ship a build that uses it, edit `extension/config.js`:

```js
globalThis.FXConfig = {
  defaultApiUrl: "https://<user>.github.io/<repo>/api/v1",
  backendMode: "static",
};
```

Add `https://<user>.github.io/*` to `host_permissions` in `extension/manifest.json`, then verify the pair:

```bash
npm run check:config
```

The check fails if the manifest does not cover the default backend, or if a non-local default uses plain HTTP. CI runs it on every push.

### Keeping the data fresh

The workflow asks four times an hour and collects once the oldest published quote is three hours old: at most eight rounds of three pairs a day, inside the 25-call Alpha Vantage budget that the collector also enforces. A round retries a timed-out request once, and a pair that still fails is picked up by the next run that GitHub starts, without fetching the pairs that did arrive. GitHub does not run schedules on time, though. In late September 2026 it started an hourly schedule only about five times a day, 3 to 8.5 hours apart, so data sometimes passed the six-hour mark at which the extension shows it as outdated; asking more often gives it more chances.

Any scheduler you trust can fill the gaps by dispatching the workflow with `force=false` every 30 minutes. Such a run goes through the same three-hour check, so it costs a few seconds of Actions time and no Alpha Vantage calls when the data is fresh.

- **From a machine that is usually on**, with the GitHub CLI signed in:

  ```bash
  gh workflow run publish.yml -R <user>/<repo> -f force=false
  ```

- **From a hosted cron service**, send this request. Use a fine-grained token scoped to this repository with only **Actions: Read and write**; it can start workflows but cannot change code.

  ```http
  POST https://api.github.com/repos/<user>/<repo>/actions/workflows/publish.yml/dispatches
  Authorization: Bearer <token>
  Accept: application/vnd.github+json

  {"ref": "main", "inputs": {"force": "false"}}
  ```

**Run workflow** in the Actions tab still collects immediately, because `force` defaults to true. Pairs quoted within the last two hours are left out even then, so a second click does not spend budget.

Time-dependent fields are never frozen into the files. `meta.json` carries collection timestamps and thresholds, and the extension decides whether a quote is stale or a collector has stalled, so a CDN serving an old file cannot make a dead collector look healthy. History is published as one 90-day file per pair and sliced in the browser.

To produce the files locally:

```bash
cd backend
python -m app.collector --once
python -m app.export_static --out ../public/api/v1
```

## API

All application endpoints are public, cached, rate-limited, and read-only.

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/health` | API, provider, and per-source collector status |
| `GET` | `/api/v1/pairs` | Configured market pairs |
| `GET` | `/api/v1/currencies` | Market and official-source coverage |
| `GET` | `/api/v1/rates` | Latest cached market quotes |
| `GET` | `/api/v1/rates/{base}/{quote}` | Latest quote for one pair |
| `GET` | `/api/v1/rates/{base}/{quote}/history?days=7` | One to 365 days of history, within the retention (90 days by default) |
| `GET` | `/api/v1/official-rates` | Latest official observations |
| `GET` | `/api/v1/official-rates/{base}/{quote}` | Official observations for a covered pair |
| `GET` | `/api/v1/comparisons/{base}/{quote}` | Market and official-rate comparison |

Responses include `ETag` and `Cache-Control`. Conditional requests for unchanged data return `304`. Official endpoints can derive pairs within one published table or triangulate across two tables through a shared currency; market endpoints remain limited to `TRACKED_PAIRS`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FX_PROVIDER` | `alpha_vantage` | Choose `mock` or `alpha_vantage` |
| `ALPHA_VANTAGE_API_KEY` | empty | Private server-side provider key |
| `TRACKED_PAIRS` | `USD/CNY,USD/JPY,CNY/JPY` | Comma-separated market pairs |
| `REFRESH_INTERVAL_MINUTES` | `240` | Market collection interval |
| `PROVIDER_REQUEST_SPACING_SECONDS` | `15` | Delay between provider requests |
| `PROVIDER_DAILY_BUDGET` | `25` | Rolling 24-hour call ceiling |
| `STALE_AFTER_MINUTES` | `360` | Quote age considered stale |
| `OFFICIAL_SOURCES` | five major institutions | Enabled official providers |
| `OFFICIAL_REFRESH_INTERVAL_MINUTES` | `360` | Official-source interval |
| `RETENTION_DAYS` | `90` | Snapshot retention period |
| `RESPONSE_CACHE_SECONDS` | `60` | Read response cache duration |
| `COLLECTOR_STALL_FACTOR` | `3` | Silent intervals before a job is stalled |
| `DATABASE_URL` | SQLite locally | SQLAlchemy database URL |

Extension build settings live in `extension/config.js`:

| Setting | Default | Purpose |
| --- | --- | --- |
| `defaultApiUrl` | `https://shianjeng.github.io/FX-Pulses/api/v1` | Backend the extension ships with; must be covered by `host_permissions` |
| `backendMode` | `"static"` | Mode of the default backend: `"api"` for a running FastAPI service, `"static"` for exported JSON files. An address saved on the settings page carries its own detected mode |

## Local development

Backend:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
# Copy ../.env.example to .env and fill in your key before continuing.
alembic upgrade head
python -m app.bootstrap
uvicorn app.main:app --reload
```

Run the collector in a second activated terminal:

```bash
cd backend
source .venv/bin/activate
python -m app.collector
```

Add `--once` to collect a single round and exit instead of scheduling.

Extension checks:

```bash
npm ci
npm run check:i18n
npm run check:config
npm run check:parser
npm run lint
npm test
npm run test:userscript
```

Backend checks:

```bash
cd backend
pytest
ruff check .
```

`make check && make test && make lint` runs all of the above for both stacks.

GitHub Actions runs migrations, backend and extension tests, linting, localization consistency checks, version consistency checks, and a Docker build on every push and pull request. A separate scheduled workflow publishes the [static backend](#static-backend-on-github-pages).

## Privacy and security

The page-facing userscript bridge is **off by default**. While it is enabled, any
site you allowed hover on can read cached public quote data, detect that the
extension is installed, and make the hover card stand down once per page. Enable
it only if you still run the legacy userscript. The backend address, preferences
and keys are never exposed to a page.

- By default the extension fetches public files from GitHub Pages, and live rates from Coinbase's public API. Like any website, GitHub and Coinbase can see the requesting IP address; no preferences, identifiers, or page content are sent to either. The Coinbase request is the same fixed URL for everyone. Point the extension at your own backend and turn off live rates in Settings to avoid both.
- API keys remain server-side and `.env` is ignored by Git.
- The extension contains no account system or analytics SDK.
- Personal preferences are not uploaded to the backend.
- Extension CORS is restricted to browser-extension origins.
- Content scripts use a constrained message gateway rather than arbitrary backend access.
- Hovering and selecting read the page only inside your browser. The text you point at or select is never sent anywhere; the card asks the extension for rates by currency code only.
- Official XML is parsed with `defusedxml`.
- Provider URLs containing credentials are excluded from normal logs.
- The Docker image runs as a non-root user.

## Data limitations

- FX Pulse provides informational data, not financial advice or an executable trading quote.
- Official observations are daily reference or indicative rates, not live prices.
- Cross-rates may combine observations from one institution or bridge two institutions; derived rates retain source and date labels.
- Target alerts are suppressed when quotes are stale or the backend is offline.
- Live rates arrive about once a minute, not tick by tick; the collected Alpha Vantage history is periodic.
- A static deployment is only as fresh as its last scheduled run; the popup reports a stalled collector when runs stop.
- Actual card, bank, brokerage, and remittance rates may include spreads and fees.

## 中文简介

FX Pulse 是一个免登录、重视隐私的汇率浏览器插件与 FastAPI 后端项目。插件通过两个货币选择框自由选择已覆盖的源币种和目标币种，统一查看当前汇率、官方参考价和可用走势，也能在网页中悬停识别金额并快速换算。

### 安装到浏览器

插件暂未上架 Chrome 网上应用店，需要以「已解压的扩展程序」方式添加，大约一分钟即可完成，Chrome 和 Microsoft Edge 都支持。

1. [下载 ZIP 压缩包](https://github.com/shianjeng/FX-Pulses/archive/refs/heads/main.zip)，或在本页点击绿色的 **Code** 按钮，选择 **Download ZIP**。
2. 解压后会得到 `FX-Pulses-main` 文件夹，插件就在其中的 `extension` 文件夹里。
3. 把 `FX-Pulses-main` 放到一个固定位置（例如「文稿」）。浏览器每次都从这个文件夹加载插件，之后删除或移动它，插件就会失效。
4. 在 Chrome 地址栏输入 `chrome://extensions` 并回车。
5. 打开右上角的 **开发者模式**。
6. 点击左上角的 **加载已解压的扩展程序**。
7. 选择 `extension` 文件夹（里面有 `manifest.json` 的那一层），不要选外层的 `FX-Pulses-main`。
8. 点击工具栏上的拼图图标，把 **FX Pulse** 固定到工具栏，点开即可看到汇率。也可以按 Alt+Shift+F 打开。

Edge 用户：打开 `edge://extensions`，在左侧打开 **开发人员模式**，点击 **加载解压缩的扩展**，然后按第 7、8 步操作。

更新：重新下载 ZIP，**在原来的位置**替换旧的 `FX-Pulses-main` 文件夹，再到 `chrome://extensions` 点击 FX Pulse 卡片上的刷新按钮 ↻，自选和设置会保留。浏览器是按文件夹路径识别这类插件的，如果换了位置重新加载，会变成另一个全新的 FX Pulse，之前的自选不会带过去。

如果提示「清单文件缺失或不可读取」，说明选成了外层文件夹，请改选 `extension` 文件夹。Chrome 提醒停用开发者模式扩展程序属于正常现象，保留 FX Pulse 即可。如果弹窗提示无法连接，先检查网络再点刷新；若曾在设置页改过后端地址，填回 `https://shianjeng.github.io/FX-Pulses/api/v1` 即可恢复默认。

### 项目说明

项目会明确区分 Alpha Vantage 市场买卖价、市场中间价，以及欧洲央行、加拿大央行、美联储、日本银行和中国人民银行发布的官方参考价。自选列表、目标价、语言和网页权限只保存在浏览器本地；API Key 始终保留在后端。

同一币对有多家央行报价时，2.8.4 起按实测准确度挑选（加拿大央行、欧洲央行优先，其次人民银行、日本银行，最后是晚一周发布的美联储），日期只在最新报价前后四天内的来源之间起作用。此前按“日期最新”挑选，周一早上几乎总会选中人民银行的中间价，与市场偏差 0.3%～0.4%。

2.9.0 参考了同类软件（XE、Wise、Currencies 的年度走势，Currency Converter Pro 的划词换算，Currencies 的内置计算器），新增：
- 走势图增加「1年」：使用欧洲央行最近一年的每日参考价，从欧洲央行的完整历史文件一次性读入并保留一年，约 30 种货币都有真实的一年走势，坐标轴和提示会标出年份。
- 划词换算：开启网页悬停后，选中网页上的价格即可弹出换算卡片；双击亚马逊这类拆开显示的价格数字（「¥」和「26,990」分开）也能识别。选中两个价格、长段文字或输入框里的文字不会弹出。悬停读不到价格的网页也可以用这个方法。
- 换算框支持算式：两个框都可以输入 `1200/3`、`(80+45)*2`，百分比按前面的数计算，打八折就是 `1000-20%`。支持中文和日文输入法的全角符号。输入时另一个框实时换算，按回车会把算式换成结果。
- 维护：更新 FastAPI 0.142.2、SQLAlchemy 2.1.3、Ruff 0.16.10、ESLint 10.12、jsdom 30.1.2，并修复开发工具依赖中的一个 npm audit 安全提示（不影响插件本身）。

2.8.5 起 1 个月和 3 个月的走势图显示真实历史：此前采集从 9 月 23 日才开始，7 天、1 个月、3 个月看到的都是同一周的数据。现在在采集的数据还不够覆盖所选区间时，图表改用欧洲央行最近 90 天的每日参考价。这份数据从欧洲央行官方的 90 天文件一次性读入，之后随每日采集更新。欧洲央行覆盖的约 30 种货币（包括欧元/韩元等）都有真实的长期走势，图表下方会注明数据来源。

同样在 2.8.5，默认使用实时汇率：弹窗、网页悬停、图标和目标价提醒会从 Coinbase 的公开接口获取最新中间价，使用时约每分钟更新一次，覆盖约 160 种货币。我在 14 种货币上对比过 Wise 的实时中间价，中位差 0.006%；此前的数据最多会晚 3 小时。走势图仍使用采集的历史数据。设置页可以一键关闭。Coinbase 会看到你的 IP 地址，但不会收到网页内容或任何设置。

同样在 2.8.5，走势图改为平滑曲线（仍不会在两个数据点之间凭空画出高点或低点）：右侧有整数刻度，下方有日期或时间，悬停时显示相对区间起点的涨跌幅。网页悬停现在支持亚马逊这类把价格拆成多段显示的网站（「¥」和「26,990」分开写），也支持煤炉（Mercari）盖在商品图上的价格标签，页面拦截鼠标事件或轮播图自动滚动时也不会失效。

2.8.5 还新增了可选的「工具栏图标」显示：在设置页选一个币对，它的汇率会直接显示在插件图标上（如 6.70、157），每 30 分钟和每次打开插件时更新，数据较旧时变灰，不额外消耗请求，默认关闭。其他改动：
- 快捷键 Alt+Shift+F 可打开插件。
- 换算器的两个框都能输入：在目标货币一栏输入金额，即可反算出需要多少源货币；对调或更换币种时，你输入的数字保持不变，另一栏重新计算。支持千位分隔符和全角数字。
- 换算结果按币种惯例显示小数：日元、韩元不带小数，很小的金额不再显示成 0.00。
- 状态栏会注明数据是多久以前的，例如「9/29 23:21（5小时前）」。
- 网页悬停卡片用中文显示央行名称。
- 同币种悬停显示 1:1。
- 走势图支持触屏。
- 详细视图不再出现横向滚动条。

数据采集方面，Alpha Vantage 请求超时会自动重试一次；某个币对没采到，几分钟内就会补采，不再等好几个小时（9 月 29 日曾因两次超时，USD/CNY 和 USD/JPY 断档 13 小时）。发布任务改为每小时尝试四次。

2.8.3 为维护版本，插件功能与 2.8.2 相同：后端升级到 FastAPI 0.141 / Starlette 1.7，修复了 Starlette 已公开的安全问题（Host 头导致路径判断被绕过、表单大小限制失效、Range 头拒绝服务），其余依赖与开发工具一并更新；GitHub 实际每天只执行约 5 次定时任务，数据有时超过 6 小时被标为过期，因此改为数据满 3 小时即采集（仍在 Alpha Vantage 每日额度内），并支持用外部定时器补足 GitHub 漏掉的触发，详见上文 Keeping the data fresh。

2.8.2 改进了网页划词卡片：金额按各货币惯例显示小数、靠近窗口底部时卡片显示在价格上方、只在币种有歧义时（如 ¥、$）提供候选、下拉框可选全部货币；简洁视图无需滚动；数据发布改为每小时检查一次，避免定时任务被跳过后数据过期。

2.8.1 重新设计了弹窗界面：选币种、看汇率、换算合并在一张卡片里，并支持跟随系统的深色模式；自选可以收藏任意两种货币的组合，点一下即可切换。

2.8.0 起插件默认读取本仓库每 4 小时发布到 GitHub Pages 的公共数据，安装后打开即可使用，无需 Docker、服务器或 API Key。仍可在设置页填写自己的后端地址；2.8.0 之前保存过自定义地址的用户不受影响。默认连接 GitHub Pages 时，GitHub 能看到请求方的 IP 地址，除此之外不会发送任何偏好设置或网页内容。开启实时汇率（默认开启）时，Coinbase 同样能看到 IP 地址，请求内容对所有人都一样，不含任何设置或网页内容。

2.7.0 起插件默认以简洁视图打开，只显示中间价与换算；买卖价、官方参考价、走势图和目标价提醒点击「显示详细数据」即可展开，选择会被记住。走势图改为单线加渐变填充，只标注区间最高点和最低点，下方显示所选区间的最高、最低、平均和涨跌幅。后端除了自行部署，也可以由 GitHub Actions 定时采集并导出为静态 JSON，发布到 GitHub Pages，无需常驻服务器，插件用户也不用申请 API Key。

自建后端默认使用 Alpha Vantage 市场数据，需在后端配置自己的 API Key。油猴 2.5.0 起移除了 ER-API/Frankfurter 请求，通过已授权的插件读取同一快照及官方参考价。油猴需要插件与网页悬停权限，外观、目标币种和校准设置仍独立保存。

插件界面支持中文、English 和日本語；油猴保留原有中文界面。详细迁移和统一服务设计请参阅 [UNIFIED-SERVICE.md](docs/archive/UNIFIED-SERVICE.md)。

## License

Released under the [MIT License](LICENSE).
