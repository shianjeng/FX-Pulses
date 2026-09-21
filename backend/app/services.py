import asyncio
import logging
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import delete, desc, func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import SessionLocal
from app.models import CollectorRun, OfficialAnchorRate, ProviderRequest, RateSnapshot
from app.official_providers import (
    OfficialQuote,
    OfficialTable,
    get_official_providers,
    provider_name,
    raw_cross,
)
from app.providers import ProviderError, Quote, get_provider

logger = logging.getLogger(__name__)

MARKET_JOB = "market"
OFFICIAL_JOB = "official"


def official_job(name: str) -> str:
    """One heartbeat per source: with five of them, a single aggregate row hid a
    permanently broken source behind the ones that still worked."""
    return f"{OFFICIAL_JOB}:{name}"


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


def record_run(db: Session, job: str, *, ok: bool, error: str | None = None) -> None:
    now = datetime.now(timezone.utc)
    run = db.scalar(select(CollectorRun).where(CollectorRun.job == job))
    if run is None:
        run = CollectorRun(job=job, consecutive_failures=0)
        db.add(run)
    run.finished_at = now
    run.last_error = (error or None) and error[:300]
    if ok:
        run.last_success_at = now
        run.consecutive_failures = 0
    else:
        run.consecutive_failures = (run.consecutive_failures or 0) + 1
        run.last_error = (error or "unknown")[:300]
    db.commit()


def prune_history(db: Session) -> None:
    now = datetime.now(timezone.utc)
    db.execute(delete(RateSnapshot).where(
        RateSnapshot.captured_at < now - timedelta(days=get_settings().retention_days)
    ))
    db.execute(delete(ProviderRequest).where(
        ProviderRequest.attempted_at < now - timedelta(days=2)
    ))
    db.execute(delete(OfficialAnchorRate).where(
        OfficialAnchorRate.reference_date
        < (now - timedelta(days=get_settings().retention_days)).date()
    ))
    db.commit()


def store_quote(db: Session, quote: Quote) -> RateSnapshot:
    snapshot = RateSnapshot(**asdict(quote))
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)
    return snapshot


def store_official_table(db: Session, table: OfficialTable) -> int:
    """Upsert every currency of one published table for one reference date."""
    existing = {
        row.currency: row
        for row in db.scalars(
            select(OfficialAnchorRate).where(
                OfficialAnchorRate.institution == table.institution,
                OfficialAnchorRate.anchor_currency == table.anchor_currency,
                OfficialAnchorRate.reference_date == table.reference_date,
            )
        ).all()
    }
    for currency, value in table.values_per_anchor.items():
        row = existing.get(currency)
        if row is None:
            db.add(OfficialAnchorRate(
                institution=table.institution,
                anchor_currency=table.anchor_currency,
                currency=currency,
                units_per_anchor=value,
                rate_type=table.rate_type,
                reference_date=table.reference_date,
                fetched_at=table.fetched_at,
                source_url=table.source_url,
            ))
        else:
            row.units_per_anchor = value
            row.rate_type = table.rate_type
            row.fetched_at = table.fetched_at
            row.source_url = table.source_url
    db.commit()
    return len(table.values_per_anchor)


def latest_official_tables(db: Session) -> list[OfficialTable]:
    """Rebuild the most recent stored table for every institution."""
    newest = (
        select(
            OfficialAnchorRate.institution.label("institution"),
            OfficialAnchorRate.anchor_currency.label("anchor_currency"),
            func.max(OfficialAnchorRate.reference_date).label("reference_date"),
        )
        .group_by(OfficialAnchorRate.institution, OfficialAnchorRate.anchor_currency)
        .subquery()
    )
    rows = db.scalars(
        select(OfficialAnchorRate).join(
            newest,
            (OfficialAnchorRate.institution == newest.c.institution)
            & (OfficialAnchorRate.anchor_currency == newest.c.anchor_currency)
            & (OfficialAnchorRate.reference_date == newest.c.reference_date),
        )
    ).all()

    grouped: dict[tuple[str, str], list[OfficialAnchorRate]] = {}
    for row in rows:
        grouped.setdefault((row.institution, row.anchor_currency), []).append(row)

    tables: list[OfficialTable] = []
    for (institution, anchor), members in grouped.items():
        head = members[0]
        fetched_at = max(member.fetched_at for member in members)
        tables.append(OfficialTable(
            institution=institution,
            rate_type=head.rate_type,
            anchor_currency=anchor,
            reference_date=head.reference_date,
            fetched_at=fetched_at,
            source_url=head.source_url,
            values_per_anchor={
                member.currency: Decimal(member.units_per_anchor) for member in members
            },
        ))
    tables.sort(key=lambda table: table.institution)
    return tables


def official_currencies(db: Session) -> list[str]:
    return sorted({
        currency
        for table in latest_official_tables(db)
        for currency in table.values_per_anchor
    })


def latest_official_for_pair(db: Session, base: str, quote: str) -> list[OfficialQuote]:
    tables = latest_official_tables(db)
    output: list[OfficialQuote] = []
    for table in tables:
        output.extend(table.quotes([f"{base}/{quote}"]))
    if output:
        return output
    return triangulate_official(tables, base, quote)


def triangulate_official(
    tables: list[OfficialTable], base: str, quote: str,
) -> list[OfficialQuote]:
    """Combine two institutions through a shared currency.

    No single source covers every pair, so SEK/KRW can be unanswerable even when
    the ECB quotes SEK and the Federal Reserve quotes KRW. Each leg stays an
    official observation; the result is labelled with the bridging currency and
    carries the older of the two reference dates.
    """
    results: list[OfficialQuote] = []
    seen: set[tuple[str, str, str]] = set()
    for left in tables:
        if base not in left.values_per_anchor:
            continue
        for right in tables:
            if right is left or quote not in right.values_per_anchor:
                continue
            shared = sorted(
                set(left.values_per_anchor) & set(right.values_per_anchor)
                - {base, quote}
            )
            for via in shared:
                key = (left.institution, right.institution, via)
                if key in seen:
                    continue
                try:
                    # Rounding each leg first would compound into the result.
                    first = raw_cross(left.values_per_anchor, base, via)
                    second = raw_cross(right.values_per_anchor, via, quote)
                except ProviderError:
                    continue
                rate = (first * second).quantize(Decimal("0.00000001"))
                if not rate.is_finite() or rate <= 0:
                    continue
                seen.add(key)
                results.append(OfficialQuote(
                    base, quote, rate,
                    f"{left.institution} + {right.institution}",
                    left.rate_type,
                    min(left.reference_date, right.reference_date),
                    min(left.fetched_at, right.fetched_at),
                    left.source_url,
                    True,
                    via_currency=via,
                ))
                break  # One bridge per institution pair is enough.
    results.sort(key=lambda item: (-item.reference_date.toordinal(), item.institution))
    return results[:3]


async def refresh_all_rates() -> dict[str, int]:
    provider = get_provider()
    refreshed = 0
    errors = 0
    last_error: str | None = None
    with SessionLocal() as db:
        pairs = get_settings().tracked_pairs
        for index, pair in enumerate(pairs):
            try:
                if get_settings().fx_provider == "alpha_vantage" and not reserve_request(db):
                    logger.warning("Provider rolling 24-hour budget exhausted")
                    last_error = "provider budget exhausted"
                    errors += 1
                    break
                base, quote = pair.split("/", 1)
                store_quote(db, await provider.get_quote(base, quote))
                refreshed += 1
            except Exception as exc:
                db.rollback()
                logger.exception("Quote refresh failed for %s", pair)
                last_error = f"{pair}: {exc}"
                errors += 1
            if get_settings().fx_provider == "alpha_vantage" and index < len(pairs) - 1:
                # Free keys can be throttled when multiple pairs are requested back-to-back.
                await asyncio.sleep(get_settings().provider_request_spacing_seconds)
            else:
                await asyncio.sleep(0)
        prune_history(db)
        record_run(db, MARKET_JOB, ok=refreshed > 0, error=last_error)
    return {"refreshed": refreshed, "errors": errors}


async def refresh_official_rates() -> dict[str, int]:
    refreshed = 0
    errors = 0
    last_error: str | None = None
    with SessionLocal() as db:
        for provider in get_official_providers():
            name = provider_name(provider)
            try:
                table = await provider.get_table()
                refreshed += store_official_table(db, table)
                record_run(db, official_job(name), ok=True)
            except Exception as exc:
                db.rollback()
                logger.exception("Official-rate refresh failed for %s", provider.institution)
                last_error = f"{provider.institution}: {exc}"
                errors += 1
                record_run(db, official_job(name), ok=False, error=f"{provider.institution}: {exc}")
            await asyncio.sleep(0)
        prune_history(db)
        record_run(db, OFFICIAL_JOB, ok=refreshed > 0, error=last_error)
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
