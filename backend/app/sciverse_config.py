from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from app.client import SciverseClient
from app.gateway import PaperSchemaGateway, SciverseGateway
from app.local_config import LocalConfigDocument
from app.model_config import normalize_base_url


def validate_sciverse_base_url(value: str) -> str:
    normalized = normalize_base_url(value)
    parsed = urlparse(normalized)
    if parsed.scheme == "http" and parsed.hostname not in {
        "127.0.0.1",
        "localhost",
        "::1",
    }:
        raise ValueError("Sciverse Base URL must use HTTPS")
    return normalized


class SciverseConnection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    base_url: str = "https://api.sciverse.space"
    api_key: SecretStr | None = None
    timeout_seconds: float = Field(default=20, ge=3, le=120)

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        return validate_sciverse_base_url(value)

    @property
    def configured(self) -> bool:
        return bool(
            self.enabled
            and self.api_key
            and self.api_key.get_secret_value().strip()
            and self.base_url
        )


class SciverseConfigStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    configured: bool
    mode: str
    base_url: str
    api_key_set: bool
    api_key_hint: str | None = None
    timeout_seconds: float
    storage: str = "local_project_json"
    storage_path: str


class SciverseConfigUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    base_url: str
    api_key: str | None = Field(default=None, max_length=4096)
    clear_api_key: bool = False
    timeout_seconds: float = Field(default=20, ge=3, le=120)

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        return validate_sciverse_base_url(value)


class SciverseConfigStore:
    def __init__(
        self,
        path: Path | LocalConfigDocument,
        defaults: SciverseConnection,
    ) -> None:
        self.document = (
            path if isinstance(path, LocalConfigDocument) else LocalConfigDocument(path)
        )
        self.path = self.document.path
        self.defaults = defaults

    def load(self) -> SciverseConnection:
        try:
            raw = self.document.section("sciverse")
            if raw is None:
                return self.defaults.model_copy(deep=True)
            return SciverseConnection.model_validate(raw)
        except (ValueError, TypeError):
            return self.defaults.model_copy(deep=True)

    def status(self) -> SciverseConfigStatus:
        connection = self.load()
        key = (
            connection.api_key.get_secret_value().strip()
            if connection.api_key is not None
            else ""
        )
        return SciverseConfigStatus(
            enabled=connection.enabled,
            configured=connection.configured,
            mode="production" if connection.configured else "unconfigured",
            base_url=connection.base_url,
            api_key_set=bool(key),
            api_key_hint=f"••••{key[-4:]}" if key else None,
            timeout_seconds=connection.timeout_seconds,
            storage_path=str(self.path),
        )

    def update(self, update: SciverseConfigUpdate) -> SciverseConfigStatus:
        connection = self.resolve(update)
        payload = connection.model_dump(mode="json")
        if connection.api_key is not None:
            payload["api_key"] = connection.api_key.get_secret_value()
        self.document.update_section("sciverse", payload)
        return self.status()

    def resolve(self, update: SciverseConfigUpdate) -> SciverseConnection:
        """Resolve a submitted draft without changing the stored configuration."""
        current = self.load()
        key: SecretStr | None
        if update.clear_api_key:
            key = None
        elif update.api_key is not None and update.api_key.strip():
            key = SecretStr(update.api_key.strip())
        else:
            key = current.api_key
        return SciverseConnection(
            enabled=update.enabled,
            base_url=update.base_url,
            api_key=key,
            timeout_seconds=update.timeout_seconds,
        )


def build_gateway(
    connection: SciverseConnection,
    *,
    cache_ttl_seconds: int,
) -> PaperSchemaGateway | None:
    if not connection.configured or connection.api_key is None:
        return None
    return SciverseGateway(
        SciverseClient(
            base_url=connection.base_url,
            token=connection.api_key.get_secret_value(),
            timeout_seconds=connection.timeout_seconds,
        ),
        cache_ttl_seconds=cache_ttl_seconds,
    )


async def activate_sciverse_connection(
    application: FastAPI,
    connection: SciverseConnection,
) -> None:
    previous = application.state.gateway
    application.state.gateway = build_gateway(
        connection,
        cache_ttl_seconds=application.state.cache_ttl_seconds,
    )
    application.state.product_capabilities = (
        application.state.product_capabilities.model_copy(
            update={"mode": "production" if connection.configured else "unconfigured"}
        )
    )
    close = getattr(previous, "close", None) if previous is not None else None
    if close is not None:
        await close()
