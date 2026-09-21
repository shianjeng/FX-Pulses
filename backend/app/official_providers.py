"""Official reference-rate sources.

Each source publishes one anchor-denominated table per business day (ECB quotes
against EUR, the Bank of Canada against CAD). The whole table is stored, so any
pair the institution covers can be derived later without another upstream call.
"""
import csv
import io
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
    # Set when the two legs come from different institutions, e.g. EUR/USD from
    # the ECB combined with USD/KRW from the Federal Reserve.
    via_currency: str | None = None


def raw_cross(values_per_anchor: dict[str, Decimal], base: str, quote: str) -> Decimal:
    """Unrounded quote units per base unit, for chaining without compounding error."""
    try:
        result = values_per_anchor[quote] / values_per_anchor[base]
    except (KeyError, InvalidOperation, ZeroDivisionError) as exc:
        raise ProviderError(f"Official rate does not cover {base}/{quote}") from exc
    if not result.is_finite() or result <= 0:
        raise ProviderError(f"Official rate is invalid for {base}/{quote}")
    return result


def cross_rate(values_per_anchor: dict[str, Decimal], base: str, quote: str) -> Decimal:
    """Return quote units per one base unit from anchor-based observations."""
    return raw_cross(values_per_anchor, base, quote).quantize(Decimal("0.00000001"))


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
            observations = payload["observations"]
            if not isinstance(observations, list) or not observations:
                raise TypeError("observations is not a nonempty list")
            # `recent=1` means the latest value for *each series*. Discontinued
            # currencies can therefore appear after the current row with an old
            # date; the response is not guaranteed to be sorted chronologically.
            reference_date = max(date.fromisoformat(item["d"]) for item in observations)
            # Valet daily FX values are Canadian dollars per foreign-currency unit.
            cad_per_currency = {self.anchor_currency: Decimal("1")}
            for observation in observations:
                if date.fromisoformat(observation["d"]) != reference_date:
                    continue
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


class FederalReserveProvider:
    institution = "Federal Reserve Board"
    rate_type = "H.10 foreign exchange rate"
    anchor_currency = "USD"
    source_url = (
        "https://www.federalreserve.gov/datadownload/Output.aspx?filetype=csv&from="
        "&label=include&lastobs=10&layout=seriescolumn&rel=H10"
        "&series=60f32914ab61dfab590e0e470153e3ae&to=&type=package"
    )

    async def get_table(self) -> OfficialTable:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            response = await client.get(self.source_url)
            if response.is_error:
                raise ProviderError(f"Federal Reserve HTTP status {response.status_code}")
        return self.parse(response.text)

    def parse(self, payload: str) -> OfficialTable:
        try:
            rows = list(csv.reader(io.StringIO(payload)))
            currency_row = next(row for row in rows if row and row[0] == "Currency:")
            identifier_row = next(row for row in rows if row and row[0] == "Unique Identifier:")
            header_index = next(i for i, row in enumerate(rows) if row and row[0] == "Time Period")
            data_rows = rows[header_index + 1:]
            usable = []
            for row in data_rows:
                if not row:
                    continue
                current = []
                for index, raw in enumerate(row[1:], start=1):
                    if raw in {"", "ND", "NA"}:
                        continue
                    value = Decimal(raw)
                    if _usable(value):
                        current.append((index, value))
                if current:
                    usable.append((date.fromisoformat(row[0]), current))
            reference_date, observations = max(usable, key=lambda item: item[0])
            values = {self.anchor_currency: Decimal("1")}
            for index, value in observations:
                currency = currency_row[index]
                if not re.fullmatch(r"[A-Z]{3}", currency):
                    continue
                # H.10 mixes USD-per-currency series (RXI$US...) with
                # currency-per-USD series (RXI_N...). Normalize all to the latter.
                identifier = identifier_row[index]
                values[currency] = Decimal("1") / value if "RXI$US" in identifier else value
        except (StopIteration, IndexError, TypeError, ValueError, InvalidOperation) as exc:
            raise ProviderError("Federal Reserve response is malformed") from exc
        if len(values) < 2:
            raise ProviderError("Federal Reserve response contains no usable rates")
        return OfficialTable(
            self.institution, self.rate_type, self.anchor_currency, reference_date,
            datetime.now(timezone.utc), self.source_url, values,
        )


class BankOfJapanProvider:
    institution = "Bank of Japan"
    rate_type = "Tokyo market USD/JPY spot rate at 17:00 JST"
    anchor_currency = "USD"
    source_url = "https://www.stat-search.boj.or.jp/api/v1/getDataCode"

    async def get_table(self) -> OfficialTable:
        now = datetime.now(timezone.utc)
        start = date.fromordinal(now.date().toordinal() - 45)
        params = {
            "format": "json", "lang": "en", "db": "FM08", "code": "FXERD04",
            # The BOJ API expects YYYYMM periods even for a daily series.
            "startDate": start.strftime("%Y%m"), "endDate": now.strftime("%Y%m"),
        }
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            response = await client.get(self.source_url, params=params)
            if response.is_error:
                raise ProviderError(f"Bank of Japan HTTP status {response.status_code}")
            try:
                payload = response.json()
            except ValueError as exc:
                raise ProviderError("Bank of Japan returned invalid JSON") from exc
        return self.parse(payload)

    def parse(self, payload: dict) -> OfficialTable:
        try:
            if payload.get("STATUS") != 200:
                raise ValueError("API status is not successful")
            series = next(item for item in payload["RESULTSET"] if item["SERIES_CODE"] == "FXERD04")
            pairs = zip(series["VALUES"]["SURVEY_DATES"], series["VALUES"]["VALUES"], strict=True)
            usable = [(date.fromisoformat(str(day)), Decimal(str(value)))
                      for day, value in pairs if value is not None]
            reference_date, value = max(usable, key=lambda item: item[0])
        except (KeyError, StopIteration, TypeError, ValueError, InvalidOperation) as exc:
            raise ProviderError("Bank of Japan response is malformed") from exc
        if not _usable(value):
            raise ProviderError("Bank of Japan response contains no usable rate")
        return OfficialTable(
            self.institution, self.rate_type, self.anchor_currency, reference_date,
            datetime.now(timezone.utc), self.source_url,
            {self.anchor_currency: Decimal("1"), "JPY": value},
        )


class PbocProvider:
    """RMB central parity, published each business morning by CFETS for the PBOC.

    This is the rate the popup's disclaimer refers to, so it is worth showing
    next to the market midpoint. Unlike the other feeds this is a website data
    endpoint rather than a documented statistical API. `python -m app.check_official`
    prints what it actually parsed so a layout change is caught deliberately.
    """

    institution = "People's Bank of China"
    rate_type = "RMB central parity rate"
    anchor_currency = "CNY"
    source_url = "https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/fx/ccpr.json"
    # CFETS quotes these against 100 units of the foreign currency, not one.
    per_hundred = frozenset({"JPY", "KRW"})
    foreign_per_cny_pattern = re.compile(r"(100)?([A-Z]{3})/CNY")
    cny_per_foreign_pattern = re.compile(r"CNY/([A-Z]{3})")

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
                raw = record.get("price", record.get("ccprPrice"))
                if raw in (None, ""):
                    continue
                price = Decimal(str(raw))
                if not _usable(price):
                    continue
                foreign_match = self.foreign_per_cny_pattern.fullmatch(name)
                cny_match = self.cny_per_foreign_pattern.fullmatch(name)
                if foreign_match:
                    currency = foreign_match.group(2)
                    # `price` is CNY per unit, or per 100 units when explicitly
                    # prefixed (the old layout omitted the prefix for JPY/KRW).
                    scale = 100 if foreign_match.group(1) or currency in self.per_hundred else 1
                    values[currency] = Decimal(scale) / price
                elif cny_match:
                    currency = cny_match.group(1)
                    if currency != self.anchor_currency:
                        # These series are already foreign-currency units per CNY.
                        values[currency] = price
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
    "federal_reserve": FederalReserveProvider,
    "bank_of_japan": BankOfJapanProvider,
    "pboc": PbocProvider,
}

OfficialProvider = (
    EcbReferenceProvider | BankOfCanadaProvider | FederalReserveProvider
    | BankOfJapanProvider | PbocProvider
)


PROVIDER_NAMES = {klass: name for name, klass in PROVIDERS.items()}


def provider_name(provider: OfficialProvider) -> str:
    """Stable short key used for per-source collector heartbeats."""
    return PROVIDER_NAMES.get(type(provider), type(provider).__name__)


def get_official_providers(names: list[str] | None = None) -> list[OfficialProvider]:
    from app.config import get_settings
    selected = names if names is not None else get_settings().official_sources
    return [PROVIDERS[name]() for name in selected]
