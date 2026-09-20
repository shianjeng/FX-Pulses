from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.official_providers import (
    BankOfCanadaProvider,
    EcbReferenceProvider,
    OfficialQuote,
)
from app.providers import ProviderError
from app.services import store_official_quote


def test_ecb_normalizes_cross_rates():
    payload = b"""<?xml version="1.0" encoding="UTF-8"?>
    <Envelope><Cube><Cube time="2026-09-18">
      <Cube currency="USD" rate="1.2"/>
      <Cube currency="CNY" rate="8.4"/>
      <Cube currency="JPY" rate="180"/>
    </Cube></Cube></Envelope>"""
    quotes = EcbReferenceProvider().parse(payload, ["USD/CNY", "USD/JPY"])
    assert quotes[0].rate == Decimal("7.00000000")
    assert quotes[1].rate == Decimal("150.00000000")
    assert quotes[0].is_derived is True


def test_bank_of_canada_normalizes_cross_rates():
    payload = {"observations": [{
        "d": "2026-09-18",
        "FXUSDCAD": {"v": "1.4002"},
        "FXCNYCAD": {"v": "0.2091"},
        "FXJPYCAD": {"v": "0.008910"},
    }]}
    quotes = BankOfCanadaProvider().parse(payload, ["USD/CNY", "USD/JPY"])
    assert quotes[0].rate == Decimal("6.69631755")
    assert quotes[1].rate == Decimal("157.14927048")


def test_malformed_official_payload_is_rejected():
    with pytest.raises(ProviderError):
        EcbReferenceProvider().parse(b"<not-rates />", ["USD/CNY"])


def test_official_rate_upsert_and_comparison(client: TestClient):
    quote = OfficialQuote(
        "USD", "CNY", Decimal("7.00000000"), "Test Central Bank",
        "Reference rate", date(2026, 9, 18), datetime.now(timezone.utc),
        "https://example.test/rates", False,
    )
    with SessionLocal() as db:
        store_official_quote(db, quote)
        store_official_quote(db, quote)

    official = client.get("/api/v1/official-rates/USD/CNY")
    assert official.status_code == 200
    assert len(official.json()) == 1
    assert official.json()[0]["rate"] == "7.00000000"

    comparison = client.get("/api/v1/comparisons/USD/CNY")
    assert comparison.status_code == 200
    payload = comparison.json()
    assert payload["market"]["provider"] == "mock"
    assert payload["official"][0]["market_deviation_percent"] is not None
