import asyncio

import pytest

from app.cache import AsyncTTLCache


@pytest.mark.asyncio
async def test_cache_coalesces_concurrent_requests() -> None:
    cache = AsyncTTLCache(ttl_seconds=60)
    calls = 0

    async def factory() -> dict[str, int]:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0)
        return {"value": calls}

    first, second = await asyncio.gather(
        cache.get_or_create("same", factory),
        cache.get_or_create("same", factory),
    )

    assert first == second == {"value": 1}
    assert calls == 1
