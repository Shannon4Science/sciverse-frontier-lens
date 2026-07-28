from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PaperSearchInput(StrictRequest):
    query: str | None = Field(default=None, min_length=1, max_length=500)
    published_year_gte: int | None = Field(default=None, ge=1800, le=2200)
    published_year_lte: int | None = Field(default=None, ge=1800, le=2200)
    has_code: bool | None = None
    has_data: bool | None = None
    size: int = Field(default=20, ge=1, le=100)
    cursor: str | None = None

    @model_validator(mode="after")
    def require_query_or_filter(self) -> PaperSearchInput:
        if not any([
            self.query,
            self.published_year_gte,
            self.published_year_lte,
            self.has_code is not None,
            self.has_data is not None,
        ]):
            raise ValueError("query or at least one filter is required")
        return self

    def upstream_body(self) -> dict[str, object]:
        filters = {
            key: value
            for key, value in {
                "published_year_gte": self.published_year_gte,
                "published_year_lte": self.published_year_lte,
                "has_code": self.has_code,
                "has_data": self.has_data,
            }.items()
            if value is not None
        }
        return {
            **({"query": self.query} if self.query else {}),
            "filters": filters,
            "size": self.size,
            **({"cursor": self.cursor} if self.cursor else {}),
        }


class CitationGraphInput(StrictRequest):
    direction: Literal["outbound", "inbound"] = "outbound"
    depth: int = Field(default=1, ge=1, le=3)
    max_nodes: int = Field(default=100, ge=2, le=500)
    max_edges: int = Field(default=200, ge=1, le=500)


class EvidenceSearchInput(StrictRequest):
    groups: list[str] = Field(min_length=1, max_length=5)
    schema_ids: list[str] = Field(default_factory=list, max_length=100)
    query: str | None = Field(default=None, min_length=1, max_length=500)
    size: int = Field(default=20, ge=1, le=100)
    cursor: str | None = None

    @model_validator(mode="after")
    def require_scope(self) -> EvidenceSearchInput:
        if not self.schema_ids and not self.query:
            raise ValueError("schema_ids or query is required")
        return self


class ProvenanceInput(StrictRequest):
    schema_id: str | None = Field(default=None, min_length=1, max_length=512)
    marker_nums: list[int] = Field(default_factory=list, max_length=100)
    paragraph_ids: list[str] = Field(default_factory=list, max_length=50)
    window: int = Field(default=1, ge=0, le=3)
    max_segments: int = Field(default=20, ge=1, le=100)

    @model_validator(mode="after")
    def require_locator(self) -> ProvenanceInput:
        marker_mode = bool(self.schema_id and self.marker_nums)
        paragraph_mode = bool(self.paragraph_ids)
        if marker_mode == paragraph_mode:
            raise ValueError(
                "use exactly one mode: schema_id + marker_nums, or paragraph_ids"
            )
        if self.marker_nums and not self.schema_id:
            raise ValueError("marker_nums requires schema_id")
        return self


class SchemaContextSearchInput(StrictRequest):
    query: str = Field(min_length=1, max_length=500)
    section_hint: str | None = Field(default=None, max_length=300)
    top_k: int = Field(default=5, ge=1, le=20)
    window: int = Field(default=1, ge=0, le=3)


class TopicGraphInput(PaperSearchInput):
    seed_count: int = Field(default=5, ge=1, le=10)
    related_per_seed: int = Field(default=5, ge=0, le=10)
    entities_per_seed: int = Field(default=30, ge=0, le=60)
    relations_per_seed: int = Field(default=60, ge=0, le=120)
    response_language: Literal["zh", "en"] | None = None
    signals: list[Literal["term", "entity", "citation"]] = Field(
        default_factory=lambda: ["term", "entity", "citation"],
        min_length=1,
        max_length=3,
    )
