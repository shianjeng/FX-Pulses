from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict


class RateOut(BaseModel):
    base_currency: str
    quote_currency: str
    bid: Decimal
    ask: Decimal
    midpoint: Decimal
    spread: Decimal = Decimal("0")
    provider: str
    captured_at: datetime
    change_percent: Decimal | None = None
    is_stale: bool = False
    model_config = ConfigDict(from_attributes=True)


class HistoryPoint(BaseModel):
    captured_at: datetime
    midpoint: Decimal
    bid: Decimal
    ask: Decimal
    model_config = ConfigDict(from_attributes=True)


class OfficialRateOut(BaseModel):
    base_currency: str
    quote_currency: str
    rate: Decimal
    institution: str
    rate_type: str
    reference_date: date
    fetched_at: datetime
    source_url: str
    is_derived: bool
    via_currency: str | None = None
    market_deviation_percent: Decimal | None = None
    model_config = ConfigDict(from_attributes=True)


class RateComparisonOut(BaseModel):
    base_currency: str
    quote_currency: str
    market: RateOut | None
    official: list[OfficialRateOut]


class CoverageOut(BaseModel):
    """Live pairs versus currencies that only have an official reference rate."""

    market_pairs: list[str]
    official_currencies: list[str]


class CollectorJobOut(BaseModel):
    job: str
    finished_at: datetime | None = None
    last_success_at: datetime | None = None
    consecutive_failures: int = 0
    last_error: str | None = None
    is_stalled: bool = False


class HealthOut(BaseModel):
    status: str
    provider: str
    collector: list[CollectorJobOut] = []
