from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.local_config import LocalConfigDocument
from app.main import app
from app.model_config import ModelConfigStore, ModelConfigUpdate, ModelConnection
from app.model_runtime import (
    GuideGenerator,
    ModelRuntime,
    ModelRuntimeError,
    QueryPlanner,
)
from app.models import QueryPlan, ReadingGuide
from app.requests import ProvenanceInput, TopicGraphInput
from app.sciverse_config import SciverseConfigStore, SciverseConnection

client = TestClient(app)


@pytest.fixture(autouse=True)
def isolate_unconfigured_application(tmp_path) -> None:
    document = LocalConfigDocument(tmp_path / "local.config.json")
    model_store = ModelConfigStore(
        document,
        ModelConnection(base_url="https://models.example/v1", model="test"),
    )
    runtime = ModelRuntime(model_store)
    app.state.model_store = model_store
    app.state.model_runtime = runtime
    app.state.query_planner = QueryPlanner(runtime)
    app.state.guide_generator = GuideGenerator(runtime)
    app.state.sciverse_store = SciverseConfigStore(
        document,
        SciverseConnection(base_url="https://api.example.test"),
    )
    app.state.gateway = None
    app.state.product_capabilities = app.state.product_capabilities.model_copy(
        update={"mode": "unconfigured"}
    )


def configure_model() -> None:
    app.state.model_store.update(
        ModelConfigUpdate(
            base_url="https://models.example/v1",
            model="test",
            api_key="unit-test-key",
        )
    )


def test_healthz() -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_capabilities_exposes_public_semantics_without_data() -> None:
    response = client.get("/api/capabilities")
    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "unconfigured"
    assert body["coverage"]["paper_count"] == "1M+"
    assert body["edge_types"] == [
        "internal_relation",
        "citation",
        "related_suggestion",
    ]
    assert "opensearch" not in response.text.lower()


def test_runtime_has_no_demo_graph_route() -> None:
    response = client.get("/api/demo-graph")
    assert response.status_code == 404


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("GET", "/api/discovery-map", None),
        ("POST", "/api/search", {"query": "test"}),
        ("POST", "/api/topic-graph", {"query": "test"}),
        ("GET", "/api/papers/unknown", None),
        ("GET", "/api/papers/unknown/graph", None),
        ("GET", "/api/papers/unknown/paragraphs", None),
        ("GET", "/api/papers/unknown/citations", None),
        ("GET", "/api/papers/unknown/citation-graph", None),
        (
            "POST",
            "/api/papers/unknown/context-search",
            {"query": "attention mechanism"},
        ),
        ("POST", "/api/evidence/search", {"schema_ids": ["unknown"]}),
        ("POST", "/api/provenance", {"paragraph_ids": ["unknown"]}),
    ],
)
def test_research_routes_fail_closed_without_sciverse(
    method: str,
    path: str,
    payload: dict[str, object] | None,
) -> None:
    response = client.request(method, path, json=payload)
    assert response.status_code == 503
    assert "not configured" in response.json()["detail"]


def test_topic_structure_limits_are_bounded_by_contract() -> None:
    with pytest.raises(ValidationError):
        TopicGraphInput(
            query="test",
            entities_per_seed=61,
            relations_per_seed=60,
        )


def test_provenance_contract_rejects_raw_access() -> None:
    with pytest.raises(ValidationError):
        ProvenanceInput.model_validate(
            {"schema_id": "unknown", "raw": True}
        )


def test_request_body_limit_returns_safe_error() -> None:
    response = client.post(
        "/api/search",
        content=b"x" * 262_145,
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "REQUEST_TOO_LARGE"


def test_local_config_status_does_not_return_keys() -> None:
    sciverse = client.get("/api/settings/sciverse")
    model = client.get("/api/settings/model")

    assert sciverse.status_code == 200
    assert model.status_code == 200
    assert sciverse.json()["configured"] is False
    assert model.json()["configured"] is False
    assert "api_key" not in sciverse.json()
    assert "api_key" not in model.json()


def test_sciverse_draft_test_does_not_save_or_activate_connection(
    monkeypatch,
    tmp_path,
) -> None:
    observed: dict[str, object] = {}

    class DraftGateway:
        async def capabilities(self, request_id: str) -> dict[str, str]:
            observed["request_id"] = request_id
            return {"contract_version": "draft-test"}

        async def close(self) -> None:
            observed["closed"] = True

    def fake_build_gateway(connection, *, cache_ttl_seconds: int):
        observed["base_url"] = connection.base_url
        observed["api_key"] = connection.api_key.get_secret_value()
        observed["cache_ttl_seconds"] = cache_ttl_seconds
        return DraftGateway()

    monkeypatch.setattr("app.api.build_gateway", fake_build_gateway)
    config_path = tmp_path / "local.config.json"
    app.state.sciverse_store = SciverseConfigStore(
        config_path,
        SciverseConnection(base_url="https://api.example.test"),
    )

    response = client.post(
        "/api/settings/sciverse/test",
        json={
            "enabled": True,
            "base_url": "https://draft.sciverse.test",
            "api_key": "draft-test-value",
            "clear_api_key": False,
            "timeout_seconds": 17,
        },
    )

    assert response.status_code == 200
    assert response.json()["contract_version"] == "draft-test"
    assert observed["base_url"] == "https://draft.sciverse.test"
    assert observed["api_key"] == "draft-test-value"
    assert observed["closed"] is True
    assert app.state.gateway is None
    assert not config_path.exists()


def test_context_search_maps_segments_and_marks_approximate_locator() -> None:
    class ContextGateway:
        async def search_in_schema(
            self,
            body: dict[str, object],
            request_id: str,
        ) -> dict[str, object]:
            assert body == {
                "schema_id": "paper-1",
                "query": "attention mechanism",
                "top_k": 5,
                "window": 1,
            }
            assert request_id
            return {
                "segments": [
                    {
                        "schema_id": "paper-1",
                        "paragraph_id": "paragraph-12",
                        "marker_num": 12,
                        "section": "Method",
                        "section_path": "3 Method / 3.2 Attention",
                        "text": "We use a multi-head attention mechanism.",
                        "match_role": "target",
                        "raw_path": "must-not-leak",
                    }
                ]
            }

    app.state.gateway = ContextGateway()
    response = client.post(
        "/api/papers/paper-1/context-search",
        json={"query": "attention mechanism"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "segments": [
            {
                "schema_id": "paper-1",
                "paragraph_id": "paragraph-12",
                "marker_num": 12,
                "section": "Method",
                "section_path": "3 Method / 3.2 Attention",
                "text": "We use a multi-head attention mechanism.",
                "match_role": "target",
            }
        ],
        "returned": 1,
        "locator_method": "schema_local_search",
        "query": "attention mechanism",
    }
    assert "raw_path" not in response.text


def test_topic_exploration_stream_reports_real_stage_events() -> None:
    class TopicGateway:
        async def search_papers(
            self,
            body: dict[str, object],
            request_id: str,
        ) -> dict[str, object]:
            return {
                "items": [{
                    "schema_id": "paper-1",
                    "title": "Attention Paper",
                    "authors": ["A. Researcher"],
                    "year": 2024,
                }]
            }

        async def related_papers(
            self,
            schema_id: str,
            body: dict[str, object],
            request_id: str,
        ) -> dict[str, object]:
            return {"items": [], "warnings": []}

        async def citation_graph(
            self,
            schema_id: str,
            request_id: str,
            *,
            direction: str,
            depth: int,
            max_nodes: int,
            max_edges: int,
        ) -> dict[str, object]:
            return {
                "root_schema_id": schema_id,
                "nodes": [],
                "edges": [],
                "truncated": False,
            }

        async def entities(
            self,
            schema_id: str,
            request_id: str,
            *,
            max_items: int,
        ) -> tuple[list[dict[str, object]], bool]:
            return ([{
                "entity_id": "entity-1",
                "entity_type": "Component",
                "name": "Attention",
                "provenance": ["§12"],
            }], False)

        async def relations(
            self,
            schema_id: str,
            request_id: str,
            *,
            max_items: int,
        ) -> tuple[list[dict[str, object]], bool]:
            return ([], False)

    class TopicPlanner:
        async def plan(self, query: str) -> QueryPlan:
            return QueryPlan(
                original_query=query,
                search_queries=["transformer architecture"],
                keywords=["transformer", "architecture"],
                language="en",
                rewrite_source="model",
            )

    class TopicGuide:
        async def generate(
            self,
            graph,
            query: str,
            response_language: str,
        ) -> ReadingGuide:
            return ReadingGuide(
                query=query,
                title="Transformer reading path",
                summary="A model-generated guide grounded in the returned graph.",
                items=[{
                    "order": 1,
                    "schema_id": "paper-1",
                    "title": "Attention Paper",
                    "role": "seed",
                    "rationale": "Start with the retrieved seed.",
                }],
                scope_note="Current Paper Schema corpus only.",
                caveats=[],
                generation_mode="model",
            )

    configure_model()
    app.state.gateway = TopicGateway()
    app.state.query_planner = TopicPlanner()
    app.state.guide_generator = TopicGuide()
    response = client.post(
        "/api/topic-explore/stream",
        json={
            "query": "transformer architecture",
            "seed_count": 1,
            "related_per_seed": 0,
            "entities_per_seed": 10,
            "relations_per_seed": 10,
            "response_language": "en",
        },
    )

    assert response.status_code == 200
    events = [json.loads(line) for line in response.text.splitlines()]
    progress = [
        (event["step"], event["status"])
        for event in events
        if event["type"] == "progress"
    ]
    assert progress == [
        ("understand", "completed"),
        ("keywords", "running"),
        ("keywords", "completed"),
        ("papers", "running"),
        ("papers", "completed"),
        ("expansion", "running"),
        ("expansion", "completed"),
        ("graph", "running"),
        ("graph", "completed"),
        ("guide", "running"),
        ("guide", "completed"),
    ]
    result = events[-1]["result"]
    assert events[-1]["type"] == "result"
    assert result["graph"]["stats"]["paper_nodes"] == 1
    assert result["graph"]["stats"]["entity_nodes"] == 1
    assert result["graph"]["nodes"][1]["anchors"] == [
        {"paragraph_id": None, "marker_num": 12}
    ]


def test_topic_exploration_stream_stops_on_model_failure() -> None:
    class FailingPlanner:
        async def plan(self, query: str) -> QueryPlan:
            raise ModelRuntimeError("model endpoint is unreachable")

    configure_model()
    app.state.gateway = object()
    app.state.query_planner = FailingPlanner()

    response = client.post(
        "/api/topic-explore/stream",
        json={"query": "transformer architecture", "response_language": "en"},
    )

    assert response.status_code == 200
    events = [json.loads(line) for line in response.text.splitlines()]
    assert events[-1]["type"] == "error"
    assert events[-1]["step"] == "keywords"
    assert events[-1]["message"] == "model endpoint is unreachable"
    assert all(event["type"] != "result" for event in events)


def test_paper_paragraphs_reads_an_ordered_public_marker_batch() -> None:
    class ParagraphGateway:
        async def resolve_provenance(
            self,
            body: dict[str, object],
            request_id: str,
        ) -> dict[str, object]:
            assert body["schema_id"] == "paper-1"
            assert body["marker_nums"] == list(range(101, 106))
            assert body["window"] == 0
            assert body["max_segments"] == 5
            return {
                "segments": [
                    {
                        "schema_id": "paper-1",
                        "paragraph_id": "paragraph::paper-1::000102",
                        "marker_num": 102,
                        "section_path": "['3 Language models', 'Attention']",
                        "text": "Second paragraph",
                    },
                    {
                        "schema_id": "paper-1",
                        "paragraph_id": "paragraph::paper-1::000101",
                        "marker_num": 101,
                        "text": "First paragraph",
                    },
                ]
            }

    app.state.gateway = ParagraphGateway()
    response = client.get(
        "/api/papers/paper-1/paragraphs",
        params={"start_marker": 101, "size": 5},
    )

    assert response.status_code == 200
    body = response.json()
    assert [row["marker_num"] for row in body["segments"]] == [101, 102]
    assert body["segments"][1]["section_path"] == "3 Language models / Attention"
    assert all(row["match_role"] is None for row in body["segments"])
    assert body["next_marker"] == 106
    assert body["complete"] is False
    assert "raw" not in response.text


def test_reading_source_selects_one_equivalent_version_with_full_text() -> None:
    current_id = "journal-paper"
    source_id = "arxiv-paper"

    class ReadableVersionGateway:
        async def paper(
            self,
            schema_id: str,
            request_id: str,
        ) -> dict[str, object] | None:
            if schema_id == source_id:
                return {
                    "schema_id": source_id,
                    "title": "Training-free Transformer Architecture Search",
                    "authors": ["Qinqin Zhou", "Kekai Sheng"],
                    "doi": "10.48550/arxiv.2203.12217",
                    "access": {
                        "oa_url": ["https://arxiv.org/pdf/2203.12217"],
                    },
                }
            assert schema_id == current_id
            return {
                "schema_id": current_id,
                "title": (
                    "Training-Free Transformer Architecture Search With "
                    "Zero-Cost Proxy Guided Evolution"
                ),
                "authors": ["Qinqin Zhou", "Kekai Sheng"],
                "doi": "10.1109/tpami.2024.3378781",
            }

        async def search_papers(
            self,
            body: dict[str, object],
            request_id: str,
        ) -> dict[str, object]:
            return {
                "items": [{
                    "schema_id": source_id,
                    "title": "Training-free Transformer Architecture Search",
                    "authors": ["Qinqin Zhou", "Kekai Sheng"],
                    "doi": "10.48550/arxiv.2203.12217",
                }]
            }

        async def resolve_provenance(
            self,
            body: dict[str, object],
            request_id: str,
        ) -> dict[str, object]:
            if body["schema_id"] == source_id:
                return {
                    "segments": [{
                        "schema_id": source_id,
                        "paragraph_id": f"paragraph::{source_id}::000001",
                        "marker_num": 1,
                        "text": "Readable source text",
                    }]
                }
            return {"segments": []}

    app.state.gateway = ReadableVersionGateway()
    response = client.get(f"/api/papers/{current_id}/reading-source")

    assert response.status_code == 200
    body = response.json()
    assert body["requested_schema_id"] == current_id
    assert body["active_schema_id"] == source_id
    assert body["used_equivalent_version"] is True
    assert body["active_reason"] == "equivalent_full_text"
    assert body["canonical_document"]["doi"] == "10.1109/tpami.2024.3378781"
    assert body["active_document"]["arxiv_id"] == "2203.12217"
    assert body["active_document"]["pdf_url"] == (
        "https://arxiv.org/pdf/2203.12217"
    )


def test_paper_overview_requires_model_configuration() -> None:
    app.state.gateway = object()

    response = client.get(
        "/api/papers/paper-1/overview?response_language=zh"
    )

    assert response.status_code == 503
    assert "LLM is not configured or enabled" in response.json()["detail"]


def test_paper_overview_returns_terminal_model_failure() -> None:
    class OverviewGateway:
        async def paper(
            self,
            schema_id: str,
            request_id: str,
        ) -> dict[str, object] | None:
            return {
                "schema_id": schema_id,
                "title": "Training-Free Transformer Architecture Search",
            }

        async def entities(
            self,
            schema_id: str,
            request_id: str,
            *,
            max_items: int,
        ) -> tuple[list[dict[str, object]], bool]:
            return ([], False)

        async def relations(
            self,
            schema_id: str,
            request_id: str,
            *,
            max_items: int,
        ) -> tuple[list[dict[str, object]], bool]:
            return ([], False)

    class FailingGuide:
        async def generate_paper_overview(self, *args, **kwargs):
            raise ModelRuntimeError("model endpoint is unreachable")

    configure_model()
    app.state.gateway = OverviewGateway()
    app.state.guide_generator = FailingGuide()

    response = client.get(
        "/api/papers/paper-1/overview?response_language=en"
    )

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "MODEL_REQUEST_FAILED"
    assert response.json()["error"]["message"] == "model endpoint is unreachable"


def test_paper_paragraphs_uses_an_equivalent_source_version_when_needed() -> None:
    current_id = "journal-paper"
    source_id = "conference-paper"

    class VersionedParagraphGateway:
        async def resolve_provenance(
            self,
            body: dict[str, object],
            request_id: str,
        ) -> dict[str, object]:
            if body["schema_id"] == source_id:
                return {
                    "segments": [{
                        "schema_id": source_id,
                        "paragraph_id": f"paragraph::{source_id}::000001",
                        "marker_num": 1,
                        "text": "Equivalent conference version text",
                    }]
                }
            return {"segments": []}

        async def paper(
            self,
            schema_id: str,
            request_id: str,
        ) -> dict[str, object] | None:
            if schema_id == source_id:
                return {
                    "schema_id": source_id,
                    "title": "Training-free Transformer Architecture Search",
                    "authors": ["Qinqin Zhou", "Kekai Sheng"],
                    "doi": "10.48550/arxiv.2203.12217",
                    "access": {
                        "oa_url": ["https://arxiv.org/pdf/2203.12217"],
                    },
                }
            assert schema_id == current_id
            return {
                "schema_id": current_id,
                "title": (
                    "Training-Free Transformer Architecture Search With "
                    "Zero-Cost Proxy Guided Evolution"
                ),
                "authors": ["Qinqin Zhou", "Kekai Sheng"],
            }

        async def search_papers(
            self,
            body: dict[str, object],
            request_id: str,
        ) -> dict[str, object]:
            return {
                "items": [{
                    "schema_id": source_id,
                    "title": "Training-free Transformer Architecture Search",
                    "authors": ["Qinqin Zhou", "Kekai Sheng"],
                }]
            }

    app.state.gateway = VersionedParagraphGateway()
    response = client.get(f"/api/papers/{current_id}/paragraphs")

    assert response.status_code == 200
    body = response.json()
    assert body["schema_id"] == current_id
    assert body["source_schema_id"] == source_id
    assert body["source_document"]["arxiv_id"] == "2203.12217"
    assert body["source_document"]["pdf_url"] == (
        "https://arxiv.org/pdf/2203.12217"
    )
    assert body["segments"][0]["schema_id"] == source_id
    assert body["segments"][0]["text"] == "Equivalent conference version text"


def test_context_search_uses_an_equivalent_source_version_when_needed() -> None:
    current_id = "journal-paper"
    source_id = "conference-paper"

    class VersionedContextGateway:
        async def search_in_schema(
            self,
            body: dict[str, object],
            request_id: str,
        ) -> dict[str, object]:
            if body["schema_id"] == source_id:
                return {
                    "segments": [{
                        "schema_id": source_id,
                        "paragraph_id": f"paragraph::{source_id}::000019",
                        "marker_num": 19,
                        "text": "Synaptic diversity is used by the proxy.",
                        "match_role": "target",
                    }]
                }
            return {"segments": []}

        async def paper(
            self,
            schema_id: str,
            request_id: str,
        ) -> dict[str, object] | None:
            return {
                "schema_id": current_id,
                "title": (
                    "Training-Free Transformer Architecture Search With "
                    "Zero-Cost Proxy Guided Evolution"
                ),
                "authors": ["Qinqin Zhou", "Kekai Sheng"],
            }

        async def search_papers(
            self,
            body: dict[str, object],
            request_id: str,
        ) -> dict[str, object]:
            return {
                "items": [{
                    "schema_id": source_id,
                    "title": "Training-free Transformer Architecture Search",
                    "authors": ["Qinqin Zhou", "Kekai Sheng"],
                }]
            }

    app.state.gateway = VersionedContextGateway()
    response = client.post(
        f"/api/papers/{current_id}/context-search",
        json={"query": "synaptic diversity"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["returned"] == 1
    assert body["segments"][0]["schema_id"] == source_id
    assert body["locator_method"] == "schema_local_search"
