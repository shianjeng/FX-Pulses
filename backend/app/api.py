import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.models import RateSnapshot
from app.official_providers import OfficialQuote
from app.schemas import (
    CoverageOut,
    HistoryPoint,
    OfficialRateOut,
    RateComparisonOut,
    RateOut,
)
from app.services import (
    latest_for_pair,
    latest_official_for_pair,
    official_currencies,
    percentage_change,
)

router = APIRouter()
CURRENCY = re.compile(r"[A-Z]{3}")


def aware(value: datetime) -> datetime:
    """SQLite returns naive datetimes; a JSON timestamp without an offset is
    parsed as *local* time by browsers, which shifted the chart by the client's
    UTC offset. Every timestamp leaves the API explicitly UTC."""
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def parse_pair(base: str, quote: str) -> tuple[str, str]:
    base, quote = base.upper(), quote.upper()
    if not CURRENCY.fullmatch(base) or not CURRENCY.fullmatch(quote) or base == quote:
        raise HTTPException(status_code=404, detail="Currency pair is not valid")
    return base, quote


def serialize_rate(db: Session, latest: RateSnapshot) -> RateOut:
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    previous = db.scalar(
        select(RateSnapshot.midpoint)
        .where(
            RateSnapshot.base_currency == latest.base_currency,
            RateSnapshot.quote_currency == latest.quote_currency,
            RateSnapshot.captured_at <= since,
            RateSnapshot.provider == latest.provider,
        )
        .order_by(desc(RateSnapshot.captured_at))
        .limit(1)
    )
    result = RateOut.model_validate(latest)
    result.change_percent = percentage_change(latest.midpoint, previous)
    result.spread = latest.ask - latest.bid
    captured_at = aware(latest.captured_at)
    result.is_stale = captured_at < datetime.now(timezone.utc) - timedelta(
        minutes=get_settings().stale_after_minutes
    )
    result.captured_at = captured_at
    return result


def serialize_official(
    observation: OfficialQuote, market: RateSnapshot | None = None,
) -> OfficialRateOut:
    result = OfficialRateOut.model_validate(observation)
    if market:
        result.market_deviation_percent = percentage_change(market.midpoint, observation.rate)
    result.fetched_at = aware(observation.fetched_at)
    return result


@router.get("/pairs", response_model=list[str])
def pairs() -> list[str]:
    return get_settings().tracked_pairs


@router.get("/currencies", response_model=CoverageOut)
def currencies(db: Session = Depends(get_db)) -> CoverageOut:
    """What the extension may offer: live pairs, plus official-only currencies."""
    return CoverageOut(
        market_pairs=get_settings().tracked_pairs,
        official_currencies=official_currencies(db),
    )


@router.get("/rates", response_model=list[RateOut])
def rates(db: Session = Depends(get_db)) -> list[RateOut]:
    output: list[RateOut] = []
    for pair in get_settings().tracked_pairs:
        base, quote = pair.split("/", 1)
        latest = latest_for_pair(db, base, quote)
        if latest:
            output.append(serialize_rate(db, latest))
    return output


@router.get("/official-rates", response_model=list[OfficialRateOut])
def official_rates(db: Session = Depends(get_db)) -> list[OfficialRateOut]:
    output: list[OfficialRateOut] = []
    for pair in get_settings().tracked_pairs:
        base, quote = pair.split("/", 1)
        output.extend(
            serialize_official(item) for item in latest_official_for_pair(db, base, quote)
        )
    return output


@router.get("/official-rates/{base}/{quote}", response_model=list[OfficialRateOut])
def official_rate(base: str, quote: str, db: Session = Depends(get_db)) -> list[OfficialRateOut]:
    # Not limited to TRACKED_PAIRS: every currency an institution publishes can be
    # crossed, which is what lets hover convert currencies the market feed lacks.
    base, quote = parse_pair(base, quote)
    observations = latest_official_for_pair(db, base, quote)
    if not observations:
        raise HTTPException(status_code=404, detail="No official source covers this pair")
    return [serialize_official(item) for item in observations]


@router.get("/comparisons/{base}/{quote}", response_model=RateComparisonOut)
def comparison(base: str, quote: str, db: Session = Depends(get_db)) -> RateComparisonOut:
    base, quote = parse_pair(base, quote)
    market = latest_for_pair(db, base, quote)
    observations = latest_official_for_pair(db, base, quote)
    tracked = f"{base}/{quote}" in get_settings().tracked_pairs
    if market is None and not observations and not tracked:
        raise HTTPException(status_code=404, detail="Currency pair is not tracked")
    return RateComparisonOut(
        base_currency=base,
        quote_currency=quote,
        market=serialize_rate(db, market) if market else None,
        official=[serialize_official(item, market) for item in observations],
    )


@router.get("/rates/{base}/{quote}", response_model=RateOut)
def rate(base: str, quote: str, db: Session = Depends(get_db)) -> RateOut:
    base, quote = parse_pair(base, quote)
    if f"{base}/{quote}" not in get_settings().tracked_pairs:
        raise HTTPException(status_code=404, detail="Currency pair is not tracked")
    latest = latest_for_pair(db, base, quote)
    if not latest:
        raise HTTPException(status_code=503, detail="Quote is not available yet")
    return serialize_rate(db, latest)


@router.get("/rates/{base}/{quote}/history", response_model=list[HistoryPoint])
def history(
    base: str,
    quote: str,
    days: int = Query(default=7, ge=1, le=90),
    db: Session = Depends(get_db),
) -> list[HistoryPoint]:
    base, quote = parse_pair(base, quote)
    if f"{base}/{quote}" not in get_settings().tracked_pairs:
        raise HTTPException(status_code=404, detail="Currency pair is not tracked")
    start = datetime.now(timezone.utc) - timedelta(days=days)
    rows = db.scalars(
        select(RateSnapshot)
        .where(
            RateSnapshot.base_currency == base,
            RateSnapshot.quote_currency == quote,
            RateSnapshot.captured_at >= start,
            RateSnapshot.provider == get_settings().fx_provider,
        )
        .order_by(RateSnapshot.captured_at)
    ).all()
    return [
        HistoryPoint(
            captured_at=aware(row.captured_at),
            midpoint=row.midpoint,
            bid=row.bid,
            ask=row.ask,
        )
        for row in rows
    ]
