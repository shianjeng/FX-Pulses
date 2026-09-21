from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, call

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from app.config import Settings, get_settings
from app.database import SessionLocal
from app.models import RateSnapshot
from app.providers import AlphaVantageProvider, ProviderError, Quote
from app.services import prune_history, refresh_all_rates, reserve_request, store_quote


@pytest.mark.parametrize("pairs", ["", "USD", "USD/CNY/JPY", "USD/USD", "USD/CNY,"])
def test_bad_pairs_fail_at_configuration(pairs):
    with pytest.raises(ValidationError):
        Settings(tracked_pairs=pairs, _env_file=None)


def test_normalize_and_budget():
    assert Settings(tracked_pairs=" usd/cny ,USD/CNY", _env_file=None).tracked_pairs == ["USD/CNY"]
    free = Settings(
        fx_provider="alpha_vantage", alpha_vantage_api_key="test",
        refresh_interval_minutes=240, _env_file=None,
    )
    assert free.provider_daily_budget == 25
    with pytest.raises(ValidationError):
        Settings(fx_provider="alpha_vantage", alpha_vantage_api_key="test",
                 refresh_interval_minutes=1, _env_file=None)


def test_slotted_quote_and_retention():
    with SessionLocal() as db:
        for days in [1, 91]:
            store_quote(db, Quote("USD", "CNY", Decimal("7"), Decimal("7.2"),
                                 Decimal("7.1"), "mock",
                                 datetime.now(timezone.utc) - timedelta(days=days)))
        prune_history(db)
        assert len(db.scalars(select(RateSnapshot)).all()) == 1


def test_budget_survives_sessions(monkeypatch):
    monkeypatch.setattr(get_settings(), "provider_daily_budget", 1)
    with SessionLocal() as db:
        assert reserve_request(db)
    with SessionLocal() as db:
        assert not reserve_request(db)


@pytest.mark.asyncio
async def test_provider_errors_logged(monkeypatch, caplog):
    provider = AsyncMock()
    provider.get_quote.side_effect = RuntimeError("offline")
    monkeypatch.setattr("app.services.get_provider", lambda: provider)
    result = await refresh_all_rates()
    assert result["errors"] == 3
    assert "Quote refresh failed" in caplog.text


@pytest.mark.asyncio
async def test_alpha_vantage_pair_requests_are_spaced(monkeypatch):
    provider = AsyncMock()
    provider.get_quote.return_value = Quote(
        "USD", "CNY", Decimal("7"), Decimal("7.2"), Decimal("7.1"),
        "alpha_vantage", datetime.now(timezone.utc),
    )
    sleep = AsyncMock()
    monkeypatch.setattr(get_settings(), "fx_provider", "alpha_vantage")
    monkeypatch.setattr(get_settings(), "provider_request_spacing_seconds", 15)
    monkeypatch.setattr("app.services.get_provider", lambda: provider)
    monkeypatch.setattr("app.services.asyncio.sleep", sleep)

    result = await refresh_all_rates()

    assert result == {"refreshed": 3, "errors": 0}
    assert sleep.await_args_list == [call(15), call(15), call(0)]


def test_api_start_never_calls_provider(client, monkeypatch):
    provider = AsyncMock()
    monkeypatch.setattr("app.services.get_provider", lambda: provider)
    assert client.get("/health").status_code == 200
    assert client.get("/api/v1/rates").status_code == 200
    provider.get_quote.assert_not_called()


def test_rate_limit(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "api_requests_per_minute", 1)
    assert client.get("/api/v1/rates").status_code == 200
    assert client.get("/api/v1/rates").status_code == 429
    assert client.get("/health").status_code == 200


@pytest.mark.asyncio
async def test_provider_timezone(monkeypatch):
    import httpx
    payload = {"Realtime Currency Exchange Rate": {
        "8. Bid Price": "7", "9. Ask Price": "7.2",
        "6. Last Refreshed": "2026-09-18 12:00:00", "7. Time Zone": "Asia/Tokyo",
    }}
    response = httpx.Response(200, json=payload)
    mock = AsyncMock()
    mock.__aenter__.return_value = mock
    mock.get.return_value = response
    monkeypatch.setattr("app.providers.httpx.AsyncClient", lambda **kwargs: mock)
    quote = await AlphaVantageProvider("test").get_quote("USD", "CNY")
    assert quote.captured_at.hour == 3
    assert quote.midpoint == Decimal("7.1")


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [
    {"Note": "API call frequency reached"},
    {"Information": "This endpoint is unavailable for the current key"},
])
async def test_provider_reports_quota_without_echoing_upstream(monkeypatch, payload):
    import httpx
    response = httpx.Response(200, json=payload)
    mock = AsyncMock()
    mock.__aenter__.return_value = mock
    mock.get.return_value = response
    monkeypatch.setattr("app.providers.httpx.AsyncClient", lambda **kwargs: mock)
    with pytest.raises(ProviderError, match="quota or endpoint entitlement"):
        await AlphaVantageProvider("secret-key").get_quote("USD", "CNY")


def test_rate_limit_is_per_client(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "api_requests_per_minute", 3)
    import app.main as main
    main._hits.clear()
    noisy = {"x-forwarded-for": "198.51.100.7"}
    monkeypatch.setattr(get_settings(), "trust_forwarded_for", True)
    for _ in range(3):
        assert client.get("/api/v1/pairs", headers=noisy).status_code == 200
    assert client.get("/api/v1/pairs", headers=noisy).status_code == 429
    # A different client must not inherit the noisy one's exhausted budget.
    assert client.get(
        "/api/v1/pairs", headers={"x-forwarded-for": "203.0.113.9"}
    ).status_code == 200
    main._hits.clear()


def test_collector_heartbeat_records_failures_and_recovery():
    from app.models import CollectorRun
    from app.services import MARKET_JOB, record_run
    with SessionLocal() as db:
        record_run(db, MARKET_JOB, ok=False, error="offline")
        record_run(db, MARKET_JOB, ok=False, error="offline")
        run = db.scalar(select(CollectorRun).where(CollectorRun.job == MARKET_JOB))
        assert run.consecutive_failures == 2
        assert run.last_success_at is None
        record_run(db, MARKET_JOB, ok=True)
        db.refresh(run)
        assert run.consecutive_failures == 0
        assert run.last_success_at is not None
