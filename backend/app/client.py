from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from contextlib import suppress
from typing import Any

import httpx

from app.errors import UpstreamError

Sleep = Callable[[float], Awaitable[None]]


class SciverseClient:
    RETRYABLE_STATUS = {429, 500, 502, 503, 504}

    def __init__(
        self,
        *,
        base_url: str,
        token: str,
        timeout_seconds: float,
        max_attempts: int = 3,
        client: httpx.AsyncClient | None = None,
        sleep: Sleep = asyncio.sleep,
    ) -> None:
        self._token = token
        self._max_attempts = max_attempts
        self._sleep = sleep
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            timeout=httpx.Timeout(timeout_seconds),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def request_json(
        self,
        method: str,
        path: str,
        *,
        request_id: str,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        for attempt in range(1, self._max_attempts + 1):
            try:
                response = await self._client.request(
                    method,
                    path,
                    params=params,
                    json=json_body,
                    headers={
                        "Accept": "application/json",
                        "Authorization": f"Bearer {self._token}",
                        "X-Request-ID": request_id,
                        "X-Sciverse-Source": "schema-lens",
                    },
                )
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                if attempt >= self._max_attempts:
                    raise UpstreamError(
                        status_code=504,
                        code="SCIVERSE_NETWORK_ERROR",
                        message="Sciverse is temporarily unreachable",
                        retryable=True,
                        request_id=request_id,
                    ) from exc
                await self._sleep(self._backoff(attempt))
                continue

            upstream_request_id = response.headers.get("x-request-id") or request_id
            if response.status_code in self.RETRYABLE_STATUS and attempt < self._max_attempts:
                await self._sleep(self._retry_delay(response, attempt))
                continue
            if response.is_error:
                raise self._response_error(response, upstream_request_id)
            try:
                payload = response.json()
            except ValueError as exc:
                raise UpstreamError(
                    status_code=502,
                    code="SCIVERSE_INVALID_JSON",
                    message="Sciverse returned an invalid response",
                    retryable=False,
                    request_id=upstream_request_id,
                ) from exc
            if not isinstance(payload, dict):
                raise UpstreamError(
                    status_code=502,
                    code="SCIVERSE_INVALID_PAYLOAD",
                    message="Sciverse returned an unexpected payload",
                    retryable=False,
                    request_id=upstream_request_id,
                )
            return payload
        raise AssertionError("request loop exhausted")

    @staticmethod
    def _backoff(attempt: int) -> float:
        return min(4.0, 0.25 * (2 ** (attempt - 1))) + random.uniform(0, 0.08)

    def _retry_delay(self, response: httpx.Response, attempt: int) -> float:
        value = response.headers.get("retry-after")
        if value:
            try:
                return min(10.0, max(0.0, float(value)))
            except ValueError:
                pass
        return self._backoff(attempt)

    @staticmethod
    def _response_error(response: httpx.Response, request_id: str) -> UpstreamError:
        status = response.status_code
        retryable = status in SciverseClient.RETRYABLE_STATUS
        codes = {
            400: "SCIVERSE_BAD_REQUEST",
            401: "SCIVERSE_UNAUTHORIZED",
            403: "SCIVERSE_FORBIDDEN",
            404: "SCIVERSE_NOT_FOUND",
            422: "SCIVERSE_VALIDATION_ERROR",
            429: "SCIVERSE_RATE_LIMITED",
        }
        retry_after: float | None = None
        if response.headers.get("retry-after"):
            with suppress(ValueError):
                retry_after = float(response.headers["retry-after"])
        return UpstreamError(
            status_code=status if status < 500 else 502,
            code=codes.get(status, "SCIVERSE_UPSTREAM_ERROR"),
            message=(
                "Sciverse request was rejected"
                if status < 500
                else "Sciverse is temporarily unavailable"
            ),
            retryable=retryable,
            request_id=request_id,
            retry_after=retry_after,
        )
