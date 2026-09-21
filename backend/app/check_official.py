"""Verify every configured official source against the live endpoint.

    python -m app.check_official

Prints the reference date, the currency count and a few crosses for each source,
so a changed upstream layout is noticed on purpose rather than as silent missing
data. Writes nothing to the database and never touches the market provider.
"""
import asyncio
import sys

from app.config import get_settings
from app.official_providers import get_official_providers

SAMPLE_PAIRS = ["USD/CNY", "USD/JPY", "CNY/JPY", "EUR/USD"]


async def main() -> int:
    failures = 0
    for provider in get_official_providers():
        print(f"\n== {provider.institution} ({provider.source_url})")
        try:
            table = await provider.get_table()
        except Exception as exc:  # noqa: BLE001 - this is a diagnostic entry point
            failures += 1
            print(f"   FAILED: {type(exc).__name__}: {exc}")
            continue
        print(f"   reference date : {table.reference_date}")
        print(f"   anchor         : {table.anchor_currency}")
        print(f"   currencies ({len(table.currencies):>2}): {', '.join(table.currencies)}")
        for pair in SAMPLE_PAIRS:
            base, quote = pair.split("/")
            try:
                print(f"   {pair:<8} = {table.quote(base, quote).rate}")
            except Exception as exc:  # noqa: BLE001
                print(f"   {pair:<8} - {exc}")
    print(f"\nconfigured sources: {', '.join(get_settings().official_sources)}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
