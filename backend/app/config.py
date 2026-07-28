from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=("../.env", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    sciverse_api_base_url: str = "https://api.sciverse.space"
    sciverse_api_token: SecretStr | None = None
    local_config_path: Path = PROJECT_ROOT / "local.config.json"
    request_timeout_seconds: float = Field(default=20, ge=1, le=120)
    cache_ttl_seconds: int = Field(default=300, ge=10, le=3600)
    max_request_body_bytes: int = Field(default=262_144, ge=1024, le=1_048_576)
    model_base_url: str = "https://api.openai.com/v1"
    model_name: str = "gpt-4.1-mini"
    model_api_key: SecretStr | None = None
    model_timeout_seconds: float = Field(default=30, ge=3, le=120)
    allow_local_model_config: bool = True
    allow_local_sciverse_config: bool = True
    allowed_origins: tuple[str, ...] = (
        "http://127.0.0.1:3040",
        "http://localhost:3040",
    )

@lru_cache
def get_settings() -> Settings:
    return Settings()
