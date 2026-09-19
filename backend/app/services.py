import asyncio
from decimal import Decimal

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import SessionLocal
from app.models import RateSnapshot
from app.providers import Quote, get_provider


def store_quote(db: Session, quote: Quote) -> RateSnapshot:
    snapshot = RateSnapshot(**quote.__dict__)
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)
    return snapshot


async def refresh_all_rates() -> dict[str, int]:
    provider = get_provider()
    refreshed = 0
    errors = 0
    with SessionLocal() as db:
        for pair in get_settings().tracked_pairs:
            try:
                base, quote = pair.split("/", 1)
                store_quote(db, await provider.get_quote(base, quote))
                refreshed += 1
            except Exception:
                errors += 1
            await asyncio.sleep(0)
    return {"refreshed": refreshed, "errors": errors}


def latest_for_pair(db: Session, base: str, quote: str) -> RateSnapshot | None:
    return db.scalar(
        select(RateSnapshot)
        .where(RateSnapshot.base_currency == base, RateSnapshot.quote_currency == quote)
        .order_by(desc(RateSnapshot.captured_at))
        .limit(1)
    )


def percentage_change(current: Decimal, previous: Decimal | None) -> Decimal | None:
    if not previous:
        return None
    return ((current - previous) / previous * 100).quantize(Decimal("0.0001"))
