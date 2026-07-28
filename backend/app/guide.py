from __future__ import annotations

import re
from typing import Literal

from app.models import (
    GraphEdge,
    GraphNode,
    GraphPayload,
    GuideItem,
    PaperCard,
    PaperOverview,
    ReadingGuide,
)


def build_deterministic_guide(
    graph: GraphPayload,
    query: str,
    response_language: Literal["zh", "en"] | None = None,
) -> ReadingGuide:
    language = response_language or ("zh" if re.search(r"[\u3400-\u9fff]", query) else "en")
    paper_nodes = [node for node in graph.nodes if node.paper is not None]
    seed_nodes = [node for node in paper_nodes if node.subtitle == "Seed paper"]
    expansion_nodes = [node for node in paper_nodes if node.subtitle != "Seed paper"]
    foundations = sorted(
        expansion_nodes,
        key=lambda node: (
            node.paper.year is None,
            node.paper.year or 9999,
            node.label,
        ),
    )
    ordered = [*seed_nodes, *foundations]
    paper_nodes_by_id = {node.id: node for node in paper_nodes}
    paper_edges = [
        edge
        for edge in graph.edges
        if edge.source in paper_nodes_by_id and edge.target in paper_nodes_by_id
    ]
    edges_by_node: dict[str, list[GraphEdge]] = {}
    for edge in paper_edges:
        edges_by_node.setdefault(edge.source, []).append(edge)
        edges_by_node.setdefault(edge.target, []).append(edge)
    items: list[GuideItem] = []
    for index, node in enumerate(ordered[:20], start=1):
        paper = node.paper
        detail = _paper_focus(paper, language) if paper else None
        connection = _paper_connection(
            node.id,
            edges_by_node.get(node.id, []),
            paper_nodes_by_id,
            language,
        )
        if node in seed_nodes:
            role = "seed"
            rationale = "主题入口。" if language == "zh" else "Topic entry point. "
        elif (
            node.paper
            and seed_nodes
            and (node.paper.year or 9999) < (seed_nodes[0].paper.year or 9999)
        ):
            role = "foundation"
            if language == "zh":
                rationale = f"较早的相关工作（{node.paper.year}），适合补充研究背景。"
            else:
                rationale = (
                    f"An earlier related work ({node.paper.year}) for establishing context. "
                )
        else:
            role = "expansion"
            rationale = (
                "用于扩展当前研究邻域。"
                if language == "zh"
                else "Expands the current research neighborhood. "
            )
        rationale = " ".join(
            value.strip() for value in [rationale, connection, detail] if value and value.strip()
        )
        items.append(
            GuideItem(
                order=index,
                schema_id=node.schema_id,
                title=node.label,
                role=role,
                rationale=rationale,
            )
        )
    focus_nodes = (seed_nodes or ordered)[:3]
    focus_lines = []
    for node in focus_nodes:
        detail = _paper_focus(node.paper, language) if node.paper else None
        if detail:
            focus_lines.append(
                f"**{node.label}**：{detail}" if language == "zh" else f"**{node.label}**: {detail}"
            )
    citation_count = sum(edge.edge_type == "citation" for edge in paper_edges)
    suggestion_count = sum(edge.edge_type == "related_suggestion" for edge in paper_edges)
    if language == "zh":
        boundary = (
            f"**主题边界。** 当前子图围绕“{query}”组织了 "
            f"{len(paper_nodes)} 篇论文，其中 {len(seed_nodes)} 篇是直接检索到的"
            "种子论文。它们共同构成当前问题的入口，但不应被理解为一条单一、"
            "完整的历史时间线。"
        )
        branches = (
            "**主要研究入口。** " + "；".join(focus_lines) + "。"
            if focus_lines
            else (
                "**主要研究入口。** 当前 Schema 元数据不足以提炼具体分支，"
                "可先从排序靠前的种子论文判断主题边界。"
            )
        )
        relationships = (
            f"**论文如何关联。** 子图包含 {citation_count} 条已解析引用和 "
            f"{suggestion_count} 条相关建议。引用边可用于追踪明确的论文间参考关系；"
            "相关建议只表示主题相似或检索扩展，不代表引用、影响或演化先后。"
        )
        reading = (
            "**建议怎么读。** 先比较前三篇种子论文的研究问题与核心贡献，识别主题的"
            "不同分支；再沿引用边补充有明确依据的前置工作，最后用相关建议寻找并行方向"
            "和应用扩展。"
        )
    else:
        boundary = (
            f"**Topic boundary.** The current subgraph contains {len(paper_nodes)} papers "
            f"for “{query}”, including {len(seed_nodes)} directly retrieved seed papers. "
            "Together they define the current entry points, but they should not be read as "
            "one complete linear history."
        )
        branches = (
            "**Main research entry points.** " + "; ".join(focus_lines) + "."
            if focus_lines
            else (
                "**Main research entry points.** The available Schema metadata is too sparse "
                "to name reliable branches; use the highest-ranked seeds to establish scope."
            )
        )
        relationships = (
            f"**How the papers connect.** The subgraph contains {citation_count} resolved "
            f"citation edges and {suggestion_count} related suggestions. Citations represent "
            "explicit paper-to-paper references; suggestions indicate thematic similarity or "
            "retrieval expansion, not influence or chronology."
        )
        reading = (
            "**How to read it.** Compare the research problems and central contributions of "
            "the first three seeds, follow citations for explicitly supported prior work, and "
            "use related suggestions last to explore parallel directions and applications."
        )
    return ReadingGuide(
        query=query,
        title=(f"{query} 的阅读路径" if language == "zh" else f"Reading path for {query}"),
        summary="\n\n".join([boundary, branches, relationships, reading]),
        items=items,
        scope_note=(
            ("本导读仅覆盖已完成 Sciverse Paper Schema 抽取的 100 万+ AI 会议论文。")
            if language == "zh"
            else (
                "This guide is limited to the 1M+ AI conference papers with completed "
                "Sciverse Paper Schema extraction."
            )
        ),
        caveats=(
            [
                "该顺序仅用于辅助探索，不代表事实时间线。",
                "相关建议表示排序相似性；引用边表示已解析参考文献。",
                "空结果不代表学术文献中不存在该研究。",
            ]
            if language == "zh"
            else [
                "The order is an exploration aid, not a factual chronology.",
                (
                    "Related suggestions indicate ranked similarity; citation edges indicate "
                    "resolved references."
                ),
                (
                    "An empty result does not imply that the research is absent from "
                    "scholarly literature."
                ),
            ]
        ),
    )


def _paper_focus(
    paper: PaperCard,
    language: Literal["zh", "en"],
) -> str | None:
    value = (
        paper.central_contribution
        or paper.research_problem
        or paper.headline_result
        or paper.abstract
    )
    if value:
        return _compact(value, 180)
    if paper.topics:
        topics = "、".join(paper.topics[:4]) if language == "zh" else ", ".join(paper.topics[:4])
        return f"主题包括 {topics}。" if language == "zh" else f"Topics include {topics}."
    return None


def _paper_connection(
    node_id: str,
    edges: list[GraphEdge],
    paper_nodes_by_id: dict[str, GraphNode],
    language: Literal["zh", "en"],
) -> str | None:
    citation = next((edge for edge in edges if edge.edge_type == "citation"), None)
    suggestion = next(
        (edge for edge in edges if edge.edge_type == "related_suggestion"),
        None,
    )
    edge = citation or suggestion
    if edge is None:
        return None
    other_id = edge.target if edge.source == node_id else edge.source
    other = paper_nodes_by_id.get(other_id)
    if other is None:
        return None
    if edge.edge_type == "citation":
        return (
            f"通过已解析引用与《{other.label}》相连。"
            if language == "zh"
            else f"Connected to “{other.label}” by a resolved citation."
        )
    return (
        f"通过相关建议与《{other.label}》相连，表示主题相似而非引用。"
        if language == "zh"
        else (
            f"Connected to “{other.label}” by a related suggestion, indicating "
            "thematic similarity rather than citation."
        )
    )


def _compact(value: str, limit: int) -> str:
    normalized = " ".join(value.split())
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 1].rstrip(" ,.;:，。；：") + "…"


def build_deterministic_paper_overview(
    paper: PaperCard,
    response_language: Literal["zh", "en"],
    graph: GraphPayload | None = None,
) -> PaperOverview:
    source_summary = (
        paper.central_contribution
        or paper.abstract
        or paper.research_problem
        or paper.headline_result
    )
    if response_language == "zh":
        summary = source_summary or "当前元数据未提供足够信息来生成论文概述。"
        why_read = "可先核对研究问题、核心贡献和关键结果，再决定是否进入结构图与原文证据。"
        candidates = [
            f"研究问题：{paper.research_problem}" if paper.research_problem else None,
            (f"核心贡献：{paper.central_contribution}" if paper.central_contribution else None),
            f"关键结果：{paper.headline_result}" if paper.headline_result else None,
            (f"主题线索：{'、'.join(paper.topics[:4])}" if paper.topics else None),
            (
                f"结构化线索：{graph.stats.entity_nodes} 个 Entity、"
                f"{graph.stats.internal_relations} 条文内关系"
                if graph is not None
                else None
            ),
        ]
    else:
        summary = source_summary or (
            "The available metadata does not contain enough information for a paper overview."
        )
        why_read = (
            "Review the research problem, central contribution, and headline result "
            "before deciding whether to open the structure graph and source evidence."
        )
        candidates = [
            (f"Research problem: {paper.research_problem}" if paper.research_problem else None),
            (
                f"Central contribution: {paper.central_contribution}"
                if paper.central_contribution
                else None
            ),
            f"Headline result: {paper.headline_result}" if paper.headline_result else None,
            (f"Topic signals: {', '.join(paper.topics[:4])}" if paper.topics else None),
            (
                f"Structured signals: {graph.stats.entity_nodes} Entities and "
                f"{graph.stats.internal_relations} internal relations"
                if graph is not None
                else None
            ),
        ]
    return PaperOverview(
        schema_id=paper.schema_id,
        language=response_language,
        summary=summary,
        why_read=why_read,
        focus_points=[value for value in candidates if value][:4],
    )
