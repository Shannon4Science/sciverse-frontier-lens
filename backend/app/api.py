from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.responses import StreamingResponse

from app.assembly import (
    assemble_citation_graph,
    assemble_paper_graph,
    assemble_topic_graph,
    paper_card,
)
from app.gateway import PaperSchemaGateway
from app.model_config import ModelConfigStatus, ModelConfigStore, ModelConfigUpdate
from app.model_runtime import (
    GuideGenerator,
    ModelRuntime,
    ModelRuntimeError,
    QueryPlanner,
)
from app.models import (
    CitationList,
    EvidenceSearchResult,
    GraphPayload,
    PaperCard,
    PaperOverview,
    PaperReadingSource,
    PaperSearchResult,
    ParagraphPage,
    ProductCapabilities,
    ProvenanceResult,
    QueryPlan,
    ReadingGuide,
    TopicExploration,
)
from app.public_mapping import (
    map_citations,
    map_evidence,
    map_provenance,
    map_search_result,
)
from app.requests import (
    CitationGraphInput,
    EvidenceSearchInput,
    PaperSearchInput,
    ProvenanceInput,
    SchemaContextSearchInput,
    TopicGraphInput,
)
from app.sciverse_config import (
    SciverseConfigStatus,
    SciverseConfigStore,
    SciverseConfigUpdate,
    activate_sciverse_connection,
    build_gateway,
)

router = APIRouter(prefix="/api")
SchemaId = Annotated[str, Path(min_length=1, max_length=512)]


def gateway(request: Request) -> PaperSchemaGateway:
    service = request.app.state.gateway
    if service is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "Sciverse is not configured. Add a Sciverse API Base URL and "
                "key in Local Settings before requesting research data."
            ),
        )
    return service


def request_id(request: Request) -> str:
    return request.state.request_id


GatewayDependency = Annotated[PaperSchemaGateway, Depends(gateway)]

TOPIC_ENTITY_TYPE_PRIORITY = (
    "Problem",
    "Contribution",
    "Component",
    "ExperimentSetup",
    "Finding",
    "Dataset",
    "Task",
    "Measure",
    "Resource",
)


@dataclass(slots=True)
class SeedExpansion:
    related: dict[str, Any]
    citation: dict[str, Any]
    entities: list[dict[str, Any]]
    relations: list[dict[str, Any]]
    entities_truncated: bool
    relations_truncated: bool
    warnings: list[str]


ProgressEmitter = Callable[
    [str, str, str | None, dict[str, int | str] | None],
    Awaitable[None],
]

TITLE_TOKEN_RE = re.compile(r"[a-z0-9]+")
TITLE_STOP_WORDS = {
    "a",
    "an",
    "and",
    "for",
    "from",
    "in",
    "of",
    "on",
    "the",
    "to",
    "using",
    "via",
    "with",
}


def query_planner(request: Request) -> QueryPlanner:
    return request.app.state.query_planner


def guide_generator(request: Request) -> GuideGenerator:
    return request.app.state.guide_generator


def _paper_title_tokens(value: object) -> set[str]:
    return set(TITLE_TOKEN_RE.findall(str(value or "").casefold()))


def _paper_title_core_query(value: object) -> str:
    terms = [
        token
        for token in TITLE_TOKEN_RE.findall(str(value or "").casefold())
        if token not in TITLE_STOP_WORDS
    ]
    return " ".join(terms[:6])


def _paper_author_keys(value: object) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {
        " ".join(TITLE_TOKEN_RE.findall(str(author).casefold()))
        for author in value
        if author
    }


def _source_candidate_score(
    paper: dict[str, Any],
    candidate: dict[str, Any],
) -> float:
    paper_tokens = _paper_title_tokens(paper.get("title"))
    candidate_tokens = _paper_title_tokens(candidate.get("title"))
    if not paper_tokens or not candidate_tokens:
        return 0
    overlap = paper_tokens & candidate_tokens
    containment = len(overlap) / min(len(paper_tokens), len(candidate_tokens))
    union = paper_tokens | candidate_tokens
    jaccard = len(overlap) / len(union)

    paper_authors = _paper_author_keys(paper.get("authors"))
    candidate_authors = _paper_author_keys(candidate.get("authors"))
    author_overlap = (
        len(paper_authors & candidate_authors)
        / min(len(paper_authors), len(candidate_authors))
        if paper_authors and candidate_authors
        else 0
    )
    same_doi = bool(
        paper.get("doi")
        and candidate.get("doi")
        and str(paper["doi"]).casefold() == str(candidate["doi"]).casefold()
    )
    if not same_doi and (containment < 0.6 or author_overlap < 0.3):
        return 0
    access = candidate.get("access")
    has_open_pdf = bool(
        isinstance(access, dict)
        and access.get("oa_url")
    ) or str(candidate.get("doi") or "").casefold().startswith(
        "10.48550/arxiv.",
    )
    return (
        (100 if same_doi else 0)
        + containment * 50
        + jaccard * 25
        + author_overlap * 25
        + (5 if has_open_pdf else 0)
    )


async def _source_schema_candidates(
    service: PaperSchemaGateway,
    schema_id: str,
    rid: str,
) -> list[str]:
    paper = await service.paper(schema_id, rid)
    if not paper or not paper.get("title"):
        return []
    title = str(paper["title"])
    queries = list(dict.fromkeys([
        title,
        _paper_title_core_query(title),
    ]))
    candidate_rows: dict[str, dict[str, Any]] = {}
    for query in queries:
        if not query:
            continue
        result = await service.search_papers(
            {
                "query": query,
                "filters": {},
                "size": 20,
            },
            rid,
        )
        for candidate in result.get("items") or []:
            if isinstance(candidate, dict) and candidate.get("schema_id"):
                candidate_rows[str(candidate["schema_id"])] = candidate
    ranked: list[tuple[float, str]] = []
    for candidate in candidate_rows.values():
        candidate_id = candidate.get("schema_id")
        if not candidate_id or candidate_id == schema_id:
            continue
        score = _source_candidate_score(paper, candidate)
        if score:
            ranked.append((score, str(candidate_id)))
    ranked.sort(reverse=True)
    return [schema for _, schema in ranked[:5]]


async def _schema_has_paragraphs(
    service: PaperSchemaGateway,
    schema_id: str,
    rid: str,
) -> bool:
    try:
        raw = await service.resolve_provenance(
            {
                "schema_id": schema_id,
                "marker_nums": list(range(1, 101)),
                "window": 0,
                "max_segments": 1,
            },
            rid,
        )
    except Exception:
        return False
    return bool(raw.get("segments"))


def model_store(request: Request) -> ModelConfigStore:
    return request.app.state.model_store


def model_runtime(request: Request) -> ModelRuntime:
    return request.app.state.model_runtime


def require_model(request: Request) -> None:
    if not model_store(request).status().configured:
        raise HTTPException(
            status_code=503,
            detail=(
                "LLM is not configured or enabled. Configure an LLM Base URL, "
                "model, and API key in Local Settings before continuing."
            ),
        )


def sciverse_store(request: Request) -> SciverseConfigStore:
    return request.app.state.sciverse_store


@router.get("/capabilities", response_model=ProductCapabilities)
async def capabilities(request: Request) -> ProductCapabilities:
    return request.app.state.product_capabilities


@router.get("/settings/model", response_model=ModelConfigStatus)
async def model_settings(request: Request) -> ModelConfigStatus:
    return model_store(request).status()


@router.put("/settings/model", response_model=ModelConfigStatus)
async def update_model_settings(
    body: ModelConfigUpdate,
    request: Request,
) -> ModelConfigStatus:
    if not request.app.state.allow_local_model_config:
        raise HTTPException(status_code=403, detail="local model configuration is disabled")
    return model_store(request).update(body)


@router.post("/settings/model/test")
async def test_model_settings(
    body: ModelConfigUpdate,
    request: Request,
) -> dict[str, object]:
    if not request.app.state.allow_local_model_config:
        raise HTTPException(status_code=403, detail="local model configuration is disabled")
    try:
        connection = model_store(request).resolve(body)
        return await model_runtime(request).test_connection(connection)
    except ModelRuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/settings/sciverse", response_model=SciverseConfigStatus)
async def sciverse_settings(request: Request) -> SciverseConfigStatus:
    return sciverse_store(request).status()


@router.put("/settings/sciverse", response_model=SciverseConfigStatus)
async def update_sciverse_settings(
    body: SciverseConfigUpdate,
    request: Request,
) -> SciverseConfigStatus:
    if not request.app.state.allow_local_sciverse_config:
        raise HTTPException(
            status_code=403,
            detail="local Sciverse configuration is disabled",
        )
    status = sciverse_store(request).update(body)
    await activate_sciverse_connection(
        request.app,
        sciverse_store(request).load(),
    )
    return status


@router.post("/settings/sciverse/test")
async def test_sciverse_settings(
    body: SciverseConfigUpdate,
    request: Request,
) -> dict[str, object]:
    if not request.app.state.allow_local_sciverse_config:
        raise HTTPException(
            status_code=403,
            detail="local Sciverse configuration is disabled",
        )
    connection = sciverse_store(request).resolve(body)
    service = build_gateway(
        connection,
        cache_ttl_seconds=request.app.state.cache_ttl_seconds,
    )
    if service is None:
        raise HTTPException(
            status_code=400,
            detail="Sciverse connection requires an enabled API key",
        )
    started = time.perf_counter()
    try:
        capabilities = await service.capabilities(request_id(request))
        return {
            "ok": True,
            "mode": "production",
            "latency_ms": round((time.perf_counter() - started) * 1000),
            "contract_version": capabilities.get("contract_version"),
        }
    finally:
        close = getattr(service, "close", None)
        if close is not None:
            await close()


@router.post("/search", response_model=PaperSearchResult)
async def search(
    body: PaperSearchInput,
    request: Request,
    service: GatewayDependency,
) -> PaperSearchResult:
    upstream = body.upstream_body()
    if body.query:
        plan = await query_planner(request).plan(body.query)
        upstream["query"] = plan.search_queries[0]
    raw = await service.search_papers(upstream, request_id(request))
    return map_search_result(raw)


@router.get("/discovery-map", response_model=GraphPayload)
async def discovery_map(
    request: Request,
    service: GatewayDependency,
) -> GraphPayload:
    require_model(request)
    graph, _ = await _build_topic_graph(
        TopicGraphInput(
            query="large language models",
            seed_count=4,
            related_per_seed=3,
        ),
        request_id(request),
        service,
        query_planner(request),
    )
    return graph


@router.post("/topic-explore", response_model=TopicExploration)
async def topic_explore(
    body: TopicGraphInput,
    request: Request,
    service: GatewayDependency,
) -> TopicExploration:
    require_model(request)
    return await _run_topic_exploration(
        body,
        request_id(request),
        service,
        query_planner(request),
        guide_generator(request),
    )


@router.post("/topic-explore/stream")
async def topic_explore_stream(
    body: TopicGraphInput,
    request: Request,
    service: GatewayDependency,
) -> StreamingResponse:
    require_model(request)
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    current_step = "understand"
    started = time.perf_counter()

    async def emit(
        step: str,
        status: str,
        summary: str | None = None,
        metrics: dict[str, int | str] | None = None,
    ) -> None:
        nonlocal current_step
        if status == "running":
            current_step = step
        await queue.put({
            "type": "progress",
            "step": step,
            "status": status,
            "summary": summary,
            "metrics": metrics or {},
            "elapsed_ms": round((time.perf_counter() - started) * 1000),
        })

    async def produce() -> None:
        try:
            result = await _run_topic_exploration(
                body,
                request_id(request),
                service,
                query_planner(request),
                guide_generator(request),
                emit=emit,
            )
            await queue.put({
                "type": "result",
                "result": result.model_dump(mode="json"),
                "elapsed_ms": round((time.perf_counter() - started) * 1000),
            })
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await queue.put({
                "type": "error",
                "step": current_step,
                "message": str(exc) or "The exploration task failed.",
                "elapsed_ms": round((time.perf_counter() - started) * 1000),
            })
        finally:
            await queue.put(None)

    async def stream():
        producer = asyncio.create_task(produce())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
        finally:
            if not producer.done():
                producer.cancel()
            await asyncio.gather(producer, return_exceptions=True)

    return StreamingResponse(
        stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store"},
    )


async def _run_topic_exploration(
    body: TopicGraphInput,
    rid: str,
    service: PaperSchemaGateway,
    planner: QueryPlanner,
    guide_builder: GuideGenerator,
    *,
    emit: ProgressEmitter | None = None,
) -> TopicExploration:
    graph, plan = await _build_topic_graph(
        body,
        rid,
        service,
        planner,
        emit=emit,
    )
    await _emit_progress(
        emit,
        "guide",
        "running",
        "Generating a guide from the structured Schema graph; no full text is used.",
    )
    guide = await guide_builder.generate(
        graph,
        body.query or "Filtered paper set",
        body.response_language,
    )
    await _emit_progress(
        emit,
        "guide",
        "completed",
        "The reading guide is ready.",
        {"guide_papers": len(guide.items)},
    )
    return TopicExploration(graph=graph, guide=guide, query_plan=plan)


@router.post("/topic-graph", response_model=GraphPayload)
async def topic_graph(
    body: TopicGraphInput,
    request: Request,
    service: GatewayDependency,
) -> GraphPayload:
    require_model(request)
    graph, _ = await _build_topic_graph(
        body,
        request_id(request),
        service,
        query_planner(request),
    )
    return graph


@router.post("/topic-guide", response_model=ReadingGuide)
async def topic_guide(
    body: TopicGraphInput,
    request: Request,
    service: GatewayDependency,
) -> ReadingGuide:
    require_model(request)
    graph, _ = await _build_topic_graph(
        body,
        request_id(request),
        service,
        query_planner(request),
    )
    return await guide_generator(request).generate(
        graph,
        body.query or "Filtered paper set",
        body.response_language,
    )


async def _build_topic_graph(
    body: TopicGraphInput,
    rid: str,
    service: PaperSchemaGateway,
    planner: QueryPlanner,
    *,
    emit: ProgressEmitter | None = None,
) -> tuple[GraphPayload, QueryPlan]:
    query = body.query or "Filtered paper set"
    await _emit_progress(
        emit,
        "understand",
        "completed",
        "The research question has been validated.",
    )
    await _emit_progress(
        emit,
        "keywords",
        "running",
        "Planning concise academic search queries.",
    )
    plan = await planner.plan(query)
    await _emit_progress(
        emit,
        "keywords",
        "completed",
        "Search keywords are ready.",
        {
            "query_count": len(plan.search_queries),
            "keywords": " · ".join(plan.keywords or plan.search_queries),
        },
    )
    await _emit_progress(
        emit,
        "papers",
        "running",
        "Searching the Sciverse Paper Schema corpus.",
    )
    search_bodies: list[dict[str, object]] = []
    for search_query in plan.search_queries:
        search_body = body.upstream_body()
        search_body["query"] = search_query
        search_body["size"] = min(100, max(body.seed_count, body.seed_count * 2))
        search_body.pop("cursor", None)
        search_bodies.append(search_body)
    search_results = await asyncio.gather(
        *[service.search_papers(search_body, rid) for search_body in search_bodies],
        return_exceptions=True,
    )
    seeds: list[dict[str, object]] = []
    seen: set[str] = set()
    first_error: Exception | None = None
    for result in search_results:
        if isinstance(result, Exception):
            first_error = first_error or result
            continue
        for row in result.get("items") or []:
            if not isinstance(row, dict) or not row.get("schema_id"):
                continue
            schema_id = str(row["schema_id"])
            if schema_id in seen:
                continue
            seen.add(schema_id)
            seeds.append(row)
            if len(seeds) >= body.seed_count:
                break
        if len(seeds) >= body.seed_count:
            break
    if not seeds and first_error is not None:
        raise first_error
    await _emit_progress(
        emit,
        "papers",
        "completed",
        f"Found {len(seeds)} seed papers.",
        {"papers": len(seeds)},
    )
    await _emit_progress(
        emit,
        "expansion",
        "running",
        "Loading Entities, Relations, and Citations for the seed papers.",
        {"seeds": len(seeds)},
    )
    expansions = await asyncio.gather(
        *[
            _expand_seed(str(seed["schema_id"]), body, rid, service)
            for seed in seeds
        ]
    )
    expanded_entities = sum(len(result.entities) for result in expansions)
    expanded_relations = sum(len(result.relations) for result in expansions)
    await _emit_progress(
        emit,
        "expansion",
        "completed",
        "Seed-paper structure has been expanded.",
        {
            "entities": expanded_entities,
            "relations": expanded_relations,
        },
    )
    await _emit_progress(
        emit,
        "graph",
        "running",
        "Assembling the bounded topic graph.",
    )
    related_results = [result.related for result in expansions]
    citation_graphs = [result.citation for result in expansions]
    seed_graphs = [
        assemble_paper_graph(
            seed,
            expansion.entities,
            expansion.relations,
            entities_truncated=expansion.entities_truncated,
            relations_truncated=expansion.relations_truncated,
        )
        for seed, expansion in zip(seeds, expansions, strict=True)
    ]
    graph = assemble_topic_graph(
        query,
        seeds,
        related_results,
        citation_graphs,
        seed_graphs,
    )
    warnings = [
        *graph.warnings,
        *(warning for expansion in expansions for warning in expansion.warnings),
    ]
    if plan.warning:
        warnings.append(plan.warning)
    graph = graph.model_copy(update={"warnings": list(dict.fromkeys(warnings))})
    await _emit_progress(
        emit,
        "graph",
        "completed",
        "The topic graph is ready.",
        {
            "papers": graph.stats.paper_nodes,
            "nodes": len(graph.nodes),
            "edges": len(graph.edges),
        },
    )
    return graph, plan


async def _emit_progress(
    emit: ProgressEmitter | None,
    step: str,
    status: str,
    summary: str | None = None,
    metrics: dict[str, int | str] | None = None,
) -> None:
    if emit is not None:
        await emit(step, status, summary, metrics)


async def _expand_seed(
    schema_id: str,
    body: TopicGraphInput,
    rid: str,
    service: PaperSchemaGateway,
) -> SeedExpansion:
    related_task = (
        service.related_papers(
            schema_id,
            {
                "signals": body.signals,
                "exclude_same_work": True,
                "size": body.related_per_seed,
            },
            rid,
        )
        if body.related_per_seed
        else _empty_related()
    )
    entity_scan_limit = min(180, max(body.entities_per_seed * 3, 30))
    entities_task = (
        service.entities(schema_id, rid, max_items=entity_scan_limit)
        if body.entities_per_seed
        else _empty_rows()
    )
    relations_task = (
        service.relations(schema_id, rid, max_items=body.relations_per_seed)
        if body.relations_per_seed
        else _empty_rows()
    )
    related, citation, entities_result, relations_result = await asyncio.gather(
        related_task,
        service.citation_graph(
            schema_id,
            rid,
            direction="outbound",
            depth=1,
            max_nodes=max(10, body.related_per_seed * 4),
            max_edges=max(20, body.related_per_seed * 8),
        ),
        entities_task,
        relations_task,
        return_exceptions=True,
    )
    warnings: list[str] = []
    if isinstance(related, Exception):
        related = {
            "items": [],
            "warnings": ["Related-paper expansion was unavailable for one seed."],
        }
    if isinstance(citation, Exception):
        citation = {
            "root_schema_id": schema_id,
            "nodes": [],
            "edges": [],
            "warnings": ["Citation expansion was unavailable for one seed."],
        }
    if isinstance(entities_result, Exception):
        entities_result = ([], False)
        warnings.append(f"Entity expansion was unavailable for seed {schema_id}.")
    if isinstance(relations_result, Exception):
        relations_result = ([], False)
        warnings.append(f"Relation expansion was unavailable for seed {schema_id}.")
    entities, entities_truncated = entities_result
    relations, relations_truncated = relations_result
    selected_entities = _select_topic_entities(entities, body.entities_per_seed)
    return SeedExpansion(
        related=related,
        citation=citation,
        entities=selected_entities,
        relations=relations,
        entities_truncated=entities_truncated or len(entities) > len(selected_entities),
        relations_truncated=relations_truncated,
        warnings=warnings,
    )


async def _empty_related() -> dict[str, object]:
    return {"items": [], "warnings": []}


async def _empty_rows() -> tuple[list[dict[str, Any]], bool]:
    return [], False


def _select_topic_entities(
    rows: list[dict[str, Any]],
    limit: int,
) -> list[dict[str, Any]]:
    if limit <= 0:
        return []
    buckets: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        entity_type = str(row.get("entity_type") or "Entity")
        if entity_type == "Reference":
            continue
        buckets.setdefault(entity_type, []).append(row)
    order = [
        *[value for value in TOPIC_ENTITY_TYPE_PRIORITY if value in buckets],
        *sorted(value for value in buckets if value not in TOPIC_ENTITY_TYPE_PRIORITY),
    ]
    selected: list[dict[str, Any]] = []
    while len(selected) < limit:
        added = False
        for entity_type in order:
            bucket = buckets[entity_type]
            if not bucket:
                continue
            selected.append(bucket.pop(0))
            added = True
            if len(selected) >= limit:
                break
        if not added:
            break
    return selected


@router.get("/papers/{schema_id}/graph", response_model=GraphPayload)
async def paper_graph(
    schema_id: SchemaId,
    request: Request,
    service: GatewayDependency,
    max_entities: int = Query(default=2000, ge=1, le=5000),
    max_relations: int = Query(default=3000, ge=1, le=5000),
) -> GraphPayload:
    rid = request_id(request)
    paper = await service.paper(schema_id, rid)
    if paper is None:
        raise HTTPException(status_code=404, detail="paper not found")
    entities, entities_truncated = await service.entities(
        schema_id, rid, max_items=max_entities
    )
    relations, relations_truncated = await service.relations(
        schema_id, rid, max_items=max_relations
    )
    return assemble_paper_graph(
        paper,
        entities,
        relations,
        entities_truncated=entities_truncated,
        relations_truncated=relations_truncated,
    )


@router.get("/papers/{schema_id}", response_model=PaperCard)
async def paper_detail(
    schema_id: SchemaId,
    request: Request,
    service: GatewayDependency,
) -> PaperCard:
    paper = await service.paper(schema_id, request_id(request))
    if paper is None:
        raise HTTPException(status_code=404, detail="paper not found")
    return paper_card(paper)


@router.get("/papers/{schema_id}/overview", response_model=PaperOverview)
async def paper_overview(
    schema_id: SchemaId,
    request: Request,
    service: GatewayDependency,
    response_language: Literal["zh", "en"] = Query(default="en"),
) -> PaperOverview:
    require_model(request)
    paper = await service.paper(schema_id, request_id(request))
    if paper is None:
        raise HTTPException(status_code=404, detail="paper not found")
    entities, entities_truncated = await service.entities(
        schema_id,
        request_id(request),
        max_items=120,
    )
    relations, relations_truncated = await service.relations(
        schema_id,
        request_id(request),
        max_items=180,
    )
    public_paper = paper_card(paper)
    graph = assemble_paper_graph(
        paper,
        entities,
        relations,
        entities_truncated=entities_truncated,
        relations_truncated=relations_truncated,
    )
    return await guide_generator(request).generate_paper_overview(
        public_paper,
        graph,
        response_language,
    )


@router.get(
    "/papers/{schema_id}/reading-source",
    response_model=PaperReadingSource,
)
async def paper_reading_source(
    schema_id: SchemaId,
    request: Request,
    service: GatewayDependency,
) -> PaperReadingSource:
    rid = request_id(request)
    canonical = await service.paper(schema_id, rid)
    if canonical is None:
        raise HTTPException(status_code=404, detail="paper not found")

    active_id = schema_id
    active = canonical
    reason = "full_text_unavailable"
    if await _schema_has_paragraphs(service, schema_id, rid):
        reason = "requested_full_text"
    else:
        for candidate_id in await _source_schema_candidates(service, schema_id, rid):
            if not await _schema_has_paragraphs(service, candidate_id, rid):
                continue
            candidate = await service.paper(candidate_id, rid)
            if candidate is None:
                continue
            active_id = candidate_id
            active = candidate
            reason = "equivalent_full_text"
            break

    return PaperReadingSource(
        requested_schema_id=schema_id,
        active_schema_id=active_id,
        canonical_document=paper_card(canonical),
        active_document=paper_card(active),
        used_equivalent_version=active_id != schema_id,
        active_reason=reason,
    )


@router.get("/papers/{schema_id}/paragraphs", response_model=ParagraphPage)
async def paper_paragraphs(
    schema_id: SchemaId,
    request: Request,
    service: GatewayDependency,
    start_marker: int = Query(default=1, ge=1),
    size: int = Query(default=100, ge=1, le=100),
) -> ParagraphPage:
    marker_nums = list(range(start_marker, start_marker + size))
    rid = request_id(request)
    raw = await service.resolve_provenance(
        {
            "schema_id": schema_id,
            "marker_nums": marker_nums,
            "window": 0,
            "max_segments": size,
        },
        rid,
    )
    mapped = map_provenance(raw)
    source_schema_id = schema_id
    if mapped.returned == 0 and start_marker == 1:
        for candidate_id in await _source_schema_candidates(service, schema_id, rid):
            candidate_raw = await service.resolve_provenance(
                {
                    "schema_id": candidate_id,
                    "marker_nums": marker_nums,
                    "window": 0,
                    "max_segments": size,
                },
                rid,
            )
            candidate_mapped = map_provenance(candidate_raw)
            if candidate_mapped.returned:
                mapped = candidate_mapped
                source_schema_id = candidate_id
                break
    complete = mapped.returned == 0
    paragraphs = [
        segment.model_copy(update={"match_role": None})
        for segment in mapped.segments
    ]
    source_document = None
    if source_schema_id != schema_id:
        source_paper = await service.paper(source_schema_id, rid)
        if source_paper is not None:
            source_document = paper_card(source_paper)
    return ParagraphPage(
        schema_id=schema_id,
        source_schema_id=source_schema_id,
        source_document=source_document,
        segments=sorted(
            paragraphs,
            key=lambda segment: (
                segment.marker_num
                if segment.marker_num is not None
                else start_marker + size
            ),
        ),
        returned=mapped.returned,
        next_marker=None if complete else start_marker + size,
        complete=complete,
    )


@router.get("/papers/{schema_id}/citations", response_model=CitationList)
async def citations(
    schema_id: SchemaId,
    request: Request,
    service: GatewayDependency,
    max_items: int = Query(default=2000, ge=1, le=5000),
) -> CitationList:
    rows, total, truncated = await service.citations(
        schema_id, request_id(request), max_items=max_items
    )
    return map_citations(schema_id, rows, total=total, truncated=truncated)


@router.get("/papers/{schema_id}/citation-graph", response_model=GraphPayload)
async def citation_graph(
    schema_id: SchemaId,
    request: Request,
    service: GatewayDependency,
    direction: str = Query(default="outbound", pattern="^(outbound|inbound)$"),
    depth: int = Query(default=1, ge=1, le=3),
    max_nodes: int = Query(default=100, ge=2, le=500),
    max_edges: int = Query(default=200, ge=1, le=500),
) -> GraphPayload:
    options = CitationGraphInput(
        direction=direction, depth=depth, max_nodes=max_nodes, max_edges=max_edges
    )
    raw = await service.citation_graph(
        schema_id,
        request_id(request),
        direction=options.direction,
        depth=options.depth,
        max_nodes=options.max_nodes,
        max_edges=options.max_edges,
    )
    return assemble_citation_graph(raw)


@router.post("/evidence/search", response_model=EvidenceSearchResult)
async def evidence_search(
    body: EvidenceSearchInput,
    request: Request,
    service: GatewayDependency,
) -> EvidenceSearchResult:
    raw = await service.evidence_search(
        body.model_dump(exclude_none=True), request_id(request)
    )
    return map_evidence(raw)


@router.post("/provenance", response_model=ProvenanceResult)
async def provenance(
    body: ProvenanceInput,
    request: Request,
    service: GatewayDependency,
) -> ProvenanceResult:
    raw = await service.resolve_provenance(
        body.model_dump(exclude_none=True), request_id(request)
    )
    return map_provenance(raw)


@router.post(
    "/papers/{schema_id}/context-search",
    response_model=ProvenanceResult,
)
async def paper_context_search(
    schema_id: SchemaId,
    body: SchemaContextSearchInput,
    request: Request,
    service: GatewayDependency,
) -> ProvenanceResult:
    rid = request_id(request)
    raw = await service.search_in_schema(
        {
            "schema_id": schema_id,
            **body.model_dump(exclude_none=True),
        },
        rid,
    )
    mapped = map_provenance(
        raw,
        locator_method="schema_local_search",
        query=body.query,
    )
    if mapped.returned:
        return mapped
    for candidate_id in await _source_schema_candidates(service, schema_id, rid):
        candidate_raw = await service.search_in_schema(
            {
                "schema_id": candidate_id,
                **body.model_dump(exclude_none=True),
            },
            rid,
        )
        candidate_mapped = map_provenance(
            candidate_raw,
            locator_method="schema_local_search",
            query=body.query,
        )
        if candidate_mapped.returned:
            return candidate_mapped
    return mapped
