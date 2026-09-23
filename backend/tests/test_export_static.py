"""The static export must answer exactly what the live API answers.

Two independent code paths now serve the same data, so the risk is drift: a
change to a serializer or to the cross-rate logic that reaches one and not the
other would ship an extension quietly showing different numbers depending on
which backend it points at. These tests compare the two outputs directly.
"""
import json
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.database import SessionLocal
from app.export_static import main
from app.official_providers import OfficialTable
from app.services import store_official_table


@pytest.fixture
def official(client: TestClient) -> TestClient:
    """Two institutions, so the export also covers triangulated cross-rates."""
    tables = [
        OfficialTable(
            institution="Test Central Bank", rate_type="Reference rate",
            anchor_currency="EUR", reference_date=date(2026, 9, 18),
            fetched_at=datetime.now(timezone.utc), source_url="https://example.test/eur",
            values_per_anchor={
                "EUR": Decimal("1"), "USD": Decimal("1.2"),
                "CNY": Decimal("8.4"), "JPY": Decimal("180"),
            },
        ),
        OfficialTable(
            institution="Other Central Bank", rate_type="Daily average",
            anchor_currency="CAD", reference_date=date(2026, 9, 18),
            fetched_at=datetime.now(timezone.utc), source_url="https://example.test/cad",
            values_per_anchor={
                "CAD": Decimal("1"), "USD": Decimal("1.4"),
                "SEK": Decimal("0.13"), "JPY": Decimal("0.0089"),
            },
        ),
    ]
    with SessionLocal() as db:
        for table in tables:
            store_official_table(db, table)
    return client


def export(tmp_path, monkeypatch):
    monkeypatch.setattr("sys.argv", ["export_static", "--out", str(tmp_path)])
    main()
    return lambda name: json.loads((tmp_path / name).read_text())


def strip_clock(value):
    """`is_stale` is computed against the request clock; the client recomputes
    it from meta.json, so the file's copy is not part of the contract."""
    if isinstance(value, dict):
        return {k: strip_clock(v) for k, v in value.items() if k != "is_stale"}
    if isinstance(value, list):
        return [strip_clock(v) for v in value]
    return value


def test_collection_endpoints_match_the_api(client: TestClient, tmp_path, monkeypatch):
    read = export(tmp_path, monkeypatch)
    for path, name in [
        ("/api/v1/pairs", "pairs.json"),
        ("/api/v1/rates", "rates.json"),
        ("/api/v1/currencies", "currencies.json"),
        ("/api/v1/official-rates", "official-rates.json"),
    ]:
        assert strip_clock(client.get(path).json()) == strip_clock(read(name)), path


def test_history_file_holds_the_full_window(client: TestClient, tmp_path, monkeypatch):
    read = export(tmp_path, monkeypatch)
    # One file per pair covers 90 days; the client slices it to 1/7/30/90.
    full = read("rates/USD/CNY/history.json")
    assert full == client.get("/api/v1/rates/USD/CNY/history?days=90").json()
    week = client.get("/api/v1/rates/USD/CNY/history?days=7").json()
    assert len(week) <= len(full)
    assert all(point in full for point in week)


def test_meta_exports_thresholds_not_verdicts(client: TestClient, tmp_path, monkeypatch):
    read = export(tmp_path, monkeypatch)
    meta = read("meta.json")
    assert meta["stale_after_minutes"] > 0
    assert meta["collector"], "meta.json must list the collector jobs"
    for job in meta["collector"]:
        # A frozen verdict would keep reading healthy while the CDN served the
        # file, so the threshold travels instead and the client decides.
        assert "is_stalled" not in job
        assert job["stall_after_minutes"] > 0


def test_every_exported_pair_matches_the_api(official: TestClient, tmp_path, monkeypatch):
    client = official
    read = export(tmp_path, monkeypatch)
    currencies = read("currencies.json")["official_currencies"]
    assert currencies, "the fixture should publish official coverage"
    checked = 0
    for base in currencies:
        for quote in currencies:
            if base == quote:
                continue
            path = tmp_path / "official-rates" / base / f"{quote}.json"
            response = client.get(f"/api/v1/official-rates/{base}/{quote}")
            if not path.exists():
                # Absent file and 404 must agree: a pair no source covers.
                assert response.status_code == 404, f"{base}/{quote} exists in the API only"
                continue
            assert response.status_code == 200, f"{base}/{quote} exported but 404 from the API"
            assert strip_clock(response.json()) == strip_clock(json.loads(path.read_text()))
            checked += 1
    assert checked, "no pair was compared"
