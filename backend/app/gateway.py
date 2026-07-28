from __future__ import annotations

import json
from typing import Any, Protocol
from urllib.parse import quote

from app.cache import AsyncTTLCache
from app.client import SciverseClient


class PaperSchemaGateway(Protocol):
    async def capabilities(self, request_id: str) -> dict[str, Any]: ...

    async def search_papers(
        self, body: dict[str, Any], request_id: str
    ) -> dict[str, Any]: ...

    async def paper(self, schema_id: str, request_id: str) -> dict[str, Any] | None: ...

    async def entities(
        self, schema_id: str, request_id: str, *, max_items: int
    ) -> tuple[list[dict[str, Any]], bool]: ...

    async def relations(
        self, schema_id: str, request_id: str, *, max_items: int
    ) -> tuple[list[dict[str, Any]], bool]: ...

    async def citation_summary(self, schema_id: str, request_id: str) -> dict[str, Any]: ...

    async def citations(
        self, schema_id: str, request_id: str, *, max_items: int
    ) -> tuple[list[dict[str, Any]], int, bool]: ...

    async def citation_graph(
        self,
        schema_id: str,
        request_id: str,
        *,
        direction: str,
        depth: int,
        max_nodes: int,
        max_edges: int,
    ) -> dict[str, Any]: ...

    async def related_papers(
        self, schema_id: str, body: dict[str, Any], request_id: str
    ) -> dict[str, Any]: ...

    async def entity_related_papers(
        self, body: dict[str, Any], request_id: str
    ) -> dict[str, Any]: ...

    async def materials(self, body: dict[str, Any], request_id: str) -> dict[str, Any]: ...

    async def evidence_search(
        self, body: dict[str, Any], request_id: str
    ) -> dict[str, Any]: ...

    async def resolve_provenance(
        self, body: dict[str, Any], request_id: str
    ) -> dict[str, Any]: ...

    async def search_in_schema(
        self, body: dict[str, Any], request_id: str
    ) -> dict[str, Any]: ...


class SciverseGateway:
    def __init__(self, client: SciverseClient, *, cache_ttl_seconds: int = 300) -> None:
        self.client = client
        self.cache = AsyncTTLCache(cache_ttl_seconds)

    async def close(self) -> None:
        await self.client.close()

    async def capabilities(self, request_id: str) -> dict[str, Any]:
        return await self.cache.get_or_create(
            "capabilities",
            lambda: self.client.request_json(
                "GET", "/paper-schema", request_id=request_id
            ),
        )

    async def search_papers(
        self, body: dict[str, Any], request_id: str
    ) -> dict[str, Any]:
        key = f"search:{json.dumps(body, sort_keys=True, separators=(',', ':'))}"
        return await self.cache.get_or_create(
            key,
            lambda: self.client.request_json(
                "POST", "/paper-schema/search", request_id=request_id, json_body=body
            ),
        )

    async def paper(self, schema_id: str, request_id: str) -> dict[str, Any] | None:
        return await self.cache.get_or_create(
            f"paper:{schema_id}",
            lambda: self._load_paper(schema_id, request_id),
        )

    async def _load_paper(
        self, schema_id: str, request_id: str
    ) -> dict[str, Any] | None:
        result = await self.search_papers(
            {"filters": {"schema_ids": [schema_id]}, "size": 1}, request_id
        )
        items = result.get("items") or []
        return items[0] if items and isinstance(items[0], dict) else None

    async def entities(
        self, schema_id: str, request_id: str, *, max_items: int = 2000
    ) -> tuple[list[dict[str, Any]], bool]:
        path = f"/paper-schema/schemas/{quote(schema_id, safe='')}/entities"
        return await self.cache.get_or_create(
            f"entities:{schema_id}:{max_items}",
            lambda: self._paginate_get(path, request_id, max_items=max_items),
        )

    async def relations(
        self, schema_id: str, request_id: str, *, max_items: int = 3000
    ) -> tuple[list[dict[str, Any]], bool]:
        body = {
            "filters": {"schema_ids": [schema_id]},
            "include_context": "entities",
            "size": 100,
        }
        return await self.cache.get_or_create(
            f"relations:{schema_id}:{max_items}",
            lambda: self._paginate_post(
                "/paper-schema/relations/search",
                body,
                request_id,
                max_items=max_items,
            ),
        )

    async def citation_summary(self, schema_id: str, request_id: str) -> dict[str, Any]:
        return await self.cache.get_or_create(
            f"citation-summary:{schema_id}",
            lambda: self.client.request_json(
                "GET",
                f"/paper-schema/schemas/{quote(schema_id, safe='')}/citation-summary",
                request_id=request_id,
            ),
        )

    async def citations(
        self, schema_id: str, request_id: str, *, max_items: int = 2000
    ) -> tuple[list[dict[str, Any]], int, bool]:
        return await self.cache.get_or_create(
            f"citations:{schema_id}:{max_items}",
            lambda: self._load_citations(schema_id, request_id, max_items=max_items),
        )

    async def _load_citations(
        self, schema_id: str, request_id: str, *, max_items: int
    ) -> tuple[list[dict[str, Any]], int, bool]:
        path = f"/paper-schema/schemas/{quote(schema_id, safe='')}/citations"
        items, truncated, first = await self._paginate_get_detail(
            path, request_id, max_items=max_items
        )
        total_raw = first.get("total", len(items))
        total = int(total_raw) if isinstance(total_raw, (int, float)) else len(items)
        return items, total, truncated

    async def citation_graph(
        self,
        schema_id: str,
        request_id: str,
        *,
        direction: str,
        depth: int,
        max_nodes: int,
        max_edges: int,
    ) -> dict[str, Any]:
        key = (
            f"citation-graph:{schema_id}:{direction}:{depth}:{max_nodes}:{max_edges}"
        )
        return await self.cache.get_or_create(
            key,
            lambda: self.client.request_json(
                "GET",
                f"/paper-schema/schemas/{quote(schema_id, safe='')}/citation-graph",
                request_id=request_id,
                params={
                    "direction": direction,
                    "depth": depth,
                    "max_nodes": max_nodes,
                    "max_edges": max_edges,
                },
            ),
        )

    async def related_papers(
        self, schema_id: str, body: dict[str, Any], request_id: str
    ) -> dict[str, Any]:
        body_key = json.dumps(body, sort_keys=True, separators=(",", ":"))
        return await self.cache.get_or_create(
            f"related:{schema_id}:{body_key}",
            lambda: self.client.request_json(
                "POST",
                f"/paper-schema/schemas/{quote(schema_id, safe='')}/related-papers",
                request_id=request_id,
                json_body=body,
            ),
        )

    async def entity_related_papers(
        self, body: dict[str, Any], request_id: str
    ) -> dict[str, Any]:
        return await self.client.request_json(
            "POST",
            "/paper-schema/entities/related-papers",
            request_id=request_id,
            json_body=body,
        )

    async def materials(self, body: dict[str, Any], request_id: str) -> dict[str, Any]:
        return await self.client.request_json(
            "POST", "/paper-schema/materials", request_id=request_id, json_body=body
        )

    async def evidence_search(
        self, body: dict[str, Any], request_id: str
    ) -> dict[str, Any]:
        return await self.client.request_json(
            "POST",
            "/paper-schema/evidence/search",
            request_id=request_id,
            json_body=body,
        )

    async def resolve_provenance(
        self, body: dict[str, Any], request_id: str
    ) -> dict[str, Any]:
        return await self.client.request_json(
            "POST",
            "/paper-schema/resolve-provenance",
            request_id=request_id,
            json_body=body,
        )

    async def search_in_schema(
        self, body: dict[str, Any], request_id: str
    ) -> dict[str, Any]:
        return await self.client.request_json(
            "POST",
            "/paper-schema/search-in-schema",
            request_id=request_id,
            json_body=body,
        )

    async def _paginate_get(
        self, path: str, request_id: str, *, max_items: int
    ) -> tuple[list[dict[str, Any]], bool]:
        items, truncated, _ = await self._paginate_get_detail(
            path, request_id, max_items=max_items
        )
        return items, truncated

    async def _paginate_get_detail(
        self, path: str, request_id: str, *, max_items: int
    ) -> tuple[list[dict[str, Any]], bool, dict[str, Any]]:
        items: list[dict[str, Any]] = []
        cursor: str | None = None
        first: dict[str, Any] = {}
        while len(items) < max_items:
            payload = await self.client.request_json(
                "GET",
                path,
                request_id=request_id,
                params={
                    "size": min(100, max_items - len(items)),
                    **({"cursor": cursor} if cursor else {}),
                },
            )
            if not first:
                first = payload
            page = payload.get("items") or []
            items.extend(row for row in page if isinstance(row, dict))
            next_cursor = payload.get("next_cursor")
            if not next_cursor or not page:
                return items, False, first
            cursor = str(next_cursor)
        return items, bool(cursor), first

    async def _paginate_post(
        self,
        path: str,
        body: dict[str, Any],
        request_id: str,
        *,
        max_items: int,
    ) -> tuple[list[dict[str, Any]], bool]:
        items: list[dict[str, Any]] = []
        cursor: str | None = None
        while len(items) < max_items:
            request_body = {
                **body,
                "size": min(100, max_items - len(items)),
                **({"cursor": cursor} if cursor else {}),
            }
            payload = await self.client.request_json(
                "POST", path, request_id=request_id, json_body=request_body
            )
            page = payload.get("items") or []
            items.extend(row for row in page if isinstance(row, dict))
            next_cursor = payload.get("next_cursor")
            if not next_cursor or not page:
                return items, False
            cursor = str(next_cursor)
        return items, bool(cursor)
