from datetime import datetime
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
