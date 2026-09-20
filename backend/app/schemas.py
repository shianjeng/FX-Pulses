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
    market_deviation_percent: Decimal | None = None
    model_config = ConfigDict(from_attributes=True)


class RateComparisonOut(BaseModel):
    base_currency: str
    quote_currency: str
    market: RateOut | None
    official: list[OfficialRateOut]
