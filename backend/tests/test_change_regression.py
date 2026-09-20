from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.api import serialize_rate
from app.database import SessionLocal
from app.models import RateSnapshot


@pytest.mark.parametrize(
    "latest_age, previous_age, expected",
    [(48, 72, None), (1, 25, Decimal("16.6667")), (1, 60, None), (1, 26, Decimal("16.6667"))],
)
def test_change_uses_quote_time_and_rejects_stale_or_distant_baseline(
    latest_age, previous_age, expected,
):
    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        for age, value in [(previous_age, "6"), (latest_age, "7")]:
            row = RateSnapshot(
                base_currency="USD", quote_currency="CNY", provider="mock",
                midpoint=Decimal(value), bid=Decimal(value), ask=Decimal(value),
                captured_at=now - timedelta(hours=age),
            )
            db.add(row)
        db.commit()
        assert serialize_rate(db, row).change_percent == expected
