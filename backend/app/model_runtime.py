from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field

from app.model_config import ModelConfigStore, ModelConnection
from app.models import (
    GraphPayload,
    GuideItem,
    PaperCard,
    PaperOverview,
    QueryPlan,
    ReadingGuide,
)

logger = logging.getLogger(__name__)


class ModelRuntimeError(RuntimeError):
    pass


class QueryRewritePayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    language: Literal["zh", "en", "mixed", "other"] = "other"
    search_queries: list[str] = Field(min_length=1, max_length=3)
    keywords: list[str] = Field(default_factory=list, max_length=12)


class GuidePayloadItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    schema_id: str
    role: Literal["seed", "foundation", "expansion"] = "expansion"
    rationale: str


class GuidePayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str
    summary: str
    items: list[GuidePayloadItem] = Field(default_factory=list, max_length=20)


class PaperOverviewPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    summary: str
    why_read: str
    focus_points: list[str] = Field(default_factory=list, max_length=4)


class ModelRuntime:
    def __init__(self, store: ModelConfigStore) -> None:
        self.store = store

    async def complete_json(
        self,
        *,
        system: str,
        user: str,
        max_tokens: int,
        connection: ModelConnection | None = None,
        request_timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        active_connection = connection or self.store.load()
        if not active_connection.configured or active_connection.api_key is None:
            raise ModelRuntimeError("model is not configured")
        url = f"{active_connection.base_url}/chat/completions"
        request_body: dict[str, Any] = {
            "model": active_connection.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0,
            "max_tokens": max_tokens,
            "thinking": {"type": "disabled"},
        }
        timeout_seconds = (
            request_timeout_seconds
            if request_timeout_seconds is not None
            else active_connection.timeout_seconds
        )
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(timeout_seconds),
                limits=httpx.Limits(max_connections=4, max_keepalive_connections=2),
            ) as client:
                response = await client.post(
                    url,
                    headers={
                        "Authorization": (f"Bearer {active_connection.api_key.get_secret_value()}"),
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                    },
                    json=request_body,
                )
                if response.status_code == 400 and _rejects_thinking_option(response):
                    request_body.pop("thinking")
                    response = await client.post(
                        url,
                        headers={
                            "Authorization": (
                                f"Bearer {active_connection.api_key.get_secret_value()}"
                            ),
                            "Accept": "application/json",
                            "Content-Type": "application/json",
                        },
                        json=request_body,
                    )
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise ModelRuntimeError("model endpoint is unreachable") from exc
        if response.is_error:
            raise ModelRuntimeError(f"model endpoint returned HTTP {response.status_code}")
        try:
            payload = response.json()
            choice = payload["choices"][0]
            content = choice["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise ModelRuntimeError("model endpoint returned an invalid response") from exc
        if not isinstance(content, str):
            raise ModelRuntimeError("model response did not contain text")
        if not content.strip() and choice.get("finish_reason") == "length":
            raise ModelRuntimeError("model exhausted max_tokens before returning final content")
        return _parse_json_object(content)

    async def test_connection(
        self,
        connection: ModelConnection | None = None,
    ) -> dict[str, object]:
        started = time.perf_counter()
        active_connection = connection or self.store.load()
        payload = await self.complete_json(
            system="Return JSON only.",
            user='Return exactly {"status":"ok"}.',
            max_tokens=32,
            connection=active_connection,
        )
        if payload.get("status") != "ok":
            raise ModelRuntimeError("model test returned an unexpected payload")
        return {
            "ok": True,
            "model": active_connection.model,
            "latency_ms": round((time.perf_counter() - started) * 1000),
        }


class QueryPlanner:
    def __init__(self, runtime: ModelRuntime) -> None:
        self.runtime = runtime

    async def plan(self, query: str) -> QueryPlan:
        normalized = " ".join(query.split())
        language = _language(normalized)
        fallback = _fallback_plan(normalized, language)
        connection = self.runtime.store.load()
        should_rewrite = language in {"zh", "mixed"} or _looks_like_question(normalized)
        if not connection.configured or not should_rewrite:
            return fallback
        try:
            raw = await self.runtime.complete_json(
                system=(
                    "You plan keyword retrieval over an English-language corpus of AI papers. "
                    "Return one JSON object only. Translate non-English input. Produce 1-3 short, "
                    "independent English search phrases. Each phrase must contain the minimum "
                    "technical terms needed for recall, not a full question. Do not answer the "
                    "question and do not invent citations."
                ),
                user=(
                    f"Research question:\n{normalized}\n\n"
                    'JSON schema: {"language":"zh|en|mixed|other",'
                    '"search_queries":["..."],"keywords":["..."]}'
                ),
                max_tokens=2048,
            )
            parsed = QueryRewritePayload.model_validate(raw)
            queries = _clean_queries(parsed.search_queries)
            if not queries:
                return fallback
            return QueryPlan(
                original_query=normalized,
                search_queries=queries,
                keywords=_clean_keywords(parsed.keywords),
                language=language,
                rewrite_source="model",
            )
        except (ModelRuntimeError, ValueError):
            return fallback.model_copy(
                update={
                    "warning": (
                        "Model query rewrite was unavailable; deterministic keyword "
                        "normalization was used."
                    )
                }
            )


class GuideGenerator:
    def __init__(self, runtime: ModelRuntime) -> None:
        self.runtime = runtime

    async def generate(
        self,
        graph: GraphPayload,
        query: str,
        fallback: ReadingGuide,
        response_language: Literal["zh", "en"] | None = None,
    ) -> ReadingGuide:
        connection = self.runtime.store.load()
        if not connection.configured:
            return fallback
        papers = [
            {
                "schema_id": node.schema_id,
                "title": node.label,
                "year": node.paper.year if node.paper else None,
                "topics": node.paper.topics[:5] if node.paper else [],
                "research_problem": (node.paper.research_problem if node.paper else None),
                "central_contribution": (node.paper.central_contribution if node.paper else None),
                "source_role": node.subtitle,
            }
            for node in graph.nodes
            if node.paper is not None
        ][:20]
        if not papers:
            return fallback
        node_catalog = {node.id: node for node in graph.nodes}
        paper_edges: list[dict[str, Any]] = []
        for edge in graph.edges:
            source = node_catalog.get(edge.source)
            target = node_catalog.get(edge.target)
            if source is None or target is None:
                continue
            if source.paper is None or target.paper is None:
                continue
            paper_edges.append(
                {
                    "source_schema_id": source.schema_id,
                    "source_title": source.label,
                    "source_year": source.paper.year,
                    "target_schema_id": target.schema_id,
                    "target_title": target.label,
                    "target_year": target.paper.year,
                    "edge_type": edge.edge_type,
                    "label": edge.label,
                    "reasons": edge.reasons[:3],
                }
            )
            if len(paper_edges) >= 60:
                break
        selected_language = response_language or (
            "zh" if _language(query) in {"zh", "mixed"} else "en"
        )
        output_language = "Chinese" if selected_language == "zh" else "English"
        try:
            raw = await self.runtime.complete_json(
                system=(
                    "Create a grounded reading guide and a compact 2-4 paragraph topic "
                    "relationship overview using only the supplied paper catalog and edges. "
                    "Never create paper IDs, titles, findings, paper contents, or chronology. "
                    "Do not infer a method, result, benchmark, or relevance claim that is not "
                    "explicitly supported by the supplied title, topics, research problem, "
                    "central contribution, source role, or edge. Explain why the papers belong "
                    "together and how their concerns differ. Describe an evolution or lineage "
                    "only when publication years and explicit citation edges support it. "
                    "A related_suggestion edge means thematic similarity or retrieval expansion, "
                    "not citation, historical influence, or factual chronology. Distinguish those "
                    "edge meanings in the summary. If support is weak, say so directly instead of "
                    "speculating. The output is an exploration aid, not a literature conclusion. "
                    "Use paper titles in reader-facing prose. Do not mention schema IDs or raw "
                    "edge labels such as related_suggestion outside the required schema_id fields. "
                    "Structure the summary as readable Markdown paragraphs covering topic scope, "
                    "major research branches, paper relationships, and a practical reading path. "
                    f"Write in {output_language}. Return one JSON object only."
                ),
                user=(
                    f"Question: {query}\n"
                    f"Paper catalog: {json.dumps(papers, ensure_ascii=False)}\n"
                    f"Paper edges: {json.dumps(paper_edges, ensure_ascii=False)}\n"
                    'JSON schema: {"title":"...","summary":"...",'
                    '"items":[{"schema_id":"exact supplied id",'
                    '"role":"seed|foundation|expansion","rationale":"..."}]}'
                ),
                max_tokens=4096,
                connection=connection,
                request_timeout_seconds=max(connection.timeout_seconds, 90),
            )
            parsed = GuidePayload.model_validate(raw)
        except (ModelRuntimeError, ValueError) as exc:
            logger.warning("topic guide model fallback: %s", exc)
            return fallback.model_copy(
                update={
                    "model_warning": (
                        ("模型导读未完成，当前展示基于 Schema 元数据和论文关系自动整理的导读。")
                        if selected_language == "zh"
                        else (
                            "The model guide did not complete; this guide was assembled "
                            "from Schema metadata and paper relationships."
                        )
                    )
                }
            )
        catalog = {node.schema_id: node for node in graph.nodes if node.paper is not None}
        items: list[GuideItem] = []
        seen: set[str] = set()
        for candidate in parsed.items:
            node = catalog.get(candidate.schema_id)
            if node is None or candidate.schema_id in seen:
                continue
            seen.add(candidate.schema_id)
            items.append(
                GuideItem(
                    order=len(items) + 1,
                    schema_id=candidate.schema_id,
                    title=node.label,
                    role=candidate.role,
                    rationale=_reader_facing_guide_text(
                        candidate.rationale,
                        selected_language,
                    )[:500],
                )
            )
        if not items:
            return fallback
        return fallback.model_copy(
            update={
                "title": parsed.title.strip()[:300] or fallback.title,
                "summary": (
                    _reader_facing_guide_text(parsed.summary, selected_language)[:1200]
                    or fallback.summary
                ),
                "items": items,
                "generation_mode": "model",
            }
        )

    async def generate_paper_overview(
        self,
        paper: PaperCard,
        graph: GraphPayload,
        fallback: PaperOverview,
        response_language: Literal["zh", "en"],
    ) -> PaperOverview:
        connection = self.runtime.store.load()
        if not connection.configured:
            return fallback
        output_language = "Chinese" if response_language == "zh" else "English"
        facts = {
            "schema_id": paper.schema_id,
            "title": paper.title,
            "abstract": paper.abstract,
            "authors": paper.authors,
            "venue": paper.venue,
            "year": paper.year,
            "topics": paper.topics[:8],
            "tasks": paper.tasks[:8],
            "research_problem": paper.research_problem,
            "central_contribution": paper.central_contribution,
            "headline_result": paper.headline_result,
            "has_code": paper.has_code,
            "has_data": paper.has_data,
        }
        entity_nodes = [
            {
                "entity_id": node.entity_id,
                "entity_type": node.entity_type,
                "entity_subtype": node.entity_subtype,
                "name": node.label,
                "description": (node.description[:240] if node.description else None),
                "section": node.section,
            }
            for node in graph.nodes
            if node.paper is None and node.node_type != "reference"
        ][:24]
        node_labels = {node.id: node.label for node in graph.nodes}
        internal_relations = [
            {
                "source": node_labels.get(edge.source, edge.source),
                "relation": edge.relation_type or edge.label,
                "target": node_labels.get(edge.target, edge.target),
            }
            for edge in graph.edges
            if edge.edge_type == "internal_relation"
        ][:32]
        schema_context = {
            "paper": facts,
            "entity_count": graph.stats.entity_nodes,
            "internal_relation_count": graph.stats.internal_relations,
            "representative_entities": entity_nodes,
            "representative_internal_relations": internal_relations,
        }
        try:
            raw = await self.runtime.complete_json(
                system=(
                    "Write a grounded overview of one paper using only the supplied compact "
                    "Paper Schema context: metadata, extracted Entities, and internal Relations. "
                    "The input intentionally contains no original paragraphs or full text. Do "
                    "not request, reconstruct, quote, or imply access to the original text. "
                    "Help a reader decide whether to continue into the paper. Summarize what "
                    "problem it addresses, what it contributes, and the likely reading payoff. "
                    "Never invent methods, results, datasets, benchmarks, limitations, or claims. "
                    "When a fact is missing, omit it. Preserve technical names in their source "
                    f"form while writing explanations in {output_language}. Return one JSON "
                    "object only."
                ),
                user=(
                    f"Paper Schema context: "
                    f"{json.dumps(schema_context, ensure_ascii=False)}\n"
                    'JSON schema: {"summary":"2-3 compact paragraphs",'
                    '"why_read":"one grounded decision-oriented paragraph",'
                    '"focus_points":["2-4 short grounded points"]}'
                ),
                max_tokens=3072,
                connection=connection,
                request_timeout_seconds=max(connection.timeout_seconds, 60),
            )
            parsed = PaperOverviewPayload.model_validate(raw)
        except (ModelRuntimeError, ValueError) as exc:
            logger.warning("paper overview model fallback: %s", exc)
            return fallback.model_copy(
                update={
                    "model_warning": (
                        (
                            "模型论文概述未完成，当前展示基于 Schema 元数据、"
                            "Entity 与 Relation 自动整理的概述。"
                        )
                        if response_language == "zh"
                        else (
                            "The model paper overview did not complete; this overview "
                            "was assembled from Schema metadata, Entities, and Relations."
                        )
                    )
                }
            )
        focus_points = [point.strip()[:500] for point in parsed.focus_points if point.strip()][:4]
        return fallback.model_copy(
            update={
                "summary": parsed.summary.strip()[:1800] or fallback.summary,
                "why_read": parsed.why_read.strip()[:900] or fallback.why_read,
                "focus_points": focus_points or fallback.focus_points,
                "generation_mode": "model",
            }
        )


def _parse_json_object(content: str) -> dict[str, Any]:
    stripped = content.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped, flags=re.IGNORECASE)
        stripped = re.sub(r"\s*```$", "", stripped)
    try:
        value = json.loads(stripped)
    except ValueError:
        start = stripped.find("{")
        end = stripped.rfind("}")
        if start < 0 or end <= start:
            raise ModelRuntimeError("model did not return JSON") from None
        try:
            value = json.loads(stripped[start : end + 1])
        except ValueError as exc:
            raise ModelRuntimeError("model returned malformed JSON") from exc
    if not isinstance(value, dict):
        raise ModelRuntimeError("model JSON must be an object")
    return value


def _reader_facing_guide_text(
    value: str,
    language: Literal["zh", "en"],
) -> str:
    replacements = (
        {
            "`related_suggestion`": "相关建议",
            "related_suggestion": "相关建议",
            "`citation`": "引用",
        }
        if language == "zh"
        else {
            "`related_suggestion`": "related suggestion",
            "related_suggestion": "related suggestion",
            "`citation`": "citation",
        }
    )
    cleaned = value.strip()
    for source, target in replacements.items():
        cleaned = cleaned.replace(source, target)
    return cleaned


def _rejects_thinking_option(response: httpx.Response) -> bool:
    message = response.text.lower()
    return "thinking" in message and any(
        marker in message
        for marker in ("unknown", "unsupported", "unrecognized", "extra", "unexpected")
    )


def _language(query: str) -> Literal["zh", "en", "mixed", "other"]:
    has_han = bool(re.search(r"[\u3400-\u9fff]", query))
    has_latin = bool(re.search(r"[A-Za-z]", query))
    if has_han and has_latin:
        return "mixed"
    if has_han:
        return "zh"
    if has_latin:
        return "en"
    return "other"


def _looks_like_question(query: str) -> bool:
    lowered = query.lower()
    return (
        len(query.split()) > 8
        or "?" in query
        or "？" in query
        or lowered.startswith(("what ", "how ", "which ", "why ", "can "))
    )


def _fallback_plan(
    query: str,
    language: Literal["zh", "en", "mixed", "other"],
) -> QueryPlan:
    rewritten = re.sub(
        r"^\s*(?:(?:请|麻烦)?帮我)?(?:学习|了解|搜索|查找|看看|看一下)\s*",
        "",
        query,
    )
    rewritten = re.sub(
        r"\s*相关(?:的|论文|研究|内容)?\s*$",
        "",
        rewritten,
    )
    rewritten = re.sub(
        r"(?i)(?<![A-Za-z])transform(?![A-Za-z])",
        "transformer",
        rewritten,
    )
    replacements = [
        ("大语言模型", "large language model"),
        ("大模型", "large language model"),
        ("语言模型", "language model"),
        ("上下文学习", "in-context learning"),
        ("知识图谱", "knowledge graph"),
        ("持续学习", "continual learning"),
        ("灾难性遗忘", "catastrophic forgetting"),
        ("推理速度", "inference acceleration"),
        ("模型推理", "model inference"),
        ("架构", "architecture"),
        ("多模态", "multimodal"),
        ("传统机器学习训练", "supervised machine learning training"),
        ("有哪些应用", "applications"),
        ("有哪些", ""),
        ("目前", ""),
        ("应该如何缓解", "mitigation"),
        ("有什么不同", "comparison"),
        ("的方法", ""),
        ("方法", "methods"),
    ]
    replacements.extend(
        [
            ("优化", "optimization"),
            ("提高", "improving"),
            ("应用", "applications"),
            ("研究", "research"),
        ]
    )
    for source, target in replacements:
        rewritten = rewritten.replace(source, f" {target} ")
    rewritten = re.sub(r"[，。！？、；：“”‘’（）]", " ", rewritten)
    rewritten = " ".join(rewritten.split())
    if language in {"zh", "mixed"} and re.search(r"[\u3400-\u9fff]", rewritten):
        rewritten = query
        warning = (
            "The query contains Chinese terms outside the local glossary. Configure a "
            "model endpoint for reliable English-corpus retrieval."
        )
    else:
        warning = None
    source: Literal["none", "dictionary", "model"] = "dictionary" if rewritten != query else "none"
    return QueryPlan(
        original_query=query,
        search_queries=[rewritten],
        keywords=[],
        language=language,
        rewrite_source=source,
        warning=warning,
    )


def _clean_queries(values: list[str]) -> list[str]:
    result = []
    for value in values:
        cleaned = " ".join(str(value).split())[:200]
        if cleaned and cleaned not in result:
            result.append(cleaned)
    return result[:3]


def _clean_keywords(values: list[str]) -> list[str]:
    result = []
    for value in values:
        cleaned = " ".join(str(value).split())[:100]
        if cleaned and cleaned not in result:
            result.append(cleaned)
    return result[:12]
