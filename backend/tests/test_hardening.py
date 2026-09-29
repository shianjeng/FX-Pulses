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


def test_conditional_response_keeps_extension_cors_headers(client):
    origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    first = client.get("/api/v1/pairs", headers={"origin": origin})
    cached = client.get(
        "/api/v1/pairs",
        headers={"origin": origin, "if-none-match": first.headers["etag"]},
    )
    assert cached.status_code == 304
    assert cached.headers["access-control-allow-origin"] == origin


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


def test_default_live_provider_requires_key(monkeypatch):
    monkeypatch.delenv("FX_PROVIDER", raising=False)
    monkeypatch.delenv("ALPHA_VANTAGE_API_KEY", raising=False)
    with pytest.raises(ValidationError, match="ALPHA_VANTAGE_API_KEY"):
        Settings(_env_file=None)
    assert Settings(alpha_vantage_api_key="test", _env_file=None).fx_provider == "alpha_vantage"
    assert Settings(fx_provider="mock", _env_file=None).fx_provider == "mock"


def av_quote(base="USD", quote="CNY", captured_at=None):
    return Quote(base, quote, Decimal("7"), Decimal("7.2"), Decimal("7.1"), "alpha_vantage",
                 captured_at or datetime.now(timezone.utc))


def metered(monkeypatch, provider):
    sleep = AsyncMock()
    monkeypatch.setattr(get_settings(), "fx_provider", "alpha_vantage")
    monkeypatch.setattr(get_settings(), "provider_request_spacing_seconds", 15)
    monkeypatch.setattr("app.services.get_provider", lambda: provider)
    monkeypatch.setattr("app.services.asyncio.sleep", sleep)
    return sleep


@pytest.mark.asyncio
async def test_a_transient_failure_is_retried_once_and_counted(monkeypatch):
    from app.models import ProviderRequest
    from app.providers import TransientProviderError
    provider = AsyncMock()
    provider.get_quote.side_effect = [TransientProviderError("timeout")] + [av_quote()] * 3
    sleep = metered(monkeypatch, provider)

    assert await refresh_all_rates() == {"refreshed": 3, "errors": 0}
    assert provider.get_quote.await_count == 4
    assert sleep.await_args_list[0] == call(15)
    with SessionLocal() as db:
        # The retry is a real upstream call, so it spends budget like one.
        assert len(db.scalars(select(ProviderRequest)).all()) == 4


@pytest.mark.asyncio
async def test_a_second_transient_failure_gives_up_on_that_pair_only(monkeypatch, caplog):
    from app.providers import TransientProviderError
    provider = AsyncMock()
    failure = TransientProviderError("timeout")
    provider.get_quote.side_effect = [failure, failure, av_quote(), av_quote()]
    metered(monkeypatch, provider)

    assert await refresh_all_rates() == {"refreshed": 2, "errors": 1}
    assert "Retrying USD/CNY" in caplog.text


@pytest.mark.asyncio
async def test_a_rejected_request_is_not_retried(monkeypatch):
    provider = AsyncMock()
    provider.get_quote.side_effect = ProviderError("Alpha Vantage rejected the pair or API key")
    metered(monkeypatch, provider)
    assert await refresh_all_rates() == {"refreshed": 0, "errors": 3}
    assert provider.get_quote.await_count == 3


@pytest.mark.asyncio
async def test_skip_fresh_fetches_only_the_pairs_that_fell_behind(monkeypatch):
    from app.models import CollectorRun
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        store_quote(db, av_quote("USD", "CNY", now - timedelta(minutes=20)))
        store_quote(db, av_quote("USD", "JPY", now - timedelta(minutes=200)))
    provider = AsyncMock()
    provider.get_quote.return_value = av_quote()
    metered(monkeypatch, provider)

    result = await refresh_all_rates(skip_fresh_minutes=120)
    assert result == {"refreshed": 2, "errors": 0, "skipped": 1}
    assert [c.args for c in provider.get_quote.await_args_list] == [("USD", "JPY"), ("CNY", "JPY")]

    provider.get_quote.reset_mock()
    with SessionLocal() as db:
        for pair in ["USD/JPY", "CNY/JPY"]:
            store_quote(db, av_quote(*pair.split("/")))
    result = await refresh_all_rates(skip_fresh_minutes=120)
    assert result == {"refreshed": 0, "errors": 0, "skipped": 3}
    provider.get_quote.assert_not_called()
    with SessionLocal() as db:
        run = db.scalar(select(CollectorRun).where(CollectorRun.job == "market"))
        # Nothing was due, which is not a failure.
        assert run.consecutive_failures == 0 and run.last_success_at is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["timeout", "503"])
async def test_provider_marks_network_and_server_failures_transient(monkeypatch, failure):
    import httpx

    from app.providers import TransientProviderError
    mock = AsyncMock()
    mock.__aenter__.return_value = mock
    if failure == "timeout":
        mock.get.side_effect = httpx.ReadTimeout("https://www.alphavantage.co/query?apikey=secret-key")
    else:
        mock.get.return_value = httpx.Response(503)
    monkeypatch.setattr("app.providers.httpx.AsyncClient", lambda **kwargs: mock)
    with pytest.raises(TransientProviderError) as raised:
        await AlphaVantageProvider("secret-key").get_quote("USD", "CNY")
    assert "secret-key" not in str(raised.value)
    assert raised.value.__cause__ is None
