"""Official reference-rate sources.

Each source publishes one anchor-denominated table per business day (ECB quotes
against EUR, the Bank of Canada against CAD). The whole table is stored, so any
pair the institution covers can be derived later without another upstream call.
"""
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation

import httpx
from defusedxml import ElementTree

from app.providers import ProviderError


@dataclass(frozen=True, slots=True)
class OfficialQuote:
    base_currency: str
    quote_currency: str
    rate: Decimal
    institution: str
    rate_type: str
    reference_date: date
    fetched_at: datetime
    source_url: str
    is_derived: bool


def cross_rate(values_per_anchor: dict[str, Decimal], base: str, quote: str) -> Decimal:
    """Return quote units per one base unit from anchor-based observations."""
    try:
        result = values_per_anchor[quote] / values_per_anchor[base]
    except (KeyError, InvalidOperation, ZeroDivisionError) as exc:
        raise ProviderError(f"Official rate does not cover {base}/{quote}") from exc
    if not result.is_finite() or result <= 0:
        raise ProviderError(f"Official rate is invalid for {base}/{quote}")
    return result.quantize(Decimal("0.00000001"))


@dataclass(frozen=True, slots=True)
class OfficialTable:
    """One institution's published observation set for a single reference date."""

    institution: str
    rate_type: str
    anchor_currency: str
    reference_date: date
    fetched_at: datetime
    source_url: str
    values_per_anchor: dict[str, Decimal]

    @property
    def currencies(self) -> list[str]:
        return sorted(self.values_per_anchor)

    def quote(self, base: str, quote: str) -> OfficialQuote:
        return OfficialQuote(
            base, quote, cross_rate(self.values_per_anchor, base, quote),
            self.institution, self.rate_type, self.reference_date, self.fetched_at,
            self.source_url,
            base != self.anchor_currency and quote != self.anchor_currency,
        )

    def quotes(self, pairs: list[str]) -> list[OfficialQuote]:
        output: list[OfficialQuote] = []
        for pair in pairs:
            base, quote = pair.split("/", 1)
            try:
                output.append(self.quote(base, quote))
            except ProviderError:
                # One uncovered pair must never discard the rest of the table.
                continue
        return output


def _usable(value: Decimal) -> bool:
    return value.is_finite() and value > 0


class EcbReferenceProvider:
    institution = "European Central Bank"
    rate_type = "Euro foreign exchange reference rate"
    anchor_currency = "EUR"
    source_url = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"

    async def get_table(self) -> OfficialTable:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            response = await client.get(self.source_url)
            if response.is_error:
                raise ProviderError(f"ECB HTTP status {response.status_code}")
        return self.parse(response.content)

    def parse(self, payload: bytes) -> OfficialTable:
        try:
            root = ElementTree.fromstring(payload)
            dated_cube = next(node for node in root.iter() if node.attrib.get("time"))
            reference_date = date.fromisoformat(dated_cube.attrib["time"])
            values = {self.anchor_currency: Decimal("1")}
            for node in dated_cube:
                currency, rate = node.attrib.get("currency"), node.attrib.get("rate")
                if not currency or not rate or not re.fullmatch(r"[A-Z]{3}", currency):
                    continue
                value = Decimal(rate)
                if _usable(value):
                    values[currency] = value
        except (ElementTree.ParseError, StopIteration, KeyError, ValueError,
                InvalidOperation) as exc:
            raise ProviderError("ECB response is malformed") from exc
        if len(values) < 2:
            raise ProviderError("ECB response contains no usable rates")
        return OfficialTable(
            self.institution, self.rate_type, self.anchor_currency, reference_date,
            datetime.now(timezone.utc), self.source_url, values,
        )


class BankOfCanadaProvider:
    institution = "Bank of Canada"
    rate_type = "Daily average indicative exchange rate"
    anchor_currency = "CAD"
    source_url = (
        "https://www.bankofcanada.ca/valet/observations/group/FX_RATES_DAILY/json?recent=1"
    )
    series_pattern = re.compile(r"FX([A-Z]{3})CAD")

    async def get_table(self) -> OfficialTable:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            response = await client.get(self.source_url)
            if response.is_error:
                raise ProviderError(f"Bank of Canada HTTP status {response.status_code}")
            payload = response.json()
        return self.parse(payload)

    def parse(self, payload: dict) -> OfficialTable:
        try:
            observation = payload["observations"][-1]
            reference_date = date.fromisoformat(observation["d"])
            # Valet daily FX values are Canadian dollars per foreign-currency unit.
            cad_per_currency = {self.anchor_currency: Decimal("1")}
            for key, cell in observation.items():
                match = self.series_pattern.fullmatch(key)
                if not match or not isinstance(cell, dict) or "v" not in cell:
                    continue
                value = Decimal(str(cell["v"]))
                if _usable(value):
                    cad_per_currency[match.group(1)] = value
        except (KeyError, IndexError, TypeError, ValueError, InvalidOperation) as exc:
            raise ProviderError("Bank of Canada response is malformed") from exc
        if len(cad_per_currency) < 2:
            raise ProviderError("Bank of Canada response contains no usable rates")
        # The stored table is always "currency units per one anchor unit".
        values = {
            currency: Decimal("1") / value for currency, value in cad_per_currency.items()
        }
        return OfficialTable(
            self.institution, self.rate_type, self.anchor_currency, reference_date,
            datetime.now(timezone.utc), self.source_url, values,
        )


class PbocProvider:
    """RMB central parity, published each business morning by CFETS for the PBOC.

    This is the rate the popup's disclaimer refers to, so it is worth showing
    next to the market midpoint. Unlike the ECB and Bank of Canada feeds this is
    a website data endpoint rather than a documented statistical API: it is
    disabled unless listed in OFFICIAL_SOURCES, and `python -m app.check_official`
    prints what it actually parsed so a layout change is caught deliberately.
    """

    institution = "People's Bank of China"
    rate_type = "RMB central parity rate"
    anchor_currency = "CNY"
    source_url = "https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/fx/ccpr.json"
    # CFETS quotes these against 100 units of the foreign currency, not one.
    per_hundred = frozenset({"JPY", "KRW"})
    pair_pattern = re.compile(r"([A-Z]{3})/CNY")

    async def get_table(self) -> OfficialTable:
        headers = {"Accept": "application/json", "Referer": "https://www.chinamoney.com.cn/"}
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers=headers) as client:
            response = await client.get(self.source_url)
            if response.is_error:
                raise ProviderError(f"CFETS HTTP status {response.status_code}")
            try:
                payload = response.json()
            except ValueError as exc:
                raise ProviderError("CFETS returned invalid JSON") from exc
        return self.parse(payload)

    def parse(self, payload: dict) -> OfficialTable:
        try:
            records = payload["records"]
            if not isinstance(records, list):
                raise TypeError("records is not a list")
            reference_date = self._reference_date(payload, records)
            values = {self.anchor_currency: Decimal("1")}
            for record in records:
                if not isinstance(record, dict):
                    continue
                name = str(record.get("vrtEName") or record.get("ccyPair") or "").strip()
                match = self.pair_pattern.fullmatch(name)
                raw = record.get("price", record.get("ccprPrice"))
                if not match or raw in (None, ""):
                    continue
                currency = match.group(1)
                price = Decimal(str(raw))
                if not _usable(price):
                    continue
                # `price` is CNY per unit (or per 100 units) of the foreign currency.
                cny_per_unit = price / (100 if currency in self.per_hundred else 1)
                values[currency] = Decimal("1") / cny_per_unit
        except (KeyError, IndexError, TypeError, ValueError, InvalidOperation) as exc:
            raise ProviderError("CFETS response is malformed") from exc
        if len(values) < 2:
            raise ProviderError("CFETS response contains no usable rates")
        return OfficialTable(
            self.institution, self.rate_type, self.anchor_currency, reference_date,
            datetime.now(timezone.utc), self.source_url, values,
        )

    def _reference_date(self, payload: dict, records: list) -> date:
        for candidate in (
            (payload.get("data") or {}).get("lastDate"),
            *(record.get("date") for record in records if isinstance(record, dict)),
        ):
            if candidate:
                return date.fromisoformat(str(candidate).strip()[:10].replace("/", "-"))
        raise ValueError("no reference date in CFETS response")


PROVIDERS = {
    "ecb": EcbReferenceProvider,
    "bank_of_canada": BankOfCanadaProvider,
    "pboc": PbocProvider,
}

OfficialProvider = EcbReferenceProvider | BankOfCanadaProvider | PbocProvider


def get_official_providers(names: list[str] | None = None) -> list[OfficialProvider]:
    from app.config import get_settings
    selected = names if names is not None else get_settings().official_sources
    return [PROVIDERS[name]() for name in selected]
