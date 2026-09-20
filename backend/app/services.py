import asyncio
import logging
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import delete, desc, func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import SessionLocal
from app.models import OfficialRate, ProviderRequest, RateSnapshot
from app.official_providers import OfficialQuote, get_official_providers
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
    db.execute(delete(OfficialRate).where(
        OfficialRate.reference_date < (now - timedelta(days=get_settings().retention_days)).date()
    ))
    db.commit()


def store_quote(db: Session, quote: Quote) -> RateSnapshot:
    snapshot = RateSnapshot(**asdict(quote))
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)
    return snapshot


def store_official_quote(db: Session, quote: OfficialQuote) -> OfficialRate:
    existing = db.scalar(select(OfficialRate).where(
        OfficialRate.base_currency == quote.base_currency,
        OfficialRate.quote_currency == quote.quote_currency,
        OfficialRate.institution == quote.institution,
        OfficialRate.reference_date == quote.reference_date,
    ))
    if existing:
        for field, value in asdict(quote).items():
            setattr(existing, field, value)
        snapshot = existing
    else:
        snapshot = OfficialRate(**asdict(quote))
        db.add(snapshot)
    db.commit()
    db.refresh(snapshot)
    return snapshot


async def refresh_all_rates() -> dict[str, int]:
    provider = get_provider()
    refreshed = 0
    errors = 0
    with SessionLocal() as db:
        pairs = get_settings().tracked_pairs
        for index, pair in enumerate(pairs):
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
            if get_settings().fx_provider == "alpha_vantage" and index < len(pairs) - 1:
                # Free keys can be throttled when multiple pairs are requested back-to-back.
                await asyncio.sleep(get_settings().provider_request_spacing_seconds)
            else:
                await asyncio.sleep(0)
        prune_history(db)
    return {"refreshed": refreshed, "errors": errors}


async def refresh_official_rates() -> dict[str, int]:
    refreshed = 0
    errors = 0
    with SessionLocal() as db:
        for provider in get_official_providers():
            try:
                quotes = await provider.get_quotes(get_settings().tracked_pairs)
                for quote in quotes:
                    store_official_quote(db, quote)
                    refreshed += 1
            except Exception:
                db.rollback()
                logger.exception("Official-rate refresh failed for %s", provider.institution)
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


def latest_official_for_pair(db: Session, base: str, quote: str) -> list[OfficialRate]:
    observations = db.scalars(
        select(OfficialRate)
        .where(
            OfficialRate.base_currency == base,
            OfficialRate.quote_currency == quote,
        )
        .order_by(desc(OfficialRate.reference_date), desc(OfficialRate.fetched_at))
    ).all()
    latest_by_institution: dict[str, OfficialRate] = {}
    for observation in observations:
        latest_by_institution.setdefault(observation.institution, observation)
    return list(latest_by_institution.values())


def percentage_change(current: Decimal, previous: Decimal | None) -> Decimal | None:
    if not previous:
        return None
    return ((current - previous) / previous * 100).quantize(Decimal("0.0001"))
