import re
from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "FX Pulse"
    api_prefix: str = "/api/v1"
    database_url: str = "sqlite:///./fx_pulse.db"
    fx_provider: Literal["mock", "alpha_vantage"] = "alpha_vantage"
    alpha_vantage_api_key: str = ""
    tracked_pairs: Annotated[list[str], NoDecode] = ["USD/CNY", "USD/JPY", "CNY/JPY"]
    refresh_interval_minutes: int = Field(default=240, ge=1)
    provider_request_spacing_seconds: int = Field(default=15, ge=5)
    stale_after_minutes: int = Field(default=360, ge=1)
    retention_days: int = Field(default=90, ge=90)
    provider_daily_budget: int = Field(default=25, ge=1)
    official_refresh_interval_minutes: int = Field(default=360, ge=60)
    # Which official sources to collect. PBOC reads a website data endpoint rather
    # than a documented statistical API, so deployments should verify it with
    # `python -m app.check_official` after setup.
    official_sources: Annotated[list[str], NoDecode] = [
        "ecb", "bank_of_canada", "federal_reserve", "bank_of_japan", "pboc",
    ]
    collector_lock_path: str = "./collector.lock"
    api_requests_per_minute: int = Field(default=120, ge=1)
    # Shared cached data changes at most once per collection, so conditional
    # requests and a short max-age remove nearly all repeat work.
    response_cache_seconds: int = Field(default=60, ge=0)
    # A job is reported stalled once it has been silent for this many collection
    # intervals, which lets the extension say "collector stopped", not "data old".
    collector_stall_factor: int = Field(default=3, ge=2)
    # Trust a reverse proxy's X-Forwarded-For for per-client rate limiting.
    trust_forwarded_for: bool = False

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @field_validator("tracked_pairs", mode="before")
    @classmethod
    def parse_pairs(cls, value: object) -> object:
        if isinstance(value, str):
            value = value.split(",")
        if not isinstance(value, list) or not value:
            raise ValueError("TRACKED_PAIRS must be a nonempty list")
        pairs = [str(item).strip().upper() for item in value]
        for pair in pairs:
            if not re.fullmatch(r"[A-Z]{3}/[A-Z]{3}", pair):
                raise ValueError("Invalid TRACKED_PAIRS entry")
            if pair[:3] == pair[4:]:
                raise ValueError("A currency pair must contain two different currencies")
        return list(dict.fromkeys(pairs))

    @field_validator("official_sources", mode="before")
    @classmethod
    def parse_sources(cls, value: object) -> object:
        from app.official_providers import PROVIDERS
        if isinstance(value, str):
            value = value.split(",")
        if not isinstance(value, list):
            raise ValueError("OFFICIAL_SOURCES must be a comma-separated list")
        names = [str(item).strip().lower() for item in value if str(item).strip()]
        unknown = sorted(set(names) - set(PROVIDERS))
        if unknown:
            raise ValueError(
                f"Unknown OFFICIAL_SOURCES entry: {', '.join(unknown)}. "
                f"Valid names: {', '.join(sorted(PROVIDERS))}"
            )
        return list(dict.fromkeys(names))

    @model_validator(mode="after")
    def validate_live(self):
        if self.fx_provider == "alpha_vantage":
            if not self.alpha_vantage_api_key:
                raise ValueError(
                    "ALPHA_VANTAGE_API_KEY is required when FX_PROVIDER=alpha_vantage "
                    "(the default). Run `cp .env.example .env` and add your key from "
                    "https://www.alphavantage.co/support/#api-key, or set FX_PROVIDER=mock "
                    "to start with demo data."
                )
            import math
            calls = math.ceil(1440 / self.refresh_interval_minutes) * len(self.tracked_pairs)
            if calls > self.provider_daily_budget:
                raise ValueError("Collection interval exceeds PROVIDER_DAILY_BUDGET")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
