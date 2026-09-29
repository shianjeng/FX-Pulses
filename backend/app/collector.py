"""Run exactly one collector per deployment: python -m app.collector.

`--once` collects a single round and exits, for schedulers that own the timing
themselves. A CI runner is the reason it exists: the container is destroyed
after every run, so a long-lived scheduler inside it would only ever fire its
first job before being killed.
"""
import argparse
import asyncio
import logging
from datetime import datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from filelock import FileLock, Timeout

from app.config import get_settings
from app.services import refresh_all_rates, refresh_official_rates


async def run_once(skip_fresh_minutes: int = 0):
    market = await refresh_all_rates(skip_fresh_minutes)
    official = await refresh_official_rates()
    logging.info("collected market=%s official=%s", market, official)


async def run():
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(
        refresh_all_rates, "interval",
        minutes=get_settings().refresh_interval_minutes,
        next_run_time=datetime.now(timezone.utc), max_instances=1, coalesce=True,
    )
    scheduler.add_job(
        refresh_official_rates, "interval",
        minutes=get_settings().official_refresh_interval_minutes,
        next_run_time=datetime.now(timezone.utc), max_instances=1, coalesce=True,
    )
    scheduler.start()
    try:
        await asyncio.Event().wait()
    finally:
        scheduler.shutdown(wait=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FX Pulse collector")
    parser.add_argument("--once", action="store_true", help="collect one round and exit")
    parser.add_argument(
        "--skip-fresh", type=int, default=0, metavar="MINUTES",
        help="with --once, leave out pairs quoted within this many minutes",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    # httpx logs complete query URLs at INFO, which would expose provider API keys.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    try:
        with FileLock(get_settings().collector_lock_path, timeout=0):
            asyncio.run(run_once(args.skip_fresh) if args.once else run())
    except Timeout:
        raise SystemExit("A collector already holds the shared lock") from None
