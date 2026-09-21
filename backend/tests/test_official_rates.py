from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.database import SessionLocal
from app.official_providers import (
    BankOfCanadaProvider,
    EcbReferenceProvider,
    OfficialTable,
)
from app.providers import ProviderError
from app.services import store_official_table

ECB_PAYLOAD = b"""<?xml version="1.0" encoding="UTF-8"?>
<Envelope><Cube><Cube time="2026-09-18">
  <Cube currency="USD" rate="1.2"/>
  <Cube currency="CNY" rate="8.4"/>
  <Cube currency="JPY" rate="180"/>
  <Cube currency="GBP" rate="0.85"/>
  <Cube currency="BAD" rate="0"/>
</Cube></Cube></Envelope>"""

BOC_PAYLOAD = {"observations": [{
    "d": "2026-09-18",
    "FXUSDCAD": {"v": "1.4002"},
    "FXCNYCAD": {"v": "0.2091"},
    "FXJPYCAD": {"v": "0.008910"},
    "FXEURCAD": {"v": "1.5"},
}]}


def test_ecb_normalizes_cross_rates():
    table = EcbReferenceProvider().parse(ECB_PAYLOAD)
    quotes = table.quotes(["USD/CNY", "USD/JPY"])
    assert quotes[0].rate == Decimal("7.00000000")
    assert quotes[1].rate == Decimal("150.00000000")
    assert quotes[0].is_derived is True
    assert table.quote("EUR", "USD").is_derived is False


def test_ecb_keeps_every_published_currency():
    table = EcbReferenceProvider().parse(ECB_PAYLOAD)
    assert table.currencies == ["CNY", "EUR", "GBP", "JPY", "USD"]  # zero rate dropped
    assert table.quote("GBP", "JPY").rate == Decimal("211.76470588")


def test_bank_of_canada_normalizes_cross_rates():
    table = BankOfCanadaProvider().parse(BOC_PAYLOAD)
    quotes = table.quotes(["USD/CNY", "USD/JPY"])
    assert quotes[0].rate == Decimal("6.69631755")
    assert quotes[1].rate == Decimal("157.14927048")
    assert "EUR" in table.values_per_anchor


def test_one_uncovered_pair_does_not_discard_the_table():
    table = EcbReferenceProvider().parse(ECB_PAYLOAD)
    quotes = table.quotes(["USD/CNY", "XXX/CNY", "USD/JPY"])
    assert [f"{q.base_currency}/{q.quote_currency}" for q in quotes] == ["USD/CNY", "USD/JPY"]


def test_malformed_official_payload_is_rejected():
    with pytest.raises(ProviderError):
        EcbReferenceProvider().parse(b"<not-rates />")
    with pytest.raises(ProviderError):
        BankOfCanadaProvider().parse({"observations": []})


def test_official_xml_entity_expansion_is_refused():
    bomb = b"""<?xml version="1.0"?>
    <!DOCTYPE Envelope [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]>
    <Envelope><Cube><Cube time="2026-09-18"><Cube currency="USD" rate="&b;"/>
    </Cube></Cube></Envelope>"""
    with pytest.raises(ProviderError):
        EcbReferenceProvider().parse(bomb)


def test_official_table_upsert_and_comparison(client: TestClient):
    table = OfficialTable(
        institution="Test Central Bank",
        rate_type="Reference rate",
        anchor_currency="EUR",
        reference_date=date(2026, 9, 18),
        fetched_at=datetime.now(timezone.utc),
        source_url="https://example.test/rates",
        values_per_anchor={
            "EUR": Decimal("1"), "USD": Decimal("1.2"),
            "CNY": Decimal("8.4"), "SEK": Decimal("11"),
        },
    )
    with SessionLocal() as db:
        assert store_official_table(db, table) == 4
        store_official_table(db, table)  # idempotent for the same reference date

    official = client.get("/api/v1/official-rates/USD/CNY")
    assert official.status_code == 200
    assert len(official.json()) == 1
    assert official.json()[0]["rate"] == "7.00000000"

    comparison = client.get("/api/v1/comparisons/USD/CNY")
    assert comparison.status_code == 200
    payload = comparison.json()
    assert payload["market"]["provider"] == "mock"
    assert payload["official"][0]["market_deviation_percent"] is not None


def test_untracked_pair_still_gets_an_official_cross_rate(client: TestClient):
    table = OfficialTable(
        institution="Test Central Bank", rate_type="Reference rate", anchor_currency="EUR",
        reference_date=date(2026, 9, 18), fetched_at=datetime.now(timezone.utc),
        source_url="https://example.test/rates",
        values_per_anchor={"EUR": Decimal("1"), "SEK": Decimal("11"), "CNY": Decimal("8.4")},
    )
    with SessionLocal() as db:
        store_official_table(db, table)

    response = client.get("/api/v1/official-rates/SEK/CNY")
    assert response.status_code == 200
    assert response.json()[0]["rate"] == "0.76363636"
    assert response.json()[0]["is_derived"] is True

    assert client.get("/api/v1/official-rates/SEK/XXX").status_code == 404
    coverage = client.get("/api/v1/currencies").json()
    assert coverage["official_currencies"] == ["CNY", "EUR", "SEK"]
    assert coverage["market_pairs"] == ["USD/CNY", "USD/JPY", "CNY/JPY"]


PBOC_PAYLOAD = {
    "data": {"lastDate": "2026-09-18"},
    "records": [
        {"vrtEName": "USD/CNY", "price": "7.1234"},
        {"vrtEName": "EUR/CNY", "price": "8.4000"},
        {"vrtEName": "JPY/CNY", "price": "4.8000"},      # published per 100 JPY
        {"vrtEName": "KRW/CNY", "price": "0.5200"},      # published per 100 KRW
        {"vrtEName": "USD/HKD", "price": "7.8"},         # not a CNY pair: ignored
        {"vrtEName": "GBP/CNY", "price": "0"},           # unusable: ignored
        {"vrtEName": "AUD/CNY"},                         # no price: ignored
        "junk",
    ],
}


def test_pboc_scales_the_per_hundred_quotations():
    from app.official_providers import PbocProvider
    table = PbocProvider().parse(PBOC_PAYLOAD)
    assert table.reference_date == date(2026, 9, 18)
    assert table.currencies == ["CNY", "EUR", "JPY", "KRW", "USD"]
    # 1 USD = 7.1234 CNY, and 100 JPY = 4.80 CNY, so USD/JPY is 7.1234 / 0.048.
    assert table.quote("USD", "CNY").rate == Decimal("7.12340000")
    assert table.quote("USD", "JPY").rate == Decimal("148.40416667")
    assert table.quote("CNY", "JPY").rate == Decimal("20.83333333")
    assert table.quote("USD", "CNY").is_derived is False


def test_pboc_rejects_a_changed_layout_instead_of_inventing_rates():
    from app.official_providers import PbocProvider
    with pytest.raises(ProviderError):
        PbocProvider().parse({"records": [{"vrtEName": "USD/CNY", "price": "7.1"}]})
    with pytest.raises(ProviderError):
        PbocProvider().parse({"data": {"lastDate": "2026-09-18"}, "records": []})
    with pytest.raises(ProviderError):
        PbocProvider().parse({"records": "not-a-list"})


def test_official_sources_are_configurable_and_validated():
    from app.config import Settings
    from app.official_providers import PbocProvider, get_official_providers
    settings = Settings(official_sources="ecb,pboc,ecb", _env_file=None)
    assert settings.official_sources == ["ecb", "pboc"]
    assert isinstance(get_official_providers(settings.official_sources)[1], PbocProvider)
    with pytest.raises(ValidationError):
        Settings(official_sources="ecb,boj", _env_file=None)
