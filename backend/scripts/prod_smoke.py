from __future__ import annotations

import asyncio
import os
from uuid import uuid4

from app.client import SciverseClient


async def main() -> None:
    token = os.environ.get("SCIVERSE_API_TOKEN", "").strip()
    if not token:
        raise SystemExit(
            "SCIVERSE_API_TOKEN is required; export it in this terminal before running."
        )
    client = SciverseClient(
        base_url=os.environ.get(
            "SCIVERSE_API_BASE_URL", "https://api.sciverse.space"
        ),
        token=token,
        timeout_seconds=20,
    )
    request_id = f"frontierlens-smoke-{uuid4()}"
    try:
        capabilities = await client.request_json(
            "GET", "/paper-schema", request_id=request_id
        )
        search = await client.request_json(
            "POST",
            "/paper-schema/search",
            request_id=request_id,
            json_body={"query": "language model agents", "size": 1},
        )
    finally:
        await client.close()
    resources = capabilities.get("resources")
    item_count = len(search.get("items") or [])
    print(
        "prod_smoke=passed "
        f"capabilities_resources={len(resources) if isinstance(resources, list) else 0} "
        f"search_items={item_count}"
    )


if __name__ == "__main__":
    asyncio.run(main())
