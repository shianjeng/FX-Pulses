from functools import lru_cache
from typing import Annotated

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "FX Pulse"
    api_prefix: str = "/api/v1"
    database_url: str = "sqlite:///./fx_pulse.db"
    fx_provider: str = "mock"
    alpha_vantage_api_key: str = ""
    tracked_pairs: Annotated[list[str], NoDecode] = ["USD/CNY", "USD/JPY", "CNY/JPY"]
    refresh_interval_minutes: int = 240
    stale_after_minutes: int = 360

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @field_validator("tracked_pairs", mode="before")
    @classmethod
    def parse_pairs(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip().upper() for item in value.split(",") if item.strip()]
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
