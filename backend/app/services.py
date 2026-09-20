import asyncio
import logging
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import delete, desc, func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import SessionLocal
from app.models import ProviderRequest, RateSnapshot
from app.providers import Quote, get_provider

logger = logging.getLogger(__name__)


def reserve_request(db: Session) -> bool:
    since = datetime.now(timezone.utc) - timedelta(days=1)
    count = db.scalar(select(func.count()).select_from(ProviderRequest).where(
        ProviderRequest.attempted_at > since
    ))
    if count >= get_settings().provider_daily_budget:
        return False
    db.add(ProviderRequest())
    db.commit()  # Count failed requests and survive collector restarts.
    return True


def prune_history(db: Session) -> None:
    now = datetime.now(timezone.utc)
    db.execute(delete(RateSnapshot).where(
        RateSnapshot.captured_at < now - timedelta(days=get_settings().retention_days)
    ))
    db.execute(delete(ProviderRequest).where(
        ProviderRequest.attempted_at < now - timedelta(days=2)
    ))
    db.commit()


def store_quote(db: Session, quote: Quote) -> RateSnapshot:
    snapshot = RateSnapshot(**asdict(quote))
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
                if get_settings().fx_provider == "alpha_vantage" and not reserve_request(db):
                    logger.warning("Provider rolling 24-hour budget exhausted")
                    break
                base, quote = pair.split("/", 1)
                store_quote(db, await provider.get_quote(base, quote))
                refreshed += 1
            except Exception:
                db.rollback()
                logger.exception("Quote refresh failed for %s", pair)
                errors += 1
            await asyncio.sleep(0)
        prune_history(db)
    return {"refreshed": refreshed, "errors": errors}


def latest_for_pair(db: Session, base: str, quote: str) -> RateSnapshot | None:
    return db.scalar(
        select(RateSnapshot)
        .where(
            RateSnapshot.base_currency == base, RateSnapshot.quote_currency == quote,
            RateSnapshot.provider == get_settings().fx_provider,
        )
        .order_by(desc(RateSnapshot.captured_at))
        .limit(1)
    )


def percentage_change(current: Decimal, previous: Decimal | None) -> Decimal | None:
    if not previous:
        return None
    return ((current - previous) / previous * 100).quantize(Decimal("0.0001"))
