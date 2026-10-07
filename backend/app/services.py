import asyncio
import logging
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import delete, desc, func, or_, select
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
from app.providers import ProviderError, Quote, TransientProviderError, get_provider

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
    # Plain SQL deletes. Syncing the session would compare the aware cutoff with
    # the naive datetimes SQLite returns for rows already loaded, and raise.
    bulk = {"synchronize_session": False}
    db.execute(delete(RateSnapshot).where(
        RateSnapshot.captured_at < now - timedelta(days=get_settings().retention_days)
    ).execution_options(**bulk))
    db.execute(delete(ProviderRequest).where(
        ProviderRequest.attempted_at < now - timedelta(days=2)
    ).execution_options(**bulk))
    # The ECB's tables draw the one-year chart, so they are kept for a year.
    keep = max(get_settings().retention_days, REFERENCE_DAYS + 7)
    db.execute(delete(OfficialAnchorRate).where(
        OfficialAnchorRate.reference_date
        < (now - timedelta(days=get_settings().retention_days)).date(),
        or_(
            OfficialAnchorRate.institution != REFERENCE_INSTITUTION,
            OfficialAnchorRate.reference_date < (now - timedelta(days=keep)).date(),
        ),
    ).execution_options(**bulk))
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


# Charts need months of history; the collector started in late September 2026.
REFERENCE_INSTITUTION = "European Central Bank"
REFERENCE_DAYS = 365
# The ECB publishes on about 255 days a year. Fewer stored than this means the
# history was never read, or was lost, rather than a run of holidays.
REFERENCE_MIN_DATES = 200
REFERENCE_SOURCE = "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html"


async def backfill_reference_history(db: Session, provider) -> int:
    """Fill the chart history from the ECB's history file, once.

    A database holding fewer than 200 of the ECB's dates from the last year
    gets the missing ones; after that the daily table keeps it current, so the
    file is not fetched again. Dates already stored are left as they are.
    """
    since = (datetime.now(timezone.utc) - timedelta(days=REFERENCE_DAYS)).date()
    stored = set(db.scalars(
        select(OfficialAnchorRate.reference_date).distinct().where(
            OfficialAnchorRate.institution == provider.institution,
            OfficialAnchorRate.reference_date >= since,
        )
    ).all())
    if len(stored) >= REFERENCE_MIN_DATES:
        return 0
    added = 0
    for table in await provider.get_history(since):
        if table.reference_date >= since and table.reference_date not in stored:
            store_official_table(db, table)
            added += 1
    return added


async def backfill_quietly(db: Session, provider) -> None:
    """A chart without months of history is no reason to fail the round."""
    try:
        added = await backfill_reference_history(db, provider)
    except Exception:
        db.rollback()
        logger.warning("History backfill failed for %s", provider.institution, exc_info=True)
        return
    if added:
        logger.info("Backfilled %s days of %s history", added, provider.institution)


def reference_history(db: Session, days: int = REFERENCE_DAYS) -> dict:
    """The ECB's daily reference rates, one column per currency against EUR.

    One small file answers a long-range chart for every pair the ECB covers;
    the client divides two columns for a cross, the same arithmetic as
    OfficialTable.quote, so no second triangulation lives in JavaScript.
    """
    since = (datetime.now(timezone.utc) - timedelta(days=days)).date()
    rows = db.scalars(
        select(OfficialAnchorRate).where(
            OfficialAnchorRate.institution == REFERENCE_INSTITUTION,
            OfficialAnchorRate.anchor_currency == "EUR",
            OfficialAnchorRate.reference_date >= since,
        )
    ).all()
    dates = sorted({row.reference_date for row in rows})
    column = {day: index for index, day in enumerate(dates)}
    currencies = sorted({row.currency for row in rows} - {"EUR"})
    rates: dict[str, list[float | None]] = {code: [None] * len(dates) for code in currencies}
    for row in rows:
        if row.currency in rates:
            rates[row.currency][column[row.reference_date]] = float(row.units_per_anchor)
    return {
        "institution": REFERENCE_INSTITUTION,
        "anchor_currency": "EUR",
        "source_url": REFERENCE_SOURCE,
        "dates": [day.isoformat() for day in dates],
        "rates": rates,
    }


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


async def refresh_all_rates(skip_fresh_minutes: int = 0) -> dict[str, int]:
    """Collect one quote per tracked pair.

    A transient failure is retried once. On 29 September 2026 two read
    timeouts in a single round cost USD/CNY and USD/JPY thirteen hours of
    history, because the next round was hours away.

    `skip_fresh_minutes` leaves out pairs already quoted within that many
    minutes. A scheduler that re-runs as soon as any pair is behind uses it so
    a round that failed for one pair does not spend budget on the others.
    """
    provider = get_provider()
    settings = get_settings()
    metered = settings.fx_provider == "alpha_vantage"
    spacing = settings.provider_request_spacing_seconds if metered else 0
    refreshed = 0
    errors = 0
    skipped = 0
    last_error: str | None = None
    fresh_since = datetime.now(timezone.utc) - timedelta(minutes=skip_fresh_minutes)
    with SessionLocal() as db:
        pairs = settings.tracked_pairs
        exhausted = False
        for index, pair in enumerate(pairs):
            base, quote = pair.split("/", 1)
            latest = latest_for_pair(db, base, quote) if skip_fresh_minutes else None
            if latest and utc(latest.captured_at) >= fresh_since:
                skipped += 1
                continue
            for attempt in (1, 2):
                if metered and not reserve_request(db):
                    logger.warning("Provider rolling 24-hour budget exhausted")
                    last_error = "provider budget exhausted"
                    errors += 1
                    exhausted = True
                    break
                try:
                    store_quote(db, await provider.get_quote(base, quote))
                    refreshed += 1
                except TransientProviderError as exc:
                    db.rollback()
                    if attempt == 1:
                        logger.warning("Retrying %s after: %s", pair, exc)
                        await asyncio.sleep(spacing)
                        continue
                    logger.error("Quote refresh failed for %s: %s", pair, exc)
                    last_error = f"{pair}: {exc}"
                    errors += 1
                except Exception as exc:
                    db.rollback()
                    logger.exception("Quote refresh failed for %s", pair)
                    last_error = f"{pair}: {exc}"
                    errors += 1
                break
            if exhausted:
                break
            if metered and index < len(pairs) - 1:
                # Free keys can be throttled when multiple pairs are requested back-to-back.
                await asyncio.sleep(spacing)
            else:
                await asyncio.sleep(0)
        prune_history(db)
        # A round with nothing left to fetch is a success, not a stall.
        record_run(db, MARKET_JOB, ok=refreshed > 0 or errors == 0, error=last_error)
    result = {"refreshed": refreshed, "errors": errors}
    if skipped:
        result["skipped"] = skipped
    return result


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
                if hasattr(provider, "get_history"):
                    await backfill_quietly(db, provider)
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


def utc(value: datetime) -> datetime:
    """SQLite hands back naive datetimes; every stored time is UTC."""
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


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
