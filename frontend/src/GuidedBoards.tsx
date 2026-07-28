import {
  ArrowRight,
  BookOpen,
  Boxes,
  CheckCircle2,
  FlaskConical,
  Lightbulb,
  Route,
  Search,
  Target,
} from "lucide-react";
import { forwardRef } from "react";

import { CardCanvas } from "./CardCanvas";
import type { GraphCanvasHandle } from "./GraphCanvas";
import { useI18n } from "./i18n";
import { inlineScientificText } from "./text";
import type {
  GraphNode,
  GraphPayload,
  ReadingGuide,
} from "./types";

interface CardRect {
  height: number;
  id: string;
  width: number;
  x: number;
  y: number;
}

export interface CardConnection {
  endX: number;
  endY: number;
  labelX: number;
  labelY: number;
  path: string;
  startX: number;
  startY: number;
}

function rectCenter(rect: CardRect) {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

export function connectCardRects(source: CardRect, target: CardRect): CardConnection {
  const start = rectCenter(source);
  const end = rectCenter(target);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const sourceScale = 1 / Math.max(
    Math.abs(dx) / (source.width / 2),
    Math.abs(dy) / (source.height / 2),
    1,
  );
  const targetScale = 1 / Math.max(
    Math.abs(dx) / (target.width / 2),
    Math.abs(dy) / (target.height / 2),
    1,
  );
  const startX = start.x + dx * sourceScale;
  const startY = start.y + dy * sourceScale;
  const endX = end.x - dx * targetScale;
  const endY = end.y - dy * targetScale;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const control1X = horizontal ? startX + (endX - startX) * 0.45 : startX;
  const control1Y = horizontal ? startY : startY + (endY - startY) * 0.45;
  const control2X = horizontal ? endX - (endX - startX) * 0.45 : endX;
  const control2Y = horizontal ? endY : endY - (endY - startY) * 0.45;
  return {
    startX,
    startY,
    endX,
    endY,
    labelX: (startX + endX) / 2,
    labelY: (startY + endY) / 2,
    path: [
      `M ${startX} ${startY}`,
      `C ${control1X} ${control1Y}, ${control2X} ${control2Y}, ${endX} ${endY}`,
    ].join(" "),
  };
}

const stageColors = ["blue", "teal", "violet", "rose", "amber", "green"];
const stageIcons = [BookOpen, Search, Lightbulb, FlaskConical, Target, CheckCircle2];

interface DiscoveryBoardProps {
  graph: GraphPayload;
  onOpenPaper: (schemaId: string) => void;
}

export const DiscoveryBoard = forwardRef<GraphCanvasHandle, DiscoveryBoardProps>(
function DiscoveryBoard({ graph, onOpenPaper }, ref) {
  const { tr } = useI18n();
  const papers = graph.nodes
    .filter((node) => node.node_type === "paper" && node.paper)
    .slice(0, 12);
  const width = 1280;
  const cardWidth = 278;
  const cardHeight = 190;
  const columns = 4;
  const gapX = 28;
  const gapY = 30;
  const startX = (width - (columns * cardWidth + (columns - 1) * gapX)) / 2;
  // Reserve the upper-left canvas area for the overview scope and view switcher.
  const startY = 230;
  const rows = Math.max(1, Math.ceil(papers.length / columns));
  const height = Math.max(650, startY + rows * cardHeight + (rows - 1) * gapY + 74);

  return (
    <CardCanvas
      ref={ref}
      ariaLabel={tr("论文卡片浏览", "Paper card discovery")}
      height={height}
      width={width}
    >
      <div className="card-canvas-heading">
        <span>SCIVERSE PAPER SCHEMA</span>
        <strong>{tr("从真实论文开始探索", "Start from real papers")}</strong>
        <small>{tr(
          `展示发现范围中的 ${papers.length} 篇论文卡片`,
          `${papers.length} paper cards from the current discovery scope`,
        )}</small>
      </div>
      {!papers.length ? (
        <section className="structure-empty discovery-empty">
          <BookOpen size={22} />
          <h3>{tr("当前发现范围没有论文卡片", "No paper cards in the current discovery scope")}</h3>
          <p>{tr("切换到关系图谱检查线上返回结果。", "Switch to Relationship Graph to inspect the online result.")}</p>
        </section>
      ) : null}
      {papers.map((node, index) => {
        const paper = node.paper!;
        const column = index % columns;
        const row = Math.floor(index / columns);
        return (
          <button
            type="button"
            className={`canvas-card roadmap-node-card discovery-paper-card stage-${stageColors[index % stageColors.length]}`}
            key={node.id}
            style={{
              left: startX + column * (cardWidth + gapX),
              top: startY + row * (cardHeight + gapY),
              width: cardWidth,
              height: cardHeight,
            }}
            onClick={() => onOpenPaper(node.schema_id)}
          >
            <span className="canvas-card-index">{String(index + 1).padStart(2, "0")}</span>
            <span className="canvas-card-icon"><BookOpen size={20} /></span>
            <span className="canvas-card-kind">{tr("SCHEMA 论文", "SCHEMA PAPER")}</span>
            <strong>{inlineScientificText(paper.title || node.label)}</strong>
            <p>{paper.central_contribution || paper.abstract || node.subtitle || tr("结构化论文", "Structured paper")}</p>
            <footer>
              <span>{paper.year || tr("年份未知", "Year unavailable")} · {paper.authors.slice(0, 2).join(", ") || tr("作者未知", "Authors unavailable")}</span>
              <ArrowRight size={15} />
            </footer>
          </button>
        );
      })}
    </CardCanvas>
  );
});

export function buildRoadmapLayout(itemCount: number) {
  const width = 1120;
  const cardWidth = 286;
  const cardHeight = 190;
  const columns = Math.max(1, Math.min(3, itemCount));
  const gapX = 78;
  const gapY = 110;
  const rows = Math.max(1, Math.ceil(itemCount / columns));
  const rowWidth = columns * cardWidth + (columns - 1) * gapX;
  const startX = (width - rowWidth) / 2;
  const startY = 124;
  const cards = Array.from({ length: itemCount }, (_, index) => {
    const row = Math.floor(index / columns);
    const offset = index % columns;
    const column = row % 2 === 0 ? offset : columns - offset - 1;
    return {
      id: `roadmap-card-${index}`,
      x: startX + column * (cardWidth + gapX),
      y: startY + row * (cardHeight + gapY),
      width: cardWidth,
      height: cardHeight,
    };
  });
  return {
    cards,
    width,
    height: Math.max(570, startY + rows * cardHeight + (rows - 1) * gapY + 104),
  };
}

interface RoadmapBoardProps {
  graph: GraphPayload;
  guide: ReadingGuide;
  onOpenPaper: (schemaId: string) => void;
}

export const RoadmapBoard = forwardRef<GraphCanvasHandle, RoadmapBoardProps>(
function RoadmapBoard({ guide, graph, onOpenPaper }, ref) {
  const { tr } = useI18n();
  const papers = new Map(
    graph.nodes
      .filter((node) => node.paper)
      .map((node) => [node.schema_id, node.paper!]),
  );
  const items = (guide.items.length
    ? guide.items
    : graph.nodes
      .filter((node) => node.node_type === "paper")
      .slice(0, 6)
      .map((node, index) => ({
        order: index + 1,
        schema_id: node.schema_id,
        title: node.label,
        role: index === 0 ? "seed" as const : "expansion" as const,
        rationale: node.subtitle || "",
      }))).slice(0, 6);
  const layout = buildRoadmapLayout(items.length);

  return (
    <CardCanvas
      ref={ref}
      ariaLabel={tr("学习路线图", "Learning roadmap")}
      height={layout.height}
      width={layout.width}
    >
      <div className="card-canvas-heading">
        <span>RESEARCH LEARNING PATH</span>
        <strong>{items.length} grounded paper cards</strong>
        <small>Bounded to the current Sciverse Paper Schema corpus</small>
      </div>
      <svg
        className="card-edge-layer roadmap-edge-layer"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        aria-hidden="true"
      >
        <defs>
          <marker id="roadmap-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" />
          </marker>
        </defs>
        {layout.cards.slice(0, -1).map((card, index) => {
          const edge = connectCardRects(card, layout.cards[index + 1]);
          return (
            <g key={`roadmap-edge-${index}`}>
              <path d={edge.path} markerEnd="url(#roadmap-arrow)" />
              <rect x={edge.labelX - 23} y={edge.labelY - 10} width="46" height="20" rx="10" />
              <text x={edge.labelX} y={edge.labelY + 3}>NEXT</text>
            </g>
          );
        })}
      </svg>
      {items.map((item, index) => {
        const card = layout.cards[index];
        const Icon = stageIcons[index % stageIcons.length];
        const paper = papers.get(item.schema_id);
        const summary = paper?.central_contribution
          || paper?.abstract
          || "Schema paper in the current bounded topic graph.";
        return (
          <button
            type="button"
            className={`canvas-card roadmap-node-card stage-${stageColors[index % stageColors.length]}`}
            key={`${item.order}-${item.schema_id}`}
            style={{
              left: card.x,
              top: card.y,
              width: card.width,
              height: card.height,
            }}
            onClick={() => onOpenPaper(item.schema_id)}
          >
            <span className="canvas-card-index">{String(index + 1).padStart(2, "0")}</span>
            <span className="canvas-card-icon"><Icon size={20} /></span>
            <span className="canvas-card-kind">
              {item.role === "seed" ? "ESTABLISH TOPIC SCOPE" : item.role === "foundation" ? "BUILD FOUNDATIONS" : "EXPAND DIRECTION"}
            </span>
            <strong>{inlineScientificText(item.title)}</strong>
            <p>{summary}</p>
            <footer>
              <span>{paper?.year || "Schema paper"}</span>
              <ArrowRight size={15} />
            </footer>
          </button>
        );
      })}
    </CardCanvas>
  );
});

const groupMeta: Record<string, { label: string; icon: typeof Boxes; tone: string }> = {
  Problem: { label: "Research Problem", icon: Target, tone: "red" },
  Contribution: { label: "Core Contribution", icon: Lightbulb, tone: "teal" },
  Component: { label: "Method Component", icon: Boxes, tone: "violet" },
  ExperimentSetup: { label: "Experiment Setup", icon: FlaskConical, tone: "green" },
  Finding: { label: "Key Finding", icon: CheckCircle2, tone: "blue" },
  Dataset: { label: "Dataset", icon: Boxes, tone: "rose" },
  Task: { label: "Task", icon: Target, tone: "amber" },
  Measure: { label: "Measure", icon: Route, tone: "amber" },
  Resource: { label: "Resource", icon: Boxes, tone: "green" },
  Document: { label: "Document Structure", icon: Route, tone: "blue" },
};

interface StructureCard extends CardRect {
  node: GraphNode;
  tone: string;
}

interface StructureGroupFrame extends CardRect {
  label: string;
  shown: number;
  tone: string;
  total: number;
  type: string;
}

export function buildStructureLayout(graph: GraphPayload) {
  const groups = new Map<string, GraphNode[]>();
  graph.nodes
    .filter((node) => node.node_type === "entity")
    .forEach((node) => {
      const type = node.entity_type || "Entity";
      groups.set(type, [...(groups.get(type) || []), node]);
    });
  const entries = [...groups.entries()].slice(0, 6);
  const width = 1320;
  const frameWidth = 388;
  const frameHeight = 400;
  const frameGapX = 38;
  const frameGapY = 44;
  const startX = (width - (frameWidth * 3 + frameGapX * 2)) / 2;
  const startY = 292;
  const groupFrames: StructureGroupFrame[] = [];
  const cards: StructureCard[] = [];

  entries.forEach(([type, nodes], groupIndex) => {
    const column = groupIndex % 3;
    const row = Math.floor(groupIndex / 3);
    const meta = groupMeta[type] || { label: type, icon: Boxes, tone: "slate" };
    const frame: StructureGroupFrame = {
      id: `structure-group-${type}`,
      type,
      label: meta.label,
      tone: meta.tone,
      shown: Math.min(nodes.length, 4),
      total: nodes.length,
      x: startX + column * (frameWidth + frameGapX),
      y: startY + row * (frameHeight + frameGapY),
      width: frameWidth,
      height: frameHeight,
    };
    groupFrames.push(frame);
    nodes.slice(0, 4).forEach((node, index) => {
      cards.push({
        id: node.id,
        node,
        tone: meta.tone,
        x: frame.x + 18,
        y: frame.y + 58 + index * 80,
        width: frame.width - 36,
        height: 70,
      });
    });
  });

  return {
    cards,
    groupFrames,
    width,
    height: Math.max(790, startY + Math.max(1, Math.ceil(entries.length / 3)) * frameHeight + Math.max(0, Math.ceil(entries.length / 3) - 1) * frameGapY + 74),
    paper: {
      id: "structure-paper-core",
      x: (width - 390) / 2,
      y: 54,
      width: 390,
      height: 176,
    } satisfies CardRect,
  };
}

interface StructureBoardProps {
  graph: GraphPayload;
  onSelectNode: (node: GraphNode) => void;
}

export const StructureBoard = forwardRef<GraphCanvasHandle, StructureBoardProps>(
function StructureBoard({ graph, onSelectNode }, ref) {
  const { tr } = useI18n();
  const paper = graph.nodes.find((node) => node.node_type === "paper");
  const layout = buildStructureLayout(graph);
  const cardsById = new Map(layout.cards.map((card) => [card.id, card]));
  const relations = graph.edges
    .filter((edge) => edge.edge_type === "internal_relation")
    .flatMap((edge) => {
      const source = cardsById.get(edge.source);
      const target = cardsById.get(edge.target);
      return source && target ? [{ edge, geometry: connectCardRects(source, target) }] : [];
    });

  return (
    <CardCanvas
      ref={ref}
      ariaLabel={tr("知识结构图", "Knowledge structure graph")}
      height={layout.height}
      width={layout.width}
    >
      <svg
        className="card-edge-layer structure-edge-layer"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        aria-hidden="true"
      >
        <defs>
          <marker id="structure-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M 0 0 L 7 3.5 L 0 7 z" />
          </marker>
        </defs>
        {relations.map(({ edge, geometry }) => (
          <g key={edge.id}>
            <path d={geometry.path} markerEnd="url(#structure-arrow)" />
            <rect
              x={geometry.labelX - Math.min(58, Math.max(24, edge.label.length * 3.2))}
              y={geometry.labelY - 9}
              width={Math.min(116, Math.max(48, edge.label.length * 6.4))}
              height="18"
              rx="9"
            />
            <text x={geometry.labelX} y={geometry.labelY + 3}>{edge.label}</text>
          </g>
        ))}
      </svg>
      {paper ? (
        <button
          type="button"
          className="canvas-card structure-paper-card"
          style={{
            left: layout.paper.x,
            top: layout.paper.y,
            width: layout.paper.width,
            height: layout.paper.height,
          }}
          onClick={() => onSelectNode(paper)}
        >
          <span className="canvas-card-kind">PAPER SCHEMA</span>
          <strong>{inlineScientificText(paper.label)}</strong>
          <p>{paper.paper?.central_contribution || paper.paper?.abstract || graph.description}</p>
          <footer>
            <span>{paper.paper?.year || "Paper"} · {layout.cards.length} visible Entity cards</span>
            <ArrowRight size={15} />
          </footer>
        </button>
      ) : null}
      {!layout.groupFrames.length ? (
        <section className="structure-empty">
          <Boxes size={22} />
          <h3>No structured Entity nodes returned</h3>
          <p>The paper metadata is available, but this view will not synthesize missing nodes.</p>
        </section>
      ) : null}
      {layout.groupFrames.map((group) => {
        const meta = groupMeta[group.type] || { label: group.label, icon: Boxes, tone: group.tone };
        const Icon = meta.icon;
        return (
          <section
            className={`structure-group-frame structure-${group.tone}`}
            key={group.id}
            style={{
              left: group.x,
              top: group.y,
              width: group.width,
              height: group.height,
            }}
          >
            <header>
              <Icon size={18} />
              <strong>{group.label}</strong>
              <span>{group.shown} / {group.total}</span>
            </header>
          </section>
        );
      })}
      {layout.cards.map((card, index) => (
        <button
          type="button"
          className={`canvas-card structure-entity-card structure-${card.tone}`}
          key={card.id}
          style={{
            left: card.x,
            top: card.y,
            width: card.width,
            height: card.height,
          }}
          onClick={() => onSelectNode(card.node)}
        >
          <span className="canvas-card-index">{String(index + 1).padStart(2, "0")}</span>
          <span className="entity-card-copy">
            <strong>{inlineScientificText(card.node.label)}</strong>
            <small>{card.node.description || card.node.section || card.node.subtitle || "Structured Entity"}</small>
          </span>
          <ArrowRight size={14} />
        </button>
      ))}
      {layout.groupFrames.length && !relations.length ? (
        <div className="structure-relation-note">
          No internal Relation is available between the visible Entity cards.
        </div>
      ) : null}
    </CardCanvas>
  );
});
