from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class PublicModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NodeType(StrEnum):
    PAPER = "paper"
    ENTITY = "entity"
    REFERENCE = "reference"
    EVIDENCE = "evidence"


class EdgeType(StrEnum):
    INTERNAL_RELATION = "internal_relation"
    CITATION = "citation"
    RELATED_SUGGESTION = "related_suggestion"


class PaperCard(PublicModel):
    schema_id: str
    title: str
    abstract: str | None = None
    authors: list[str] = Field(default_factory=list)
    venue: str | None = None
    year: int | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    pdf_url: str | None = None
    external_url: str | None = None
    topics: list[str] = Field(default_factory=list)
    tasks: list[str] = Field(default_factory=list)
    research_problem: str | None = None
    central_contribution: str | None = None
    headline_result: str | None = None
    has_code: bool | None = None
    has_data: bool | None = None


class PaperReadingSource(PublicModel):
    requested_schema_id: str
    active_schema_id: str
    canonical_document: PaperCard
    active_document: PaperCard
    used_equivalent_version: bool = False
    active_reason: Literal[
        "requested_full_text",
        "equivalent_full_text",
        "full_text_unavailable",
    ]


class SourceAnchor(PublicModel):
    paragraph_id: str | None = None
    marker_num: int | None = Field(default=None, ge=0)


class GraphNode(PublicModel):
    id: str
    node_type: NodeType
    label: str
    subtitle: str | None = None
    schema_id: str
    entity_id: str | None = None
    entity_type: str | None = None
    entity_subtype: str | None = None
    section: str | None = None
    description: str | None = None
    anchors: list[SourceAnchor] = Field(default_factory=list)
    paper: PaperCard | None = None
    status: Literal["available", "unresolved", "partial"] = "available"


class GraphEdge(PublicModel):
    id: str
    edge_type: EdgeType
    source: str
    target: str
    label: str
    directed: bool = True
    relation_type: str | None = None
    citation_count: int | None = None
    score: float | None = Field(default=None, ge=0)
    reasons: list[str] = Field(default_factory=list)
    provenance_count: int = Field(default=0, ge=0)


class GraphStats(PublicModel):
    paper_nodes: int = Field(ge=0)
    entity_nodes: int = Field(ge=0)
    reference_nodes: int = Field(ge=0)
    internal_relations: int = Field(ge=0)
    citations: int = Field(ge=0)
    suggestions: int = Field(ge=0)


class GraphPayload(PublicModel):
    graph_id: str
    title: str
    description: str
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    stats: GraphStats
    warnings: list[str] = Field(default_factory=list)
    truncated: bool = False


class Coverage(PublicModel):
    current_focus: str
    paper_count: str
    empty_result_message: str


class ProductCapabilities(PublicModel):
    contract_version: str
    mode: Literal["unconfigured", "production"]
    coverage: Coverage
    resources: list[str]
    edge_types: list[EdgeType]
    limits: dict[str, int]


class ErrorDetail(PublicModel):
    code: str
    message: str
    retryable: bool = False
    request_id: str | None = None


class ErrorEnvelope(PublicModel):
    error: ErrorDetail


class TotalCount(PublicModel):
    value: int = Field(ge=0)
    relation: Literal["eq", "gte"] = "eq"


class PaperSearchResult(PublicModel):
    items: list[PaperCard]
    total: TotalCount
    next_cursor: str | None = None


class ReferenceCard(PublicModel):
    entity_id: str | None = None
    title: str
    authors: list[str] = Field(default_factory=list)
    year: int | None = None
    venue: str | None = None
    doi: str | None = None


class CitationResolution(PublicModel):
    status: Literal["resolved", "unresolved", "target_unavailable"]
    target_schema_id: str | None = None
    score: float | None = None


class CitationItem(PublicModel):
    relation_id: str
    reference: ReferenceCard | None = None
    resolution: CitationResolution
    target_paper: PaperCard | None = None


class CitationList(PublicModel):
    schema_id: str
    total: int = Field(ge=0)
    items: list[CitationItem]
    truncated: bool = False


class EvidenceItem(PublicModel):
    schema_id: str
    evidence_id: str
    groups: list[str] = Field(default_factory=list)
    key: str | None = None
    path: str | None = None
    path_bucket: str | None = None
    value_text: str | None = None
    value_number: float | None = None
    value_bool: bool | None = None
    marker_nums: list[int] = Field(default_factory=list)
    paragraph_ids: list[str] = Field(default_factory=list)


class EvidenceSearchResult(PublicModel):
    items: list[EvidenceItem]
    next_cursor: str | None = None
    fallback_recommended: bool = False


class ParagraphSegment(PublicModel):
    schema_id: str
    paragraph_id: str | None = None
    marker_num: int | None = None
    section: str | None = None
    section_path: str | None = None
    text: str
    match_role: Literal["target", "neighbor"] | None = None


class ProvenanceResult(PublicModel):
    segments: list[ParagraphSegment]
    returned: int = Field(ge=0)
    locator_method: Literal["provenance", "schema_local_search"] = "provenance"
    query: str | None = None


class ParagraphPage(PublicModel):
    schema_id: str
    source_schema_id: str | None = None
    source_document: PaperCard | None = None
    segments: list[ParagraphSegment]
    returned: int = Field(ge=0)
    next_marker: int | None = Field(default=None, ge=1)
    complete: bool = False


class GuideItem(PublicModel):
    order: int = Field(ge=1)
    schema_id: str
    title: str
    role: Literal["seed", "foundation", "expansion"]
    rationale: str


class QueryPlan(PublicModel):
    original_query: str
    search_queries: list[str]
    keywords: list[str] = Field(default_factory=list)
    language: Literal["zh", "en", "mixed", "other"]
    rewrite_source: Literal["none", "dictionary", "model"] = "none"
    warning: str | None = None


class ReadingGuide(PublicModel):
    query: str
    title: str
    summary: str
    items: list[GuideItem]
    scope_note: str
    caveats: list[str]
    generation_mode: Literal["deterministic", "model"] = "deterministic"
    model_warning: str | None = None


class PaperOverview(PublicModel):
    schema_id: str
    language: Literal["zh", "en"]
    summary: str
    why_read: str
    focus_points: list[str] = Field(default_factory=list, max_length=4)
    generation_mode: Literal["deterministic", "model"] = "deterministic"
    model_warning: str | None = None


class TopicExploration(PublicModel):
    graph: GraphPayload
    guide: ReadingGuide
    query_plan: QueryPlan
