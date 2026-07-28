from __future__ import annotations

from collections.abc import Awaitable

import httpx
import pytest

from app.client import SciverseClient
from app.errors import UpstreamError


async def no_sleep(_: float) -> None:
    return None


@pytest.mark.asyncio
async def test_client_retries_rate_limit_and_sends_server_side_auth() -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        assert request.headers["authorization"] == "Bearer test-value"
        assert request.headers["x-request-id"] == "rid-123"
        if attempts == 1:
            return httpx.Response(429, headers={"retry-after": "0"})
        return httpx.Response(200, json={"items": []}, headers={"x-request-id": "up-1"})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(
        transport=transport, base_url="https://api.sciverse.space"
    ) as http_client:
        client = SciverseClient(
            base_url="https://api.sciverse.space",
            token="test-value",
            timeout_seconds=2,
            client=http_client,
            sleep=no_sleep,
        )
        payload = await client.request_json(
            "POST",
            "/paper-schema/search",
            request_id="rid-123",
            json_body={"query": "agent"},
        )

    assert attempts == 2
    assert payload == {"items": []}


@pytest.mark.asyncio
async def test_client_does_not_retry_validation_error_or_leak_body() -> None:
    attempts = 0

    def handler(_: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(
            422,
            json={"detail": "raw internal field rejected", "token": "secret"},
            headers={"x-request-id": "upstream-rid"},
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(
        transport=transport, base_url="https://api.sciverse.space"
    ) as http_client:
        client = SciverseClient(
            base_url="https://api.sciverse.space",
            token="test-value",
            timeout_seconds=2,
            client=http_client,
            sleep=no_sleep,
        )
        with pytest.raises(UpstreamError) as caught:
            await client.request_json(
                "POST",
                "/paper-schema/search",
                request_id="rid-123",
                json_body={"query": "agent"},
            )

    assert attempts == 1
    assert caught.value.code == "SCIVERSE_VALIDATION_ERROR"
    assert caught.value.request_id == "upstream-rid"
    assert "secret" not in caught.value.message
    assert "raw" not in caught.value.message


@pytest.mark.asyncio
async def test_client_rejects_non_object_json() -> None:
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json=[]))
    async with httpx.AsyncClient(
        transport=transport, base_url="https://api.sciverse.space"
    ) as http_client:
        client = SciverseClient(
            base_url="https://api.sciverse.space",
            token="test-value",
            timeout_seconds=2,
            client=http_client,
            sleep=no_sleep,
        )
        with pytest.raises(UpstreamError, match="unexpected payload"):
            await client.request_json("GET", "/paper-schema", request_id="rid")


def test_sleep_contract_is_awaitable() -> None:
    result = no_sleep(0)
    assert isinstance(result, Awaitable)
    result.close()
