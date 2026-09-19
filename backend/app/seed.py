import math
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import RateSnapshot


def seed_demo_history(db: Session) -> None:
    if get_settings().fx_provider != "mock":
        return
    count = db.scalar(select(func.count()).select_from(RateSnapshot)) or 0
    if count:
        return
    centers = {"USD/CNY": 7.12, "USD/JPY": 148.4, "CNY/JPY": 20.84}
    now = datetime.now(timezone.utc)
    for pair, center in centers.items():
        base, quote = pair.split("/")
        for hours_ago in range(30 * 24, -1, -6):
            timestamp = now - timedelta(hours=hours_ago)
            trend = 0.006 * math.sin(hours_ago / 37 + sum(map(ord, pair)))
            mid = Decimal(str(center * (1 + trend))).quantize(Decimal("0.00000001"))
            spread = (mid * Decimal("0.00012")).quantize(Decimal("0.00000001"))
            db.add(
                RateSnapshot(
                    base_currency=base,
                    quote_currency=quote,
                    bid=mid - spread / 2,
                    ask=mid + spread / 2,
                    midpoint=mid,
                    provider="mock",
                    captured_at=timestamp,
                )
            )
    db.commit()
