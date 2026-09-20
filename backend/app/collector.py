"""Run exactly one collector per deployment: python -m app.collector."""
import asyncio
import logging
from datetime import datetime, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from filelock import FileLock, Timeout

from app.config import get_settings
from app.services import refresh_all_rates, refresh_official_rates


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
    logging.basicConfig(level=logging.INFO)
    # httpx logs complete query URLs at INFO, which would expose provider API keys.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    try:
        with FileLock(get_settings().collector_lock_path, timeout=0):
            asyncio.run(run())
    except Timeout:
        raise SystemExit("A collector already holds the shared lock") from None
