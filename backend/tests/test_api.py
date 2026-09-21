from decimal import Decimal

from fastapi.testclient import TestClient

from app.config import get_settings


def test_public_rates_need_no_login(client: TestClient):
    response = client.get("/api/v1/rates")
    assert response.status_code == 200
    assert len(response.json()) == 3


def test_midpoint_and_spread_are_auditable(client: TestClient):
    for quote in client.get("/api/v1/rates").json():
        bid = Decimal(quote["bid"])
        ask = Decimal(quote["ask"])
        midpoint = Decimal(quote["midpoint"])
        assert abs(midpoint - (bid + ask) / 2) < Decimal("0.00000001")
        assert Decimal(quote["spread"]) == ask - bid


def test_pair_and_history_endpoints(client: TestClient):
    pair = client.get("/api/v1/rates/USD/CNY")
    history = client.get("/api/v1/rates/USD/CNY/history?days=7")
    assert pair.status_code == 200
    assert pair.json()["base_currency"] == "USD"
    assert history.status_code == 200
    assert history.json()
    assert client.get("/api/v1/rates/ABC/XYZ").status_code == 404


def test_browser_extension_origin_is_allowed(client: TestClient):
    response = client.options(
        "/api/v1/rates",
        headers={
            "Origin": "chrome-extension://abcdefghijklmnop",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "chrome-extension://abcdefghijklmnop"


def test_health_describes_provider_and_collector(client: TestClient):
    payload = client.get("/health").json()
    assert payload["status"] == "ok"
    assert payload["provider"] == "mock"
    # A collector that has never reported is stalled, not merely "stale data".
    jobs = {job["job"] for job in payload["collector"]}
    assert {"market", "official"} <= jobs
    # One heartbeat per configured source, so a dead source cannot hide.
    assert {f"official:{name}" for name in get_settings().official_sources} <= jobs
    assert all(job["is_stalled"] for job in payload["collector"])


def test_history_timestamps_carry_an_explicit_utc_offset(client: TestClient):
    # Without the offset a browser parses the value as local time, which shifted
    # every chart label by the client's UTC offset (9 hours in Japan).
    history = client.get("/api/v1/rates/USD/JPY/history?days=7").json()
    assert history
    assert all(point["captured_at"].endswith(("Z", "+00:00")) for point in history)
    latest = client.get("/api/v1/rates/USD/JPY").json()
    assert history[-1]["captured_at"][:19] <= latest["captured_at"][:19]


def test_history_window_supports_long_ranges(client: TestClient):
    week = client.get("/api/v1/rates/USD/JPY/history?days=7").json()
    month = client.get("/api/v1/rates/USD/JPY/history?days=30").json()
    assert len(month) > len(week)
    assert client.get("/api/v1/rates/USD/JPY/history?days=0").status_code == 422
    assert client.get("/api/v1/rates/USD/JPY/history?days=91").status_code == 422


def test_unchanged_reads_are_answered_with_304(client: TestClient):
    first = client.get("/api/v1/pairs")
    assert first.headers["ETag"]
    assert "max-age" in first.headers["Cache-Control"]
    again = client.get("/api/v1/pairs", headers={"If-None-Match": first.headers["ETag"]})
    assert again.status_code == 304
    assert not again.content
