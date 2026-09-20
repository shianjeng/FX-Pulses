import math
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx

from app.config import get_settings


class ProviderError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class Quote:
    base_currency: str
    quote_currency: str
    bid: Decimal
    ask: Decimal
    midpoint: Decimal
    provider: str
    captured_at: datetime


class AlphaVantageProvider:
    url = "https://www.alphavantage.co/query"

    def __init__(self, api_key: str) -> None:
        if not api_key:
            raise ProviderError("ALPHA_VANTAGE_API_KEY is required for live rates")
        self.api_key = api_key

    async def get_quote(self, base: str, quote: str) -> Quote:
        params = {
            "function": "CURRENCY_EXCHANGE_RATE",
            "from_currency": base,
            "to_currency": quote,
            "apikey": self.api_key,
        }
        async with httpx.AsyncClient(timeout=15) as client:
            try:
                response = await client.get(self.url, params=params)
            except httpx.RequestError:
                # Request exceptions may embed the full URL, including the secret key.
                raise ProviderError("Alpha Vantage network request failed") from None
            if response.is_error:
                raise ProviderError(f"Provider HTTP status {response.status_code}")
            try:
                payload = response.json()
            except ValueError as exc:
                raise ProviderError("Alpha Vantage returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise ProviderError("Alpha Vantage returned an invalid response structure")
        data = payload.get("Realtime Currency Exchange Rate")
        if not data:
            if payload.get("Error Message"):
                raise ProviderError("Alpha Vantage rejected the currency pair or API key")
            if payload.get("Note") or payload.get("Information"):
                raise ProviderError("Alpha Vantage quota or endpoint entitlement was exceeded")
            raise ProviderError("Alpha Vantage quote is unavailable")
        try:
            bid = Decimal(data["8. Bid Price"])
            ask = Decimal(data["9. Ask Price"])
            refreshed = datetime.strptime(data["6. Last Refreshed"], "%Y-%m-%d %H:%M:%S").replace(
                tzinfo=ZoneInfo(data["7. Time Zone"])
            ).astimezone(timezone.utc)
            if not bid.is_finite() or not ask.is_finite() or not 0 < bid <= ask:
                raise ValueError("Invalid bid/ask")
        except (KeyError, ValueError, TypeError, InvalidOperation, ZoneInfoNotFoundError) as exc:
            raise ProviderError("Provider response is missing bid/ask fields") from exc
        return Quote(base, quote, bid, ask, (bid + ask) / 2, "alpha_vantage", refreshed)


class MockProvider:
    centers = {"USD/CNY": 7.12, "USD/JPY": 148.4, "CNY/JPY": 20.84}

    async def get_quote(self, base: str, quote: str) -> Quote:
        now = datetime.now(timezone.utc)
        pair = f"{base}/{quote}"
        center = self.centers.get(pair)
        if center is None:
            inverse = self.centers.get(f"{quote}/{base}")
            if inverse is None:
                raise ProviderError(f"Unsupported demo pair: {pair}")
            center = 1 / inverse
        phase = now.timestamp() / 3600 + sum(ord(char) for char in pair)
        midpoint = Decimal(str(center * (1 + 0.004 * math.sin(phase))))
        spread = midpoint * Decimal("0.00012")
        return Quote(
            base,
            quote,
            (midpoint - spread / 2).quantize(Decimal("0.00000001")),
            (midpoint + spread / 2).quantize(Decimal("0.00000001")),
            midpoint.quantize(Decimal("0.00000001")),
            "mock",
            now,
        )


def get_provider() -> AlphaVantageProvider | MockProvider:
    settings = get_settings()
    if settings.fx_provider == "alpha_vantage":
        return AlphaVantageProvider(settings.alpha_vantage_api_key)
    return MockProvider()
