from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.database import SessionLocal
from app.main import app
from app.providers import AlphaVantageProvider, Quote
from app.services import refresh_all_rates, store_quote


def test_live_reads_and_history_exclude_mock_rows(monkeypatch):
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        for provider, value in [("mock", "99"), ("alpha_vantage", "7")]:
            amount = Decimal(value)
            store_quote(db, Quote("USD", "CNY", amount, amount, amount, provider, now))
    monkeypatch.setattr(get_settings(), "fx_provider", "alpha_vantage")
    with TestClient(app) as client:
        assert client.get("/api/v1/rates/USD/CNY").json()["provider"] == "alpha_vantage"
        history = client.get("/api/v1/rates/USD/CNY/history").json()
        assert len(history) == 1
        assert Decimal(history[0]["midpoint"]) == Decimal("7")


def test_api_lifespan_does_not_start_upstream_requests(monkeypatch):
    provider = AsyncMock()
    monkeypatch.setattr("app.services.get_provider", lambda: provider)
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/api/v1/rates").json() == []
    provider.get_quote.assert_not_called()


@pytest.mark.asyncio
async def test_network_exception_logs_do_not_expose_key(monkeypatch, caplog):
    key = "test-secret-must-never-appear"
    client = AsyncMock()
    client.__aenter__.return_value = client
    client.get.side_effect = httpx.ConnectError(f"Failed https://example.com?apikey={key}")
    monkeypatch.setattr("app.providers.httpx.AsyncClient", lambda **kwargs: client)
    monkeypatch.setattr("app.services.get_provider", lambda: AlphaVantageProvider(key))
    result = await refresh_all_rates()
    assert result["errors"] == 3
    assert "network request failed" in caplog.text
    assert key not in caplog.text
