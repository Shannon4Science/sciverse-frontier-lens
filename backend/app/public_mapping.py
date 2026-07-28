from __future__ import annotations

import ast
from typing import Any, Literal, cast

from app.assembly import paper_card
from app.models import (
    CitationItem,
    CitationList,
    CitationResolution,
    EvidenceItem,
    EvidenceSearchResult,
    PaperSearchResult,
    ParagraphSegment,
    ProvenanceResult,
    ReferenceCard,
    TotalCount,
)


def map_search_result(raw: dict[str, Any]) -> PaperSearchResult:
    items = [
        paper_card(row)
        for row in raw.get("items") or []
        if isinstance(row, dict) and row.get("schema_id")
    ]
    total_raw = raw.get("total")
    if isinstance(total_raw, dict):
        total = TotalCount(
            value=_int(total_raw.get("value")) or 0,
            relation="gte" if total_raw.get("relation") == "gte" else "eq",
        )
    else:
        total = TotalCount(value=_int(total_raw) or len(items))
    return PaperSearchResult(
        items=items,
        total=total,
        next_cursor=_text(raw.get("next_cursor")),
    )


def map_citations(
    schema_id: str,
    rows: list[dict[str, Any]],
    *,
    total: int,
    truncated: bool,
) -> CitationList:
    items: list[CitationItem] = []
    for row in rows:
        relation = row.get("relation") if isinstance(row.get("relation"), dict) else {}
        relation_id = str(relation.get("relation_id") or "")
        resolution_raw = (
            row.get("resolution") if isinstance(row.get("resolution"), dict) else {}
        )
        status = str(resolution_raw.get("status") or "unresolved")
        if status not in {"resolved", "unresolved", "target_unavailable"}:
            status = "unresolved"
        reference_raw = row.get("reference")
        reference = (
            ReferenceCard(
                entity_id=_text(reference_raw.get("entity_id")),
                title=str(
                    reference_raw.get("title")
                    or reference_raw.get("name")
                    or reference_raw.get("text")
                    or "Untitled reference"
                ),
                authors=_strings(reference_raw.get("authors")),
                year=_int(reference_raw.get("year")),
                venue=_text(reference_raw.get("venue")),
                doi=_text(reference_raw.get("doi")),
            )
            if isinstance(reference_raw, dict)
            else None
        )
        target_raw = row.get("target_schema")
        target = (
            paper_card(target_raw)
            if isinstance(target_raw, dict) and target_raw.get("schema_id")
            else None
        )
        items.append(CitationItem(
            relation_id=relation_id or f"reference:{len(items)}",
            reference=reference,
            resolution=CitationResolution(
                status=cast(
                    Literal["resolved", "unresolved", "target_unavailable"], status
                ),
                target_schema_id=_text(resolution_raw.get("target_schema_id")),
                score=_float(resolution_raw.get("score")),
            ),
            target_paper=target,
        ))
    return CitationList(
        schema_id=schema_id,
        total=total,
        items=items,
        truncated=truncated,
    )


def map_evidence(raw: dict[str, Any]) -> EvidenceSearchResult:
    items: list[EvidenceItem] = []
    for row in raw.get("items") or []:
        if not isinstance(row, dict):
            continue
        schema_id = str(row.get("schema_id") or "")
        evidence_id = str(row.get("attribute_id") or "")
        if not schema_id or not evidence_id:
            continue
        marker_nums: list[int] = []
        paragraph_ids: list[str] = _strings(row.get("paragraph_ids"))
        provenance = row.get("provenance")
        if isinstance(provenance, list):
            for locator in provenance:
                if isinstance(locator, dict):
                    marker = _int(locator.get("marker_num"))
                    paragraph = _text(locator.get("paragraph_id"))
                    if marker is not None:
                        marker_nums.append(marker)
                    if paragraph:
                        paragraph_ids.append(paragraph)
                elif isinstance(locator, str) and locator.startswith("§"):
                    marker = _int(locator.removeprefix("§"))
                    if marker is not None:
                        marker_nums.append(marker)
        items.append(EvidenceItem(
            schema_id=schema_id,
            evidence_id=evidence_id,
            groups=_strings(row.get("hot_groups")),
            key=_text(row.get("key")),
            path=_text(row.get("path")),
            path_bucket=_text(row.get("path_bucket")),
            value_text=_text(row.get("value_text")),
            value_number=_float(row.get("value_number")),
            value_bool=row.get("value_bool") if isinstance(row.get("value_bool"), bool) else None,
            marker_nums=sorted(set(marker_nums)),
            paragraph_ids=list(dict.fromkeys(paragraph_ids)),
        ))
    return EvidenceSearchResult(
        items=items,
        next_cursor=_text(raw.get("next_cursor")),
        fallback_recommended=bool(raw.get("fallback_recommended")),
    )


def map_provenance(
    raw: dict[str, Any],
    *,
    locator_method: Literal["provenance", "schema_local_search"] = "provenance",
    query: str | None = None,
) -> ProvenanceResult:
    segments: list[ParagraphSegment] = []
    for row in raw.get("segments") or []:
        if not isinstance(row, dict) or not row.get("schema_id") or not row.get("text"):
            continue
        role = row.get("match_role")
        segments.append(ParagraphSegment(
            schema_id=str(row["schema_id"]),
            paragraph_id=_text(row.get("paragraph_id")),
            marker_num=_int(row.get("marker_num")),
            section=_text(row.get("section")),
            section_path=_section_path(row.get("section_path")),
            text=str(row["text"]),
            match_role=role if role in {"target", "neighbor"} else None,
        ))
    return ProvenanceResult(
        segments=segments,
        returned=len(segments),
        locator_method=locator_method,
        query=query,
    )


def _text(value: Any) -> str | None:
    return None if value in (None, "", [], {}) else str(value)


def _section_path(value: Any) -> str | None:
    parts: object = value
    if isinstance(value, str) and value.lstrip().startswith("["):
        try:
            parts = ast.literal_eval(value)
        except (SyntaxError, ValueError):
            parts = value
    if isinstance(parts, (list, tuple)):
        normalized = [
            str(part).strip()
            for part in parts
            if part not in (None, "")
        ]
        return " / ".join(normalized) or None
    return _text(parts)


def _strings(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if item not in (None, "")]
    return [str(value)] if value not in (None, "") else []


def _int(value: Any) -> int | None:
    try:
        return int(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _float(value: Any) -> float | None:
    try:
        return float(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None
