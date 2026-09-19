from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.models import RateSnapshot
from app.schemas import HistoryPoint, RateOut
from app.services import latest_for_pair, percentage_change

router = APIRouter()


def serialize_rate(db: Session, latest: RateSnapshot) -> RateOut:
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    previous = db.scalar(
        select(RateSnapshot.midpoint)
        .where(
            RateSnapshot.base_currency == latest.base_currency,
            RateSnapshot.quote_currency == latest.quote_currency,
            RateSnapshot.captured_at <= since,
        )
        .order_by(desc(RateSnapshot.captured_at))
        .limit(1)
    )
    result = RateOut.model_validate(latest)
    result.change_percent = percentage_change(latest.midpoint, previous)
    result.spread = latest.ask - latest.bid
    captured_at = latest.captured_at
    if captured_at.tzinfo is None:
        captured_at = captured_at.replace(tzinfo=timezone.utc)
    result.is_stale = captured_at < datetime.now(timezone.utc) - timedelta(
        minutes=get_settings().stale_after_minutes
    )
    return result


@router.get("/pairs", response_model=list[str])
def pairs() -> list[str]:
    return get_settings().tracked_pairs


@router.get("/rates", response_model=list[RateOut])
def rates(db: Session = Depends(get_db)) -> list[RateOut]:
    output: list[RateOut] = []
    for pair in get_settings().tracked_pairs:
        base, quote = pair.split("/", 1)
        latest = latest_for_pair(db, base, quote)
        if latest:
            output.append(serialize_rate(db, latest))
    return output


@router.get("/rates/{base}/{quote}", response_model=RateOut)
def rate(base: str, quote: str, db: Session = Depends(get_db)) -> RateOut:
    base, quote = base.upper(), quote.upper()
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
) -> list[RateSnapshot]:
    base, quote = base.upper(), quote.upper()
    if f"{base}/{quote}" not in get_settings().tracked_pairs:
        raise HTTPException(status_code=404, detail="Currency pair is not tracked")
    start = datetime.now(timezone.utc) - timedelta(days=days)
    return list(
        db.scalars(
            select(RateSnapshot)
            .where(
                RateSnapshot.base_currency == base,
                RateSnapshot.quote_currency == quote,
                RateSnapshot.captured_at >= start,
            )
            .order_by(RateSnapshot.captured_at)
        ).all()
    )
