"""Render the read-only API to a directory of static JSON files.

The API never touches an upstream provider while serving a browser; it only
reads rows the collector wrote. Everything it returns is therefore a pure
function of the database at collection time, which means a CDN can serve it and
no process has to stay running between collections.

Two values are deliberately NOT baked into the files:

  * `is_stale` compares a quote against *now*. Frozen at export time it would
    always read false, so a stalled collector would look healthy for as long as
    the CDN kept serving the file. The exported `meta.json` carries
    `stale_after_minutes` and the client decides.
  * `market_deviation_percent` on official quotes depends on which market quote
    the client is showing, so comparison files keep it while the standalone
    official files leave it null, exactly as the API does.

Pairs are enumerated rather than computed in the browser: cross-rate
triangulation is intricate enough that a second implementation in JavaScript
would drift from this one. Enumeration keeps a single source of truth.

    python -m app.export_static --out ../public
"""
import argparse
import json
from datetime import datetime, timezone
from decimal import Decimal
from itertools import permutations
from pathlib import Path

from sqlalchemy import select

from app.api import aware, serialize_official, serialize_rate
from app.config import get_settings
from app.database import SessionLocal
from app.models import CollectorRun, RateSnapshot
from app.schemas import CoverageOut, HistoryPoint, OfficialRateOut, RateComparisonOut, RateOut
from app.services import (
    MARKET_JOB,
    OFFICIAL_JOB,
    latest_for_pair,
    latest_official_for_pair,
    official_currencies,
    official_job,
)


def encode(value: object) -> object:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return aware(value).isoformat().replace("+00:00", "Z")
    raise TypeError(f"cannot serialize {type(value)!r}")


def write(root: Path, path: str, payload: object) -> int:
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    # separators: every byte is multiplied by the number of enumerated pairs.
    body = json.dumps(payload, default=encode, separators=(",", ":"), ensure_ascii=False)
    target.write_text(body, encoding="utf-8")
    return len(body.encode("utf-8"))


def dump(model) -> object:
    return json.loads(model.model_dump_json())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="../public", help="output directory")
    args = parser.parse_args()

    root = Path(args.out).resolve()
    settings = get_settings()
    written = 0
    total = 0

    with SessionLocal() as db:
        tracked = settings.tracked_pairs
        currencies = official_currencies(db)

        # --- endpoints the extension reads verbatim -------------------------
        # /health's `is_stalled` and a quote's `is_stale` both compare against
        # *now*. A CDN may serve this file long after it was written, so export
        # the raw timestamps plus the thresholds and let the client decide.
        intervals = {
            MARKET_JOB: settings.refresh_interval_minutes,
            OFFICIAL_JOB: settings.official_refresh_interval_minutes,
        }
        for name in settings.official_sources:
            intervals[official_job(name)] = settings.official_refresh_interval_minutes
        runs = {run.job: run for run in db.scalars(select(CollectorRun)).all()}
        jobs = []
        for job, interval in intervals.items():
            run = runs.get(job)
            jobs.append({
                "job": job,
                "finished_at": aware(run.finished_at) if run and run.finished_at else None,
                "last_success_at": (
                    aware(run.last_success_at) if run and run.last_success_at else None
                ),
                "consecutive_failures": (run.consecutive_failures or 0) if run else 0,
                "last_error": run.last_error if run else "never ran",
                "stall_after_minutes": interval * settings.collector_stall_factor,
            })
        total += write(root, "meta.json", {
            "generated_at": datetime.now(timezone.utc),
            "provider": settings.fx_provider,
            "stale_after_minutes": settings.stale_after_minutes,
            "collector": jobs,
        })
        written += 1

        total += write(root, "pairs.json", tracked)
        written += 1

        total += write(root, "currencies.json", dump(
            CoverageOut(market_pairs=tracked, official_currencies=currencies)
        ))
        written += 1

        market: dict[str, RateOut] = {}
        for pair in tracked:
            base, quote = pair.split("/", 1)
            latest = latest_for_pair(db, base, quote)
            if latest:
                market[pair] = serialize_rate(db, latest)
        total += write(root, "rates.json", [dump(m) for m in market.values()])
        written += 1

        official_all: list[OfficialRateOut] = []
        for pair in tracked:
            base, quote = pair.split("/", 1)
            official_all.extend(
                serialize_official(o) for o in latest_official_for_pair(db, base, quote)
            )
        total += write(root, "official-rates.json", [dump(o) for o in official_all])
        written += 1

        # --- history: one 90-day file per pair, client slices to 1/7/30/90 ---
        for pair in tracked:
            base, quote = pair.split("/", 1)
            rows = db.scalars(
                select(RateSnapshot)
                .where(
                    RateSnapshot.base_currency == base,
                    RateSnapshot.quote_currency == quote,
                    RateSnapshot.provider == settings.fx_provider,
                )
                .order_by(RateSnapshot.captured_at)
            ).all()
            points = [
                dump(HistoryPoint(
                    captured_at=aware(r.captured_at), midpoint=r.midpoint, bid=r.bid, ask=r.ask,
                ))
                for r in rows
            ]
            total += write(root, f"rates/{base}/{quote}/history.json", points)
            written += 1

        # --- per-pair official + comparison over every official currency -----
        for base, quote in permutations(currencies, 2):
            observations = latest_official_for_pair(db, base, quote)
            if not observations:
                continue
            total += write(root, f"official-rates/{base}/{quote}.json",
                           [dump(serialize_official(o)) for o in observations])
            written += 1

            snapshot = latest_for_pair(db, base, quote)
            total += write(root, f"comparisons/{base}/{quote}.json", dump(RateComparisonOut(
                base_currency=base,
                quote_currency=quote,
                market=serialize_rate(db, snapshot) if snapshot else None,
                official=[serialize_official(o, snapshot) for o in observations],
            )))
            written += 1

    print(f"wrote {written} files, {total / 1024:.1f} KiB into {root}")


if __name__ == "__main__":
    main()
