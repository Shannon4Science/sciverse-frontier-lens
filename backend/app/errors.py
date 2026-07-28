from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class UpstreamError(Exception):
    status_code: int
    code: str
    message: str
    retryable: bool
    request_id: str | None = None
    retry_after: float | None = None

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"
