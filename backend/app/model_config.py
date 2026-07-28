from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    field_validator,
)

from app.local_config import LocalConfigDocument


def normalize_base_url(value: str) -> str:
    normalized = value.strip().rstrip("/")
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("base_url must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password:
        raise ValueError("base_url must not contain credentials")
    return normalized


class ModelConnection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    base_url: str = "https://api.openai.com/v1"
    model: str = "gpt-4.1-mini"
    api_key: SecretStr | None = None
    timeout_seconds: float = Field(default=30, ge=3, le=120)
    allow_insecure_http: bool = False

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        return normalize_base_url(value)

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("model is required")
        return normalized

    @property
    def configured(self) -> bool:
        return bool(
            self.enabled
            and self.api_key
            and self.api_key.get_secret_value().strip()
            and self.base_url
            and self.model
        )


class ModelConfigStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    configured: bool
    base_url: str
    model: str
    api_key_set: bool
    api_key_hint: str | None = None
    timeout_seconds: float
    allow_insecure_http: bool
    storage: str = "local_project_json"
    storage_path: str


class ModelConfigUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    base_url: str
    model: str
    api_key: str | None = Field(default=None, max_length=4096)
    clear_api_key: bool = False
    timeout_seconds: float = Field(default=30, ge=3, le=120)
    allow_insecure_http: bool = False

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        return normalize_base_url(value)

    @field_validator("model")
    @classmethod
    def validate_model(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("model is required")
        return normalized

class ModelConfigStore:
    def __init__(
        self,
        path: Path | LocalConfigDocument,
        defaults: ModelConnection,
    ) -> None:
        self.document = (
            path if isinstance(path, LocalConfigDocument) else LocalConfigDocument(path)
        )
        self.path = self.document.path
        self.defaults = defaults

    def load(self) -> ModelConnection:
        try:
            raw = self.document.section("model")
            if raw is None:
                return self.defaults.model_copy(deep=True)
            return ModelConnection.model_validate(raw)
        except (ValueError, TypeError):
            return self.defaults.model_copy(deep=True)

    def status(self) -> ModelConfigStatus:
        connection = self.load()
        key = (
            connection.api_key.get_secret_value().strip()
            if connection.api_key is not None
            else ""
        )
        return ModelConfigStatus(
            enabled=connection.enabled,
            configured=connection.configured,
            base_url=connection.base_url,
            model=connection.model,
            api_key_set=bool(key),
            api_key_hint=f"••••{key[-4:]}" if key else None,
            timeout_seconds=connection.timeout_seconds,
            allow_insecure_http=connection.allow_insecure_http,
            storage_path=str(self.path),
        )

    def update(self, update: ModelConfigUpdate) -> ModelConfigStatus:
        connection = self.resolve(update)
        payload = connection.model_dump(mode="json")
        if connection.api_key is not None:
            payload["api_key"] = connection.api_key.get_secret_value()
        self.document.update_section("model", payload)
        return self.status()

    def resolve(self, update: ModelConfigUpdate) -> ModelConnection:
        """Resolve a submitted draft without changing the stored configuration."""
        current = self.load()
        key: SecretStr | None
        if update.clear_api_key:
            key = None
        elif update.api_key is not None and update.api_key.strip():
            key = SecretStr(update.api_key.strip())
        else:
            key = current.api_key
        return ModelConnection(
            enabled=update.enabled,
            base_url=update.base_url,
            model=update.model,
            api_key=key,
            timeout_seconds=update.timeout_seconds,
            allow_insecure_http=update.allow_insecure_http,
        )
