# Upgrade checklist

This delivery is an updated source package, not a push to your GitHub repository.
Keep the repository's .git directory. Copy revised source files into your checkout.

Before upgrading: back up your database. Stop the old API with its embedded
scheduler; do not run it alongside the new collector.

1. Install backend dependencies from the revised pyproject.toml.
2. From backend/, run alembic upgrade head (one process only).
3. For mock data, run python -m app.bootstrap.
4. Start API: uvicorn app.main:app --reload.
5. In a second terminal, start python -m app.collector.
6. Reload the extension and accept its added clipboardWrite permission.
7. Remove the old promotional assets from your repository if present:
   docs/screenshots/extension.png, extension.svg, fx-pulse-current-rates.png.
   The README no longer embeds them. Replace with your real capture later.

Docker Compose handles migration/bootstrap, API, and the singleton collector.
Do not use docker compose down -v during an upgrade: it deletes database volumes.

Validated here: backend tests, extension DOM tests and lint, SQLite migration
upgrade twice, mock bootstrap. Not validated here: PostgreSQL migration against a
running server, Docker build/runtime, installed browser clipboard permissions,
or your private Alpha Vantage key. Public demo response is not an entitlement test.

The in-process API limiter is not a distributed rate limiter. Public multi-worker
deployments need gateway limits. The collector lock requires a shared volume;
only one collector is supported across hosts. Request budget is not a cross-host
distributed reservation mechanism.
