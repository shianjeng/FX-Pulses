<div align="center">
  <img src="extension/icons/128.png" alt="FX Pulse logo" width="112" />

  # FX Pulse

  **Exchange rates at a glance — live market quotes, official references, and instant webpage conversion.**

  A privacy-friendly Chrome extension powered by a self-hosted FastAPI service.

  [Quick Start](#quick-start) · [Features](#features) · [Data Sources](#data-sources) · [API](#api) · [中文简介](#中文简介)

  <p>
    <a href="https://github.com/shianjeng/FX-Pulses/actions/workflows/ci.yml"><img src="https://github.com/shianjeng/FX-Pulses/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
    <img src="https://img.shields.io/badge/version-2.3.0-36D9A0" alt="Version 2.3.0" />
    <img src="https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white" alt="Python 3.12" />
    <img src="https://img.shields.io/badge/FastAPI-0.116-009688?logo=fastapi&logoColor=white" alt="FastAPI 0.116" />
    <img src="https://img.shields.io/badge/Chrome-Manifest_V3-4285F4?logo=googlechrome&logoColor=white" alt="Chrome Manifest V3" />
    <img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL 16" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-F5C542" alt="MIT License" /></a>
  </p>
</div>

---

## What is FX Pulse?

FX Pulse brings a compact exchange-rate dashboard and webpage hover converter into one browser extension. It keeps **tradable market quotes** separate from **daily official reference rates**, so every number has a clear meaning and source.

The extension and hover converter share the same backend, one-minute cache, watchlist, target currency, and language preference. No Tampermonkey script is required.

> **Market midpoint** = `(bid + ask) / 2`. It is not a bank settlement rate, card-network rate, or central-bank fixing.

## Features

| | Capability | Details |
| --- | --- | --- |
| 📊 | Three-pair overview | See `USD/CNY`, `USD/JPY`, and `CNY/JPY` together |
| ↕️ | Market quote detail | Bid, ask, midpoint, spread, freshness, and 24-hour movement |
| 📈 | Interactive history | Switch between 1, 7, 30, and 90-day SVG charts |
| 🏛️ | Official references | Compare market midpoints with central-bank reference observations |
| ⚡ | Hover conversion | Point at an amount on a webpage to convert it without leaving the page |
| 🧮 | Quick converter | Reverse conversion direction and copy results in one click |
| 🔔 | Optional alerts | Local target-price alerts powered by `chrome.alarms` |
| 🌐 | Three languages | Complete Chinese, English, and Japanese interfaces |
| 🔒 | Privacy first | No account, analytics SDK, or server-side storage of personal preferences |

Hover conversion is **off by default**. Enable it from Settings, grant access only to the websites you choose, and refresh those pages. If you used the legacy userscript, disable it to avoid duplicate cards.

## Data sources

FX Pulse labels each data layer instead of presenting unrelated rates as if they were interchangeable.

| Layer | Source | Refresh model | Meaning |
| --- | --- | --- | --- |
| Market quotes | Alpha Vantage | Configurable; free profile defaults to four hours | Bid, ask, and arithmetic midpoint |
| Demo quotes | Built-in deterministic provider | Local | Development and interface testing only |
| Official references | European Central Bank | Daily on business days | Indicative reference observations |
| Official references | Bank of Canada | Daily on business days | Indicative reference observations |
| Official references | Federal Reserve Board | H.10 business-day release | Daily exchange-rate observations |
| Official references | Bank of Japan | Tokyo business days | USD/JPY spot rate at 17:00 JST |
| Official references | People's Bank of China | Business days | RMB central parity reference |

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
flowchart LR
    Browser["Chrome extension"] -->|Read-only API| API["FastAPI"]
    API --> DB[("PostgreSQL / SQLite")]
    Alpha["Alpha Vantage"] --> Collector["Scheduled collector"]
    Banks["ECB · BoC · Fed · BoJ · PBOC"] --> Collector
    Collector --> DB
```

The browser never contacts upstream rate providers directly. A standalone collector validates and stores observations before the API serves them from the database. Browser requests therefore do not consume Alpha Vantage quota.

User watchlists, targets, language selection, hover preferences, and per-site currency choices stay in `chrome.storage.local`.

## Quick start

### Requirements

- Docker Desktop or Docker Engine with Compose
- Chrome or Microsoft Edge

### 1. Start in demo mode

```bash
cp .env.example .env
docker compose up -d --build
```

Demo mode uses deterministic sample quotes and requires no API key.

| Service | Address |
| --- | --- |
| Health check | <http://localhost:8000/health> |
| Latest rates | <http://localhost:8000/api/v1/rates> |
| Interactive API docs | <http://localhost:8000/docs> |

### 2. Load the extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this repository's `extension` directory.
5. Pin FX Pulse to the browser toolbar.

The default backend address is `http://localhost:8000/api/v1`. You can change it from the extension settings page.

### 3. Use live Alpha Vantage quotes

Create a private Alpha Vantage API key, then prepare the live profile:

```bash
cp alpha-vantage.env.example .env
```

Open `.env` and replace the placeholder:

```dotenv
FX_PROVIDER=alpha_vantage
ALPHA_VANTAGE_API_KEY=your_private_key
```

Restart the stack:

```bash
docker compose down
docker compose up -d --build --force-recreate
```

Confirm that `/health` reports `"provider": "alpha_vantage"` and inspect the collector if necessary:

```bash
docker compose logs --tail=100 collector
```

The included free-plan profile collects three pairs every four hours, spaces pair requests by 15 seconds, and caps attempts at 25 per rolling 24-hour window. Do not shorten the interval unless your key has a verified higher quota.

## API

All application endpoints are public, cached, rate-limited, and read-only.

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/health` | API, provider, and collector status |
| `GET` | `/api/v1/pairs` | Configured market pairs |
| `GET` | `/api/v1/currencies` | Market and official-source coverage |
| `GET` | `/api/v1/rates` | Latest cached market quotes |
| `GET` | `/api/v1/rates/{base}/{quote}` | Latest quote for one pair |
| `GET` | `/api/v1/rates/{base}/{quote}/history?days=7` | One to 90 days of history |
| `GET` | `/api/v1/official-rates` | Latest official observations |
| `GET` | `/api/v1/official-rates/{base}/{quote}` | Official observations for a covered pair |
| `GET` | `/api/v1/comparisons/{base}/{quote}` | Market and official-rate comparison |

Responses include `ETag` and `Cache-Control`. Conditional requests for unchanged data return `304`. Official endpoints can cross any pair covered by one institution's published table; market endpoints remain limited to `TRACKED_PAIRS`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FX_PROVIDER` | `mock` | Choose `mock` or `alpha_vantage` |
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

## Local development

Backend:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
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

Extension checks:

```bash
npm ci
npm run check:i18n
npm run lint
npm test
```

Backend checks:

```bash
cd backend
pytest
ruff check .
```

GitHub Actions runs migrations, backend and extension tests, linting, localization consistency checks, version consistency checks, and a Docker build on every push and pull request.

## Privacy and security

- API keys remain server-side and `.env` is ignored by Git.
- The extension contains no account system or analytics SDK.
- Personal preferences are not uploaded to the backend.
- Extension CORS is restricted to browser-extension origins.
- Content scripts use a constrained message gateway rather than arbitrary backend access.
- Official XML is parsed with `defusedxml`.
- Provider URLs containing credentials are excluded from normal logs.
- The Docker image runs as a non-root user.

## Data limitations

- FX Pulse provides informational data, not financial advice or an executable trading quote.
- Official observations are daily reference or indicative rates, not live prices.
- Cross-rates may combine two observations from the same institution and are marked as derived.
- Target alerts are suppressed when quotes are stale or the backend is offline.
- The free Alpha Vantage profile is periodic rather than streaming.
- Actual card, bank, brokerage, and remittance rates may include spreads and fees.

## 中文简介

FX Pulse 是一个免登录、重视隐私的汇率浏览器插件与 FastAPI 后端项目。插件可以同时查看 `USD/CNY`、`USD/JPY` 和 `CNY/JPY` 三组市场行情，也能在网页中悬停识别金额并快速换算。

项目会明确区分 Alpha Vantage 市场买卖价、市场中间价，以及欧洲央行、加拿大央行、美联储、日本银行和中国人民银行发布的官方参考价。自选列表、目标价、语言和网页权限只保存在浏览器本地；API Key 始终保留在后端。

界面完整支持中文、English 和日本語。详细迁移和统一服务设计请参阅 [UNIFIED-SERVICE.md](UNIFIED-SERVICE.md)。

## License

Released under the [MIT License](LICENSE).
