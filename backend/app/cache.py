from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any


class AsyncTTLCache:
    def __init__(self, ttl_seconds: int) -> None:
        self._ttl_seconds = ttl_seconds
        self._values: dict[str, tuple[float, Any]] = {}
        self._inflight: dict[str, asyncio.Task[Any]] = {}
        self._lock = asyncio.Lock()

    async def get_or_create(
        self,
        key: str,
        factory: Callable[[], Awaitable[Any]],
    ) -> Any:
        now = time.monotonic()
        cached = self._values.get(key)
        if cached and cached[0] > now:
            return cached[1]

        async with self._lock:
            cached = self._values.get(key)
            if cached and cached[0] > time.monotonic():
                return cached[1]
            task = self._inflight.get(key)
            if task is None:
                task = asyncio.create_task(factory())
                self._inflight[key] = task

        try:
            value = await task
        except Exception:
            async with self._lock:
                if self._inflight.get(key) is task:
                    self._inflight.pop(key, None)
            raise

        async with self._lock:
            self._values[key] = (time.monotonic() + self._ttl_seconds, value)
            if self._inflight.get(key) is task:
                self._inflight.pop(key, None)
        return value
