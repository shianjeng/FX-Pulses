"""Long-range chart history from the ECB's reference history file.

The collector began in late September 2026, so a one-month or three-month
chart had a week of points and looked the same as the seven-day one. The ECB
publishes every day of reference rates since 1999 in one file; its last year
is read once into the same table the daily fetch fills, kept for a year, and
exported as one small column-per-currency file that the client divides for
any cross.
"""
import json
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import AsyncMock

import pytest

from app.database import SessionLocal
from app.models import OfficialAnchorRate
from app.official_providers import EcbReferenceProvider, OfficialTable
from app.services import (
    backfill_reference_history,
    prune_history,
    reference_history,
    refresh_official_rates,
    store_official_table,
)

HISTORY = b"""<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01"
  xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
<Cube>
  <Cube time="2026-09-29"><Cube currency="USD" rate="1.1355"/><Cube currency="JPY" rate="178.41"/>
    <Cube currency="CNY" rate="7.6211"/></Cube>
  <Cube time="2026-09-26"><Cube currency="USD" rate="1.1340"/><Cube currency="JPY" rate="178.10"/>
    <Cube currency="CNY" rate="7.6120"/></Cube>
  <Cube time="2026-09-25"><Cube currency="USD" rate="1.1301"/>
    <Cube currency="JPY" rate="179.02"/></Cube>
</Cube></gesmes:Envelope>"""


def ecb_table(day: date, usd: str = "1.13", source: str = "daily") -> OfficialTable:
    return OfficialTable(
        institution="European Central Bank", rate_type="Euro foreign exchange reference rate",
        anchor_currency="EUR", reference_date=day, fetched_at=datetime.now(timezone.utc),
        source_url=f"https://example.test/{source}",
        values_per_anchor={"EUR": Decimal("1"), "USD": Decimal(usd), "JPY": Decimal("178")},
    )


def business_days(count: int) -> list[date]:
    today = datetime.now(timezone.utc).date()
    days = []
    day = today
    while len(days) < count:
        if day.weekday() < 5:
            days.append(day)
        day -= timedelta(days=1)
    return sorted(days)


def test_the_history_file_parses_into_one_table_per_date_oldest_first():
    tables = EcbReferenceProvider().parse_history(HISTORY)
    assert [table.reference_date for table in tables] == [
        date(2026, 9, 25), date(2026, 9, 26), date(2026, 9, 29)]
    assert tables[-1].values_per_anchor["JPY"] == Decimal("178.41")
    assert tables[-1].values_per_anchor["EUR"] == Decimal("1")
    # A currency missing on one day is simply absent from that day's table.
    assert "CNY" not in tables[0].values_per_anchor
    assert tables[0].source_url.endswith("eurofxref-hist.xml")


def test_only_the_dates_asked_for_are_built():
    # The file goes back to 1999; only the last year is wanted.
    tables = EcbReferenceProvider().parse_history(HISTORY, since=date(2026, 9, 26))
    assert [table.reference_date for table in tables] == [date(2026, 9, 26), date(2026, 9, 29)]


@pytest.mark.asyncio
async def test_backfill_runs_once_and_keeps_the_daily_rows_it_finds():
    days = business_days(210)
    provider = AsyncMock()
    provider.institution = "European Central Bank"
    provider.get_history.return_value = [ecb_table(day, source="history") for day in days]
    with SessionLocal() as db:
        store_official_table(db, ecb_table(days[-1], usd="1.2", source="daily"))
        assert await backfill_reference_history(db, provider) == 209
        # The latest date came from the daily table and stays as it was.
        latest = reference_history(db)
        assert latest["rates"]["USD"][-1] == 1.2
        assert len(latest["dates"]) == 210
        # With 210 dates stored the file is not fetched again.
        assert await backfill_reference_history(db, provider) == 0
    assert provider.get_history.await_count == 1


def test_reference_history_is_one_column_per_currency(client):
    with SessionLocal() as db:
        for table in EcbReferenceProvider().parse_history(HISTORY):
            # Keep the fixture inside the one-year window whatever today is.
            shift = datetime.now(timezone.utc).date() - date(2026, 9, 29)
            store_official_table(db, replace(table, reference_date=table.reference_date + shift))
        other = ecb_table(datetime.now(timezone.utc).date())
        store_official_table(db, replace(other, institution="Other Bank"))
    body = client.get("/api/v1/reference-history").json()
    assert body["institution"] == "European Central Bank"
    assert body["anchor_currency"] == "EUR"
    assert len(body["dates"]) == 3 and body["dates"] == sorted(body["dates"])
    assert body["rates"]["JPY"] == [179.02, 178.1, 178.41]
    assert body["rates"]["CNY"] == [None, 7.612, 7.6211]
    assert "EUR" not in body["rates"]


def test_the_static_export_writes_the_same_history(client, tmp_path, monkeypatch):
    with SessionLocal() as db:
        store_official_table(db, ecb_table(datetime.now(timezone.utc).date()))
    from app.export_static import main
    monkeypatch.setattr("sys.argv", ["export_static", "--out", str(tmp_path)])
    main()
    exported = json.loads((tmp_path / "reference-history.json").read_text())
    assert exported == client.get("/api/v1/reference-history").json()


@pytest.mark.asyncio
async def test_a_failed_history_download_does_not_fail_the_round(monkeypatch, caplog):
    provider = AsyncMock()
    provider.institution = "European Central Bank"
    provider.get_table.return_value = ecb_table(datetime.now(timezone.utc).date())
    provider.get_history.side_effect = RuntimeError("offline")
    monkeypatch.setattr("app.services.get_official_providers", lambda: [provider])
    monkeypatch.setattr("app.services.provider_name", lambda provider: "ecb")
    result = await refresh_official_rates()
    assert result == {"refreshed": 3, "errors": 0}
    assert "History backfill failed" in caplog.text


def test_the_ecb_tables_are_kept_for_a_year_and_the_others_for_the_retention():
    today = datetime.now(timezone.utc).date()
    old = today - timedelta(days=200)
    with SessionLocal() as db:
        store_official_table(db, ecb_table(old))
        store_official_table(db, replace(ecb_table(old), institution="Bank of Canada"))
        store_official_table(db, ecb_table(today - timedelta(days=400)))
        prune_history(db)
        left = {(row.institution, row.reference_date) for row in db.query(OfficialAnchorRate)}
    assert left == {("European Central Bank", old)}
