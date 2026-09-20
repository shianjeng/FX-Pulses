import re
from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "FX Pulse"
    api_prefix: str = "/api/v1"
    database_url: str = "sqlite:///./fx_pulse.db"
    fx_provider: Literal["mock", "alpha_vantage"] = "mock"
    alpha_vantage_api_key: str = ""
    tracked_pairs: Annotated[list[str], NoDecode] = ["USD/CNY", "USD/JPY", "CNY/JPY"]
    refresh_interval_minutes: int = Field(default=240, ge=1)
    provider_request_spacing_seconds: int = Field(default=15, ge=5)
    stale_after_minutes: int = Field(default=360, ge=1)
    retention_days: int = Field(default=90, ge=90)
    provider_daily_budget: int = Field(default=25, ge=1)
    official_refresh_interval_minutes: int = Field(default=360, ge=60)
    collector_lock_path: str = "./collector.lock"
    api_requests_per_minute: int = Field(default=120, ge=1)

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

    @model_validator(mode="after")
    def validate_live(self):
        if self.fx_provider == "alpha_vantage":
            if not self.alpha_vantage_api_key:
                raise ValueError("ALPHA_VANTAGE_API_KEY is required in live mode")
            import math
            calls = math.ceil(1440 / self.refresh_interval_minutes) * len(self.tracked_pairs)
            if calls > self.provider_daily_budget:
                raise ValueError("Collection interval exceeds PROVIDER_DAILY_BUDGET")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
