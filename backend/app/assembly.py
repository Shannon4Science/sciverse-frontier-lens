from __future__ import annotations

import re
from typing import Any

from app.models import (
    EdgeType,
    GraphEdge,
    GraphNode,
    GraphPayload,
    GraphStats,
    NodeType,
    PaperCard,
    SourceAnchor,
)

ARXIV_ID_RE = re.compile(r"(?<!\d)(\d{4}\.\d{4,5})(v\d+)?", re.IGNORECASE)


def paper_card(raw: dict[str, Any]) -> PaperCard:
    authors = raw.get("authors") or []
    if not isinstance(authors, list):
        authors = [str(authors)]
    doi = _text(raw.get("doi"))
    arxiv_id = _arxiv_id(raw, doi)
    pdf_url = _pdf_url(raw, arxiv_id)
    return PaperCard(
        schema_id=str(raw.get("schema_id") or ""),
        title=str(raw.get("title") or raw.get("bibliographic_title") or "Untitled paper"),
        abstract=_text(raw.get("abstract")),
        authors=[str(value) for value in authors if value],
        venue=_text(raw.get("venue") or raw.get("schema_venue")),
        year=_int(raw.get("year") or raw.get("schema_year")),
        doi=doi,
        arxiv_id=arxiv_id,
        pdf_url=pdf_url,
        external_url=pdf_url or (f"https://doi.org/{doi}" if doi else None),
        topics=_strings(raw.get("topics") or raw.get("bibliographic_topic_names")),
        tasks=_strings(raw.get("tasks")),
        research_problem=_text(raw.get("research_problem")),
        central_contribution=_text(raw.get("central_contribution")),
        headline_result=_text(raw.get("headline_result")),
        has_code=_bool(raw.get("has_code")),
        has_data=_bool(raw.get("has_data")),
    )


def _arxiv_id(raw: dict[str, Any], doi: str | None) -> str | None:
    if doi and doi.casefold().startswith("10.48550/arxiv."):
        return doi[len("10.48550/arxiv."):]
    match = ARXIV_ID_RE.search(str(raw.get("schema_id") or ""))
    return "".join(match.groups(default="")) if match else None


def _pdf_url(raw: dict[str, Any], arxiv_id: str | None) -> str | None:
    access = raw.get("access")
    urls: list[str] = []
    if isinstance(access, dict):
        value = access.get("oa_url")
        if isinstance(value, list):
            urls.extend(str(item) for item in value)
        elif value:
            urls.append(str(value))
    for url in urls:
        if url.startswith("https://") and "/pdf/" in url:
            return url
    return f"https://arxiv.org/pdf/{arxiv_id}" if arxiv_id else None


def assemble_paper_graph(
    paper_raw: dict[str, Any],
    entities: list[dict[str, Any]],
    relations: list[dict[str, Any]],
    *,
    entities_truncated: bool,
    relations_truncated: bool,
) -> GraphPayload:
    paper = paper_card(paper_raw)
    paper_node_id = f"paper:{paper.schema_id}"
    nodes = [
        GraphNode(
            id=paper_node_id,
            node_type=NodeType.PAPER,
            label=paper.title,
            subtitle="Paper",
            schema_id=paper.schema_id,
            paper=paper,
        )
    ]
    known_entities: set[str] = set()
    reference_count = 0
    for row in entities:
        entity_id = str(row.get("entity_id") or "")
        if not entity_id:
            continue
        known_entities.add(entity_id)
        entity_type = _text(row.get("entity_type"))
        is_reference = entity_type == "Reference"
        reference_count += int(is_reference)
        nodes.append(GraphNode(
            id=_entity_node_id(paper.schema_id, entity_id),
            node_type=NodeType.REFERENCE if is_reference else NodeType.ENTITY,
            label=_entity_label(row),
            subtitle=" · ".join(filter(None, [entity_type, _text(row.get("entity_subtype"))])),
            schema_id=paper.schema_id,
            entity_id=entity_id,
            entity_type=entity_type,
            entity_subtype=_text(row.get("entity_subtype")),
            section=_text(row.get("section")),
            description=_text(row.get("description") or row.get("text")),
            anchors=_source_anchors(row.get("provenance")),
            status="unresolved" if is_reference else "available",
        ))
    edges: list[GraphEdge] = []
    for row in relations:
        relation_id = str(row.get("relation_id") or "")
        source_id = str(row.get("source_entity_id") or "")
        target_id = str(row.get("target_entity_id") or "")
        if not relation_id or source_id not in known_entities or target_id not in known_entities:
            continue
        relation_type = str(row.get("relation_type") or "related")
        provenance = row.get("provenance")
        edges.append(GraphEdge(
            id=f"relation:{paper.schema_id}:{relation_id}",
            edge_type=EdgeType.INTERNAL_RELATION,
            source=_entity_node_id(paper.schema_id, source_id),
            target=_entity_node_id(paper.schema_id, target_id),
            label=relation_type,
            relation_type=relation_type,
            provenance_count=len(provenance) if isinstance(provenance, list) else 0,
        ))
    warnings = []
    if entities_truncated:
        warnings.append("Entity results reached the configured safety limit.")
    if relations_truncated:
        warnings.append("Relation results reached the configured safety limit.")
    return GraphPayload(
        graph_id=f"paper:{paper.schema_id}",
        title=paper.title,
        description="Paper-scoped entities and factual internal relations.",
        nodes=nodes,
        edges=edges,
        stats=GraphStats(
            paper_nodes=1,
            entity_nodes=max(0, len(nodes) - 1 - reference_count),
            reference_nodes=reference_count,
            internal_relations=len(edges),
            citations=0,
            suggestions=0,
        ),
        warnings=warnings,
        truncated=entities_truncated or relations_truncated,
    )


def assemble_citation_graph(raw: dict[str, Any]) -> GraphPayload:
    nodes: list[GraphNode] = []
    known: set[str] = set()
    for row in raw.get("nodes") or []:
        if not isinstance(row, dict):
            continue
        schema_id = str(row.get("schema_id") or "")
        if not schema_id:
            continue
        card_raw = row.get("schema_paper")
        card = paper_card(card_raw) if isinstance(card_raw, dict) else None
        known.add(schema_id)
        nodes.append(GraphNode(
            id=f"paper:{schema_id}",
            node_type=NodeType.PAPER,
            label=card.title if card else schema_id,
            subtitle="Citation graph paper",
            schema_id=schema_id,
            paper=card,
            status="available" if card else "partial",
        ))
    edges: list[GraphEdge] = []
    for row in raw.get("edges") or []:
        if not isinstance(row, dict):
            continue
        source = str(row.get("source_schema_id") or "")
        target = str(row.get("target_schema_id") or "")
        edge_id = str(row.get("edge_id") or f"{source}:{target}")
        if source not in known or target not in known:
            continue
        edges.append(GraphEdge(
            id=f"citation:{edge_id}",
            edge_type=EdgeType.CITATION,
            source=f"paper:{source}",
            target=f"paper:{target}",
            label="cites",
            citation_count=_int(row.get("citation_count")) or 1,
        ))
    return GraphPayload(
        graph_id=f"citation:{raw.get('root_schema_id', '')}:{raw.get('direction', 'outbound')}",
        title="Resolved citation graph",
        description="Paper-to-paper edges resolved within the current Sciverse corpus.",
        nodes=nodes,
        edges=edges,
        stats=GraphStats(
            paper_nodes=len(nodes),
            entity_nodes=0,
            reference_nodes=0,
            internal_relations=0,
            citations=len(edges),
            suggestions=0,
        ),
        warnings=[],
        truncated=bool(raw.get("truncated")),
    )


def assemble_topic_graph(
    query: str,
    seeds: list[dict[str, Any]],
    related_results: list[dict[str, Any]],
    citation_graphs: list[dict[str, Any]],
    seed_graphs: list[GraphPayload] | None = None,
) -> GraphPayload:
    cards: dict[str, PaperCard] = {}
    seed_ids: list[str] = []
    for row in seeds:
        card = paper_card(row)
        if not card.schema_id:
            continue
        cards[card.schema_id] = card
        seed_ids.append(card.schema_id)

    suggestion_edges: dict[str, GraphEdge] = {}
    warnings: list[str] = []
    for seed_id, result in zip(seed_ids, related_results, strict=False):
        warnings.extend(_strings(result.get("warnings")))
        for row in result.get("items") or []:
            if not isinstance(row, dict):
                continue
            candidate_id = str(row.get("schema_id") or "")
            candidate_raw = row.get("schema_paper")
            if not candidate_id or not isinstance(candidate_raw, dict):
                continue
            cards.setdefault(candidate_id, paper_card(candidate_raw))
            edge_id = f"suggestion:{seed_id}:{candidate_id}"
            suggestion_edges[edge_id] = GraphEdge(
                id=edge_id,
                edge_type=EdgeType.RELATED_SUGGESTION,
                source=f"paper:{seed_id}",
                target=f"paper:{candidate_id}",
                label="related",
                score=_float(row.get("score")),
                reasons=_strings(row.get("reasons")),
            )

    citation_edges: dict[str, GraphEdge] = {}
    for graph in citation_graphs:
        for row in graph.get("nodes") or []:
            if not isinstance(row, dict):
                continue
            schema_id = str(row.get("schema_id") or "")
            card_raw = row.get("schema_paper")
            if schema_id and isinstance(card_raw, dict):
                cards.setdefault(schema_id, paper_card(card_raw))
        for row in graph.get("edges") or []:
            if not isinstance(row, dict):
                continue
            source = str(row.get("source_schema_id") or "")
            target = str(row.get("target_schema_id") or "")
            if source not in cards or target not in cards:
                continue
            raw_edge_id = str(row.get("edge_id") or f"{source}:{target}")
            edge_id = f"citation:{raw_edge_id}"
            citation_edges[edge_id] = GraphEdge(
                id=edge_id,
                edge_type=EdgeType.CITATION,
                source=f"paper:{source}",
                target=f"paper:{target}",
                label="cites",
                citation_count=_int(row.get("citation_count")) or 1,
            )

    paper_nodes = [
        GraphNode(
            id=f"paper:{schema_id}",
            node_type=NodeType.PAPER,
            label=card.title,
            subtitle="Seed paper" if schema_id in seed_ids else "Related paper",
            schema_id=schema_id,
            paper=card,
        )
        for schema_id, card in cards.items()
    ]
    structure_nodes: dict[str, GraphNode] = {}
    structure_edges: dict[str, GraphEdge] = {}
    reference_count = 0
    structure_warnings: list[str] = []
    structure_truncated = False
    for seed_graph in seed_graphs or []:
        structure_warnings.extend(seed_graph.warnings)
        structure_truncated = structure_truncated or seed_graph.truncated
        for node in seed_graph.nodes:
            if node.node_type == NodeType.PAPER:
                continue
            structure_nodes[node.id] = node
        for edge in seed_graph.edges:
            structure_edges[edge.id] = edge
    reference_count = sum(
        node.node_type == NodeType.REFERENCE for node in structure_nodes.values()
    )
    nodes = [*paper_nodes, *structure_nodes.values()]
    edges = [
        *suggestion_edges.values(),
        *citation_edges.values(),
        *structure_edges.values(),
    ]
    return GraphPayload(
        graph_id=f"topic:{query}",
        title=query,
        description=(
            "A bounded paper graph assembled from keyword seeds, explained related-paper "
            "suggestions, and resolved citation edges."
        ),
        nodes=nodes,
        edges=edges,
        stats=GraphStats(
            paper_nodes=len(paper_nodes),
            entity_nodes=max(0, len(structure_nodes) - reference_count),
            reference_nodes=reference_count,
            internal_relations=len(structure_edges),
            citations=len(citation_edges),
            suggestions=len(suggestion_edges),
        ),
        warnings=list(dict.fromkeys([*warnings, *structure_warnings])),
        truncated=(
            structure_truncated
            or any(bool(graph.get("truncated")) for graph in citation_graphs)
        ),
    )


def _entity_node_id(schema_id: str, entity_id: str) -> str:
    return f"entity:{schema_id}:{entity_id}"


def _entity_label(row: dict[str, Any]) -> str:
    return str(
        row.get("title")
        or row.get("name")
        or row.get("text")
        or row.get("description")
        or row.get("entity_id")
        or "Entity"
    )[:240]


def _source_anchors(value: Any) -> list[SourceAnchor]:
    locators = value if isinstance(value, list) else [value]
    anchors: list[SourceAnchor] = []
    seen: set[tuple[str | None, int | None]] = set()
    for locator in locators:
        paragraph_id: str | None = None
        marker_num: int | None = None
        if isinstance(locator, dict):
            paragraph_id = _text(locator.get("paragraph_id"))
            marker_num = _int(locator.get("marker_num"))
            if marker_num is None:
                marker_num = _marker_num(locator.get("marker"))
        elif isinstance(locator, str):
            marker_num = _marker_num(locator)
        if paragraph_id is None and marker_num is None:
            continue
        key = (paragraph_id, marker_num)
        if key in seen:
            continue
        seen.add(key)
        anchors.append(
            SourceAnchor(paragraph_id=paragraph_id, marker_num=marker_num)
        )
    return anchors


def _marker_num(value: Any) -> int | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().removeprefix("§").strip()
    return _int(normalized)


def _text(value: Any) -> str | None:
    if value in (None, "", [], {}):
        return None
    return str(value)


def _strings(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if item not in (None, "")]
    return [str(value)] if value not in (None, "") else []


def _int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
