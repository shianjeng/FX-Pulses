from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from xml.etree import ElementTree

import httpx

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


class EcbReferenceProvider:
    institution = "European Central Bank"
    source_url = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"

    async def get_quotes(self, pairs: list[str]) -> list[OfficialQuote]:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            response = await client.get(self.source_url)
            if response.is_error:
                raise ProviderError(f"ECB HTTP status {response.status_code}")
        return self.parse(response.content, pairs)

    def parse(self, payload: bytes, pairs: list[str]) -> list[OfficialQuote]:
        try:
            root = ElementTree.fromstring(payload)
            dated_cube = next(node for node in root.iter() if node.attrib.get("time"))
            reference_date = date.fromisoformat(dated_cube.attrib["time"])
            values = {"EUR": Decimal("1")}
            for node in dated_cube:
                if "currency" in node.attrib and "rate" in node.attrib:
                    values[node.attrib["currency"]] = Decimal(node.attrib["rate"])
        except (ElementTree.ParseError, StopIteration, KeyError, ValueError,
                InvalidOperation) as exc:
            raise ProviderError("ECB response is malformed") from exc

        fetched_at = datetime.now(timezone.utc)
        output = []
        for pair in pairs:
            base, quote = pair.split("/", 1)
            output.append(OfficialQuote(
                base, quote, cross_rate(values, base, quote), self.institution,
                "Euro foreign exchange reference rate", reference_date, fetched_at,
                self.source_url, base != "EUR" and quote != "EUR",
            ))
        return output


class BankOfCanadaProvider:
    institution = "Bank of Canada"
    source_url = (
        "https://www.bankofcanada.ca/valet/observations/"
        "FXUSDCAD,FXCNYCAD,FXJPYCAD/json?recent=1"
    )
    series = {"USD": "FXUSDCAD", "CNY": "FXCNYCAD", "JPY": "FXJPYCAD"}

    async def get_quotes(self, pairs: list[str]) -> list[OfficialQuote]:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            response = await client.get(self.source_url)
            if response.is_error:
                raise ProviderError(f"Bank of Canada HTTP status {response.status_code}")
            payload = response.json()
        return self.parse(payload, pairs)

    def parse(self, payload: dict, pairs: list[str]) -> list[OfficialQuote]:
        try:
            observation = payload["observations"][-1]
            reference_date = date.fromisoformat(observation["d"])
            # Valet daily FX values are Canadian dollars per foreign-currency unit.
            cad_per_currency = {"CAD": Decimal("1")}
            for currency, series_name in self.series.items():
                cad_per_currency[currency] = Decimal(observation[series_name]["v"])
        except (KeyError, IndexError, TypeError, ValueError, InvalidOperation) as exc:
            raise ProviderError("Bank of Canada response is malformed") from exc

        # cross_rate expects currency units per anchor unit.
        values_per_cad = {
            currency: Decimal("1") / value for currency, value in cad_per_currency.items()
        }
        fetched_at = datetime.now(timezone.utc)
        output = []
        for pair in pairs:
            base, quote = pair.split("/", 1)
            output.append(OfficialQuote(
                base, quote, cross_rate(values_per_cad, base, quote), self.institution,
                "Daily average indicative exchange rate", reference_date, fetched_at,
                self.source_url, base != "CAD" and quote != "CAD",
            ))
        return output


def get_official_providers() -> list[EcbReferenceProvider | BankOfCanadaProvider]:
    return [EcbReferenceProvider(), BankOfCanadaProvider()]
