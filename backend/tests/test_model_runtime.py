from __future__ import annotations

import json

import pytest
import respx
from httpx import Response
from pydantic import SecretStr

from app.assembly import assemble_paper_graph
from app.guide import build_deterministic_guide
from app.model_config import ModelConfigStore, ModelConfigUpdate, ModelConnection
from app.model_runtime import (
    GuideGenerator,
    ModelRuntime,
    ModelRuntimeError,
    QueryPlanner,
)
from app.models import (
    GraphEdge,
    GraphNode,
    GraphPayload,
    GraphStats,
    PaperCard,
)


def test_model_config_is_owner_only_and_never_returns_secret(tmp_path) -> None:
    path = tmp_path / "nested" / "model.json"
    store = ModelConfigStore(
        path,
        ModelConnection(base_url="https://models.example/v1", model="demo"),
    )
    status = store.update(
        ModelConfigUpdate(
            base_url="https://models.example/v1",
            model="demo",
            api_key="unit-test-secret",
            timeout_seconds=12,
        )
    )

    assert status.configured is True
    assert status.api_key_set is True
    assert status.api_key_hint == "••••cret"
    assert "super-secret" not in status.model_dump_json()
    assert path.stat().st_mode & 0o777 == 0o600


@pytest.mark.asyncio
async def test_chinese_query_requires_configured_model(tmp_path) -> None:
    store = ModelConfigStore(
        tmp_path / "model.json",
        ModelConnection(base_url="https://models.example/v1", model="demo"),
    )
    with pytest.raises(ModelRuntimeError, match="not configured or enabled"):
        await QueryPlanner(ModelRuntime(store)).plan("大模型推理速度优化")


@pytest.mark.asyncio
async def test_mixed_transform_query_requires_configured_model(tmp_path) -> None:
    store = ModelConfigStore(
        tmp_path / "model.json",
        ModelConnection(base_url="https://models.example/v1", model="demo"),
    )
    with pytest.raises(ModelRuntimeError, match="not configured or enabled"):
        await QueryPlanner(ModelRuntime(store)).plan("学习transform架构相关")


@pytest.mark.asyncio
@respx.mock
async def test_model_draft_can_be_tested_without_persisting(tmp_path) -> None:
    path = tmp_path / "model.json"
    store = ModelConfigStore(
        path,
        ModelConnection(base_url="https://models.example/v1", model="stored"),
    )
    store.update(
        ModelConfigUpdate(
            base_url="https://models.example/v1",
            model="stored",
            api_key="stored-test-secret",
        )
    )
    saved_before_test = path.read_text()
    draft = store.resolve(
        ModelConfigUpdate(
            base_url="https://draft.example/v1",
            model="draft-model",
        )
    )
    respx.post("https://draft.example/v1/chat/completions").mock(
        return_value=Response(
            200,
            json={"choices": [{"message": {"content": '{"status":"ok"}'}}]},
        )
    )

    result = await ModelRuntime(store).test_connection(draft)

    assert result["ok"] is True
    assert result["model"] == "draft-model"
    assert draft.api_key is not None
    assert draft.api_key.get_secret_value() == "stored-test-secret"
    assert path.read_text() == saved_before_test
    assert store.status().model == "stored"


@pytest.mark.asyncio
@respx.mock
async def test_reasoning_only_length_response_has_clear_error(tmp_path) -> None:
    store = ModelConfigStore(
        tmp_path / "model.json",
        ModelConnection(
            base_url="https://models.example/v1",
            model="reasoning-model",
            api_key=SecretStr("test-value"),
        ),
    )
    respx.post("https://models.example/v1/chat/completions").mock(
        return_value=Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": "",
                            "reasoning_content": "unfinished reasoning",
                        },
                        "finish_reason": "length",
                    }
                ]
            },
        )
    )

    with pytest.raises(
        RuntimeError,
        match="exhausted max_tokens before returning final content",
    ):
        await ModelRuntime(store).complete_json(
            system="Return JSON only.",
            user="Plan this query.",
            max_tokens=32,
        )


@pytest.mark.asyncio
@respx.mock
async def test_model_retries_without_thinking_for_compatible_endpoint(tmp_path) -> None:
    store = ModelConfigStore(
        tmp_path / "model.json",
        ModelConnection(
            base_url="https://models.example/v1",
            model="standard-model",
            api_key=SecretStr("test-value"),
        ),
    )
    route = respx.post("https://models.example/v1/chat/completions").mock(
        side_effect=[
            Response(
                400,
                json={"error": {"message": "unknown field: thinking"}},
            ),
            Response(
                200,
                json={"choices": [{"message": {"content": '{"status":"ok"}'}}]},
            ),
        ]
    )

    result = await ModelRuntime(store).complete_json(
        system="Return JSON only.",
        user='Return exactly {"status":"ok"}.',
        max_tokens=32,
    )

    assert result == {"status": "ok"}
    assert route.call_count == 2
    first_body = route.calls[0].request.content
    second_body = route.calls[1].request.content
    assert b'"thinking"' in first_body
    assert b'"thinking"' not in second_body


def test_remote_plain_http_is_allowed_for_local_application() -> None:
    update = ModelConfigUpdate(
        base_url="http://models.example/v1",
        model="demo",
        api_key="test-key",
    )
    assert update.base_url == "http://models.example/v1"


@pytest.mark.asyncio
@respx.mock
async def test_model_query_rewrite_is_constrained_to_json_contract(tmp_path) -> None:
    store = ModelConfigStore(
        tmp_path / "model.json",
        ModelConnection(
            base_url="https://models.example/v1",
            model="demo",
            api_key=SecretStr("test-value"),
        ),
    )
    respx.post("https://models.example/v1/chat/completions").mock(
        return_value=Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": (
                                '{"language":"zh","search_queries":'
                                '["Transformer inference acceleration","KV cache optimization"],'
                                '"keywords":["Transformer","KV cache"]}'
                            )
                        }
                    }
                ]
            },
        )
    )

    plan = await QueryPlanner(ModelRuntime(store)).plan(
        "目前有哪些提高 Transformer 模型推理速度的方法？"
    )

    assert plan.rewrite_source == "model"
    assert plan.language == "mixed"
    assert plan.search_queries == [
        "Transformer inference acceleration",
        "KV cache optimization",
    ]
    assert plan.keywords == ["Transformer", "KV cache"]


@pytest.mark.asyncio
@respx.mock
async def test_paper_overview_uses_requested_language_and_grounded_contract(
    tmp_path,
) -> None:
    store = ModelConfigStore(
        tmp_path / "model.json",
        ModelConnection(
            base_url="https://models.example/v1",
            model="demo",
            api_key=SecretStr("test-value"),
        ),
    )
    route = respx.post("https://models.example/v1/chat/completions").mock(
        return_value=Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": (
                                '{"summary":"本文研究无训练架构搜索。",'
                                '"why_read":"适合了解零成本代理。",'
                                '"focus_points":["研究问题","核心贡献"]}'
                            )
                        }
                    }
                ]
            },
        )
    )
    paper = PaperCard(
        schema_id="paper-1",
        title="Training-Free Transformer Architecture Search",
        abstract="A grounded abstract.",
        research_problem="Reduce architecture-search cost.",
        central_contribution="A zero-cost proxy.",
    )
    graph = assemble_paper_graph(
        {
            "schema_id": paper.schema_id,
            "title": paper.title,
            "abstract": paper.abstract,
        },
        [
            {
                "entity_id": "component-1",
                "entity_type": "Component",
                "name": "Zero-cost proxy",
                "description": "A structured Entity description.",
            }
        ],
        [],
        entities_truncated=False,
        relations_truncated=False,
    )
    overview = await GuideGenerator(ModelRuntime(store)).generate_paper_overview(
        paper,
        graph,
        "zh",
    )

    assert overview.language == "zh"
    assert overview.generation_mode == "model"
    assert overview.summary == "本文研究无训练架构搜索。"
    request_body = json.loads(route.calls[0].request.content)
    system_prompt = request_body["messages"][0]["content"]
    assert "in Chinese" in system_prompt
    assert "Never invent methods, results, datasets" in system_prompt
    assert "no original paragraphs or full text" in system_prompt
    user_prompt = request_body["messages"][1]["content"]
    assert "Zero-cost proxy" in user_prompt
    assert "representative_entities" in user_prompt


def _topic_graph_fixture() -> GraphPayload:
    seed = PaperCard(
        schema_id="seed-paper",
        title="Efficient Transformer Search",
        year=2024,
        central_contribution="A zero-cost proxy for efficient Transformer architecture search.",
    )
    related = PaperCard(
        schema_id="related-paper",
        title="Variable Token Transformer",
        year=2022,
        research_problem="Reduce over-smoothing in multivariate time-series forecasting.",
    )
    return GraphPayload(
        graph_id="topic:transformer",
        title="Transformer evolution",
        description="Topic graph",
        nodes=[
            GraphNode(
                id="paper:seed-paper",
                node_type="paper",
                label=seed.title,
                subtitle="Seed paper",
                schema_id=seed.schema_id,
                paper=seed,
            ),
            GraphNode(
                id="paper:related-paper",
                node_type="paper",
                label=related.title,
                subtitle="Related paper",
                schema_id=related.schema_id,
                paper=related,
            ),
        ],
        edges=[
            GraphEdge(
                id="suggestion:seed:related",
                edge_type="related_suggestion",
                source="paper:seed-paper",
                target="paper:related-paper",
                label="related",
            ),
        ],
        stats=GraphStats(
            paper_nodes=2,
            entity_nodes=0,
            reference_nodes=0,
            internal_relations=0,
            citations=0,
            suggestions=1,
        ),
    )


def test_deterministic_topic_guide_explains_scope_branches_and_relationships() -> None:
    guide = build_deterministic_guide(
        _topic_graph_fixture(),
        "研究 Transformer 架构演变",
        "zh",
    )

    assert "**主题边界。**" in guide.summary
    assert "**主要研究入口。**" in guide.summary
    assert "A zero-cost proxy" in guide.summary
    assert "1 条相关建议" in guide.summary
    assert "**建议怎么读。**" in guide.summary
    assert "主题入口" in guide.items[0].rationale
    assert "A zero-cost proxy" in guide.items[0].rationale
    assert "表示主题相似而非引用" in guide.items[1].rationale


@pytest.mark.asyncio
@respx.mock
async def test_topic_guide_uses_long_task_timeout_and_reader_facing_contract(
    tmp_path,
) -> None:
    store = ModelConfigStore(
        tmp_path / "model.json",
        ModelConnection(
            base_url="https://models.example/v1",
            model="demo",
            api_key=SecretStr("test-value"),
            timeout_seconds=30,
        ),
    )
    route = respx.post("https://models.example/v1/chat/completions").mock(
        return_value=Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": (
                                '{"title":"Transformer 架构导读",'
                                '"summary":"**主题边界。** 两篇论文通过'
                                '`related_suggestion`扩展。",'
                                '"items":[{"schema_id":"seed-paper","role":"seed",'
                                '"rationale":"通过related_suggestion扩展。"}]}'
                            )
                        }
                    }
                ]
            },
        )
    )
    graph = _topic_graph_fixture()
    guide = await GuideGenerator(ModelRuntime(store)).generate(
        graph,
        "研究 Transformer 架构演变",
        "zh",
    )

    assert guide.generation_mode == "model"
    assert guide.model_warning is None
    assert "related_suggestion" not in guide.summary
    assert "相关建议" in guide.summary
    assert "related_suggestion" not in guide.items[0].rationale
    assert "相关建议" in guide.items[0].rationale
    timeout = route.calls[0].request.extensions["timeout"]
    assert timeout["read"] == 90
    request_body = json.loads(route.calls[0].request.content)
    system_prompt = request_body["messages"][0]["content"]
    assert "Do not mention schema IDs" in system_prompt
    assert "practical reading path" in system_prompt


@pytest.mark.asyncio
@respx.mock
async def test_topic_guide_model_failure_is_not_downgraded(tmp_path) -> None:
    store = ModelConfigStore(
        tmp_path / "model.json",
        ModelConnection(
            base_url="https://models.example/v1",
            model="demo",
            api_key=SecretStr("test-value"),
        ),
    )
    respx.post("https://models.example/v1/chat/completions").mock(
        return_value=Response(500, json={"error": {"message": "temporary"}})
    )
    graph = _topic_graph_fixture()
    with pytest.raises(ModelRuntimeError, match="HTTP 500"):
        await GuideGenerator(ModelRuntime(store)).generate(
            graph,
            "研究 Transformer 架构演变",
            "zh",
        )
