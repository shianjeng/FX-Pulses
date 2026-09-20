from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from app.config import Settings, get_settings
from app.database import SessionLocal
from app.models import RateSnapshot
from app.providers import AlphaVantageProvider, Quote
from app.services import prune_history, refresh_all_rates, reserve_request, store_quote


@pytest.mark.parametrize("pairs", ["", "USD", "USD/CNY/JPY", "USD/USD", "USD/CNY,"])
def test_bad_pairs_fail_at_configuration(pairs):
    with pytest.raises(ValidationError):
        Settings(tracked_pairs=pairs, _env_file=None)


def test_normalize_and_budget():
    assert Settings(tracked_pairs=" usd/cny ,USD/CNY", _env_file=None).tracked_pairs == ["USD/CNY"]
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
