<div align="center">
  <img src="extension/icons/128.png" alt="FX Pulse icon" width="96" />
  <h1>FX Pulse</h1>
  <p><strong>Market FX quotes and official reference rates—clearly separated, normalized, and compared.</strong></p>
  <p>A privacy-friendly browser extension backed by a production-minded FastAPI service.</p>

  <p>
    <img src="https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white" alt="Python 3.12" />
    <img src="https://img.shields.io/badge/FastAPI-0.116-009688?logo=fastapi&logoColor=white" alt="FastAPI" />
    <img src="https://img.shields.io/badge/Chrome-Manifest_V3-4285F4?logo=googlechrome&logoColor=white" alt="Chrome Manifest V3" />
    <img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL 16" />
    <a href="https://github.com/shianjeng/FX-Pulses/actions/workflows/ci.yml"><img src="https://github.com/shianjeng/FX-Pulses/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License" /></a>
  </p>
</div>

---

FX Pulse is more than a currency converter. It combines live market bid/ask data with daily reference rates published by monetary authorities, normalizes different quotation conventions, and exposes the result through a compact browser interface and a read-only REST API.

The project currently focuses on three pairs:

- `USD/CNY`
- `USD/JPY`
- `CNY/JPY`

## Why FX Pulse?

Most exchange-rate tools display one number without explaining what it represents. FX Pulse keeps the data categories explicit:

| Data layer | What it represents | Current sources |
| --- | --- | --- |
| Market quote | Bid, ask, and arithmetic midpoint | Alpha Vantage or deterministic mock data |
| Official reference | Daily indicative/reference observation | European Central Bank and Bank of Canada |
| Comparison | Percentage difference between market midpoint and official reference | Calculated by the FX Pulse API |

Official observations are never presented as tradable live prices. Cross-calculated values are marked with `is_derived=true`, and every official record keeps its institution, reference date, fetch time, and source URL.

## Highlights

### Browser experience

- Market bid, ask, midpoint, spread, and 24-hour movement
- Seven-day SVG trend chart with interactive values
- Official reference-rate comparison for the selected pair
- Quick currency converter with direction reversal
- Local watchlist and target-price preferences
- One-click copy with a selectable-text fallback
- No account, analytics SDK, or background polling

### Backend engineering

- FastAPI read-only API with typed Pydantic responses
- SQLAlchemy persistence with Alembic migrations
- SQLite for local development and PostgreSQL through Docker Compose
- Dedicated APScheduler collector separated from API workers
- Persisted rolling provider-call budget
- Request spacing for Alpha Vantage free-key burst limits
- Provider isolation: mock and live observations never mix
- Retention cleanup, stale-data flags, CORS restrictions, and read rate limiting
- Official-source adapters with normalized cross-rate calculation

### Quality and operations

- Backend tests with `pytest` and `pytest-asyncio`
- Extension DOM tests with Node.js and JSDOM
- Python linting with Ruff and JavaScript linting with ESLint
- GitHub Actions CI
- Non-root Docker image and explicit migration step
- API keys remain server-side and are excluded from Git

## Architecture

```mermaid
flowchart LR
    Extension["Browser extension"] -->|Read-only REST| API["FastAPI"]
    API --> Database[("Rate database")]
    Market["Alpha Vantage"] --> Collector["Scheduled collector"]
    Official["ECB + Bank of Canada"] --> Collector
    Collector --> Database
    Extension --> Local["Local preferences"]
```

The API never calls upstream providers during a browser request. One standalone collector fetches and validates shared public-rate data, then writes snapshots to the database. Watchlists and target prices remain inside `chrome.storage.local` and are never sent to the backend.

## Quick start

### Requirements

- Docker Desktop or Docker Engine with Compose
- Chrome or Microsoft Edge for the extension

### 1. Start the demo backend

```bash
cp .env.example .env
docker compose up --build
```

The default `FX_PROVIDER=mock` mode needs no API key and seeds deterministic demo history.

Once the containers are ready:

- API documentation: <http://localhost:8000/docs>
- Health check: <http://localhost:8000/health>
- Latest rates: <http://localhost:8000/api/v1/rates>

### 2. Load the extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the repository's `extension` directory.
5. Pin FX Pulse and open it from the browser toolbar.

The default API address is `http://localhost:8000/api/v1`. A deployed HTTPS endpoint can be configured from the extension settings page.

## Enable Alpha Vantage market data

Create a private Alpha Vantage API key, then use the prepared free-plan profile:

```bash
cp alpha-vantage.env.example .env
```

Replace only the placeholder inside `.env`:

```dotenv
ALPHA_VANTAGE_API_KEY=your_private_key
```

Then restart the stack:

```bash
docker compose down
docker compose up --build
```

The default live profile:

- refreshes three pairs every four hours;
- spaces pair requests by 15 seconds to avoid burst throttling;
- caps provider attempts at 25 per rolling 24-hour window;
- suppresses request-URL logging so API keys do not appear in collector logs.

Alpha Vantage returns a real-time observation when queried, but the free profile is not a continuous streaming feed. Do not reduce the refresh interval unless the key has a verified higher quota.

## API

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/health` | Service status and configured market provider |
| `GET` | `/api/v1/pairs` | Tracked currency pairs |
| `GET` | `/api/v1/rates` | Latest cached market quotes |
| `GET` | `/api/v1/rates/{base}/{quote}` | Latest quote for one pair |
| `GET` | `/api/v1/rates/{base}/{quote}/history?days=7` | One to 90 days of market history |
| `GET` | `/api/v1/official-rates` | Latest normalized official observations |
| `GET` | `/api/v1/official-rates/{base}/{quote}` | Official observations for one pair |
| `GET` | `/api/v1/comparisons/{base}/{quote}` | Market midpoint and official-rate comparison |

All application endpoints are public and read-only. Reading cached rates never spends upstream API quota.

## Local development

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
python -m app.collector
```

## Tests and linting

Backend:

```bash
cd backend
pytest
ruff check .
```

Extension:

```bash
npm ci
npm test
npm run lint
```

CI runs the backend and extension checks on every push and pull request.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FX_PROVIDER` | `mock` | Select `mock` or `alpha_vantage` market data |
| `ALPHA_VANTAGE_API_KEY` | empty | Private server-side provider key |
| `TRACKED_PAIRS` | `USD/CNY,USD/JPY,CNY/JPY` | Comma-separated tracked pairs |
| `REFRESH_INTERVAL_MINUTES` | `240` | Market collection interval |
| `PROVIDER_REQUEST_SPACING_SECONDS` | `15` | Delay between live pair requests |
| `PROVIDER_DAILY_BUDGET` | `25` | Rolling 24-hour provider-call ceiling |
| `STALE_AFTER_MINUTES` | `360` | Age at which a market quote becomes stale |
| `OFFICIAL_REFRESH_INTERVAL_MINUTES` | `360` | Official-source collection interval |
| `RETENTION_DAYS` | `90` | Snapshot retention period |
| `DATABASE_URL` | SQLite | SQLAlchemy database connection URL |

## Privacy and security

- No user accounts, authentication database, or personal profiles
- No server-side storage of watchlists or target prices
- No API key in the extension bundle
- `.env` is ignored by Git
- Extension CORS is restricted to browser-extension origins
- Provider URLs containing credentials are not emitted at normal log levels
- Public endpoints are read-only and protected by a fixed-window request limit

## Data limitations

- A market midpoint is `(bid + ask) / 2`; it is not a bank, card-network, or remittance settlement rate.
- ECB and Bank of Canada observations are daily reference/indicative rates, not tradable quotes.
- Cross-rates may combine two observations from the same institution and are explicitly marked as derived.
- Target prices are informational and checked only when the popup is opened.
- The included free Alpha Vantage profile refreshes periodically rather than continuously.

## 中文简介

FX Pulse 是一个免登录的汇率浏览器插件与 FastAPI 后端项目。它同时展示市场买卖价、中间价以及欧洲央行、加拿大央行发布的官方参考汇率，并统一不同机构的报价口径，计算市场中间价与官方参考价之间的偏差。

自选列表和目标价只保存在浏览器本地；后端只负责保护行情 API Key、定时采集公共汇率、保存历史快照并提供只读接口。官方参考价、交叉推算价和实时市场行情会被明确区分，避免把不同性质的数据混为一谈。

## License

Released under the [MIT License](LICENSE).
