# FX Pulse

> A privacy-friendly browser extension for checking CNY, USD, and JPY market midpoints at a glance — no account required.

FX Pulse turns the browser toolbar into a compact exchange-rate dashboard. Open it to see bid, ask, midpoint, 24-hour movement, a seven-day trend, a quick converter, and locally stored target-price status. A small FastAPI service protects the upstream data key and caches shared market snapshots.

![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.116-009688?logo=fastapi&logoColor=white)
![Chrome](https://img.shields.io/badge/Chrome-Manifest_V3-4285F4?logo=googlechrome&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![CI](https://img.shields.io/badge/CI-GitHub_Actions-2088FF?logo=githubactions&logoColor=white)

## Preview

![FX Pulse login-free browser extension](docs/screenshots/extension.png)

## Product principles

- **Open and check:** the extension requests data only when its popup is open.
- **No login:** there are no accounts, passwords, JWTs, email addresses, or user profiles.
- **Local preferences:** the watchlist and target prices stay in `chrome.storage.local`.
- **Auditable midpoint:** the API preserves bid and ask, then calculates `(bid + ask) / 2`.
- **Honest status:** stale quotes are marked instead of being presented as live.

## Features

- Market bid, ask, midpoint, spread, and 24-hour change
- Seven-day SVG sparkline with high, low, and range position
- Currency converter with one-click direction reversal
- Local watchlist management
- Local target-price status, evaluated when the popup is opened
- One-click copy of the selected quote
- Alpha Vantage live adapter and a zero-setup deterministic demo adapter
- SQLite locally and PostgreSQL through Docker Compose
- Public read-only API with browser-extension CORS support
- Backend tests, linting, and GitHub Actions CI

## Architecture

```mermaid
flowchart LR
    Extension[Browser extension] -->|Public read-only REST| API[FastAPI]
    API --> Cache[(Rate snapshots)]
    Scheduler[APScheduler] --> Provider[FX data provider]
    Provider --> Scheduler
    Scheduler --> Cache
    Extension --> Local[Browser local storage]
```

The backend collects shared market data; it never receives a user's watchlist or target price. The extension has no service worker, alarm, email integration, or notification permission.

## Quick start — Docker

Requirements: Docker Desktop or Docker Engine with Compose.

```bash
cp .env.example .env
docker compose up --build
```

Then open:

- API documentation: <http://localhost:8000/docs>
- Health check: <http://localhost:8000/health>

The default `FX_PROVIDER=mock` mode requires no external key and seeds 30 days of realistic sample history.

## Install the Chrome / Edge extension

1. Start the backend.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the project's `extension` directory.
6. Pin FX Pulse and click its toolbar icon.

No registration is required. The default API address is `http://localhost:8000/api/v1`. For a deployed API, open the extension settings and enter its HTTPS address.

## Local backend development

```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
uvicorn app.main:app --reload
```

The default database is SQLite, so PostgreSQL is not required for local development.

## Use live bid/ask data

Create an Alpha Vantage API key, then update `.env`:

```dotenv
FX_PROVIDER=alpha_vantage
ALPHA_VANTAGE_API_KEY=your_key_here
```

Restart the backend afterward. The API key stays on the server and is never included in the extension bundle. Provider request limits may change, so check the provider's current quota before lowering `REFRESH_INTERVAL_MINUTES`.

## API overview

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health and active-provider status |
| `GET` | `/api/v1/pairs` | List supported currency pairs |
| `GET` | `/api/v1/rates` | List the latest cached quotes |
| `GET` | `/api/v1/rates/{base}/{quote}` | Read one quote |
| `GET` | `/api/v1/rates/{base}/{quote}/history?days=7` | Read 1–90 days of snapshots |

All application endpoints are read-only and require no token.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `FX_PROVIDER` | `mock` | `mock` or `alpha_vantage` |
| `ALPHA_VANTAGE_API_KEY` | empty | Server-side key for live data |
| `TRACKED_PAIRS` | `USD/CNY,USD/JPY,CNY/JPY` | Comma-separated available pairs |
| `REFRESH_INTERVAL_MINUTES` | `240` | Server-side collection interval |
| `STALE_AFTER_MINUTES` | `360` | Age at which a quote is marked stale |
| `DATABASE_URL` | SQLite | SQLAlchemy database URL |

## Quality checks

```bash
cd backend
pytest
ruff check .
```

CI repeats both checks on every push and pull request.

## Scope and limitations

- Target prices are informational and are checked only when the popup is opened.
- Preferences do not sync between browsers or devices.
- The midpoint is a market reference, not the final rate offered by a bank, card network, or remittance service.
- Demo quotes are synthetic; use a live provider before relying on the displayed market data.

## 中文说明

FX Pulse 是一款免登录的汇率浏览器插件。点击浏览器工具栏图标后，可以查看人民币、美元和日元的买入价、卖出价、市场中间价、涨跌幅和七日走势，也可以快速换算金额、管理自选并设置本地目标价。

插件不会在后台持续轮询，也不会收集邮箱、密码、自选列表或目标价。自选与目标价只保存在当前浏览器中，并在用户打开插件时检查。后端仅负责保护第三方行情密钥、缓存公共汇率和提供历史数据。

这里的“中间价”特指市场买入价与卖出价的算术平均值，并不是中国人民银行公布的人民币汇率中间价，也不代表最终成交价。

## Author

Hank
GitHub: https://github.com/shianjeng

## License

[MIT](LICENSE)
