from decimal import Decimal

from fastapi.testclient import TestClient


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


def test_health_describes_provider(client: TestClient):
    assert client.get("/health").json() == {"status": "ok", "provider": "mock"}
