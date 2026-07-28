import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";

import {
  graphNodeCategory,
  MAX_RENDERED_NODES,
  toCytoscapeElements,
} from "./graph";
import { useI18n } from "./i18n";
import type { GraphEdge, GraphNode, GraphPayload } from "./types";

interface GraphCanvasProps {
  graph: GraphPayload;
  onSelectNode: (node: GraphNode) => void;
  onSelectEdge: (edge: GraphEdge) => void;
  variant?: "overview" | "subgraph" | "internal" | "citation";
}

export interface GraphCanvasHandle {
  fit: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

const nodeTypeColors: Record<string, string> = {
  Paper: "#2f6fec",
  Method: "#0f8a83",
  Claim: "#7442db",
  Contribution: "#0f8a83",
  Component: "#7442db",
  ExperimentSetup: "#c53b2c",
  Problem: "#bc5c14",
  Finding: "#0b8656",
  Dataset: "#d43b2f",
  Task: "#d43b2f",
  Measure: "#56657a",
  Reference: "#697386",
  Resource: "#0f8a83",
};

function clusterName(type: string) {
  const names: Record<string, string> = {
    Paper: "Paper",
    Problem: "Problem",
    Contribution: "Contribution",
    Component: "Component",
    ExperimentSetup: "Experiment Setup",
    Finding: "Finding",
    Dataset: "Dataset",
    Task: "Task",
    Measure: "Measure",
    Resource: "Resource",
    Reference: "Reference",
    Evidence: "Evidence",
    Entity: "Other Entity",
  };
  return names[type] || type;
}

const CLUSTER_ORDER = [
  "Paper",
  "Problem",
  "Contribution",
  "Component",
  "ExperimentSetup",
  "Finding",
  "Dataset",
  "Task",
  "Measure",
  "Resource",
  "Reference",
  "Evidence",
  "Entity",
];

function orderedClusterTypes(types: string[]) {
  return [...types].sort((left, right) => {
    const leftRank = CLUSTER_ORDER.indexOf(left);
    const rightRank = CLUSTER_ORDER.indexOf(right);
    return (leftRank < 0 ? CLUSTER_ORDER.length : leftRank)
      - (rightRank < 0 ? CLUSTER_ORDER.length : rightRank)
      || left.localeCompare(right);
  });
}

function degreeMap(graph: GraphPayload) {
  const degrees = new Map<string, number>();
  for (const edge of graph.edges) {
    degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
  }
  return degrees;
}

function rankedNodes(nodes: GraphNode[], degrees: Map<string, number>) {
  return [...nodes].sort((left, right) => (
    (degrees.get(right.id) || 0) - (degrees.get(left.id) || 0)
    || left.label.localeCompare(right.label)
  ));
}

export function labelSampleCount(groupSize: number) {
  if (groupSize <= 5) return groupSize;
  if (groupSize <= 12) return Math.ceil(groupSize * 0.5);
  if (groupSize <= 24) return Math.ceil(groupSize * 0.25);
  return Math.max(4, Math.ceil(groupSize * 0.12));
}

export function compactGraphLabel(label: string, groupSize: number) {
  const maxLength = groupSize >= 25 ? 30 : groupSize >= 13 ? 38 : 48;
  if (label.length <= maxLength) return label;
  const candidate = label.slice(0, maxLength + 1);
  const wordBoundary = candidate.lastIndexOf(" ");
  const clipped = wordBoundary >= Math.floor(maxLength * 0.62)
    ? candidate.slice(0, wordBoundary)
    : label.slice(0, maxLength);
  return `${clipped.trim()}…`;
}

export function buildCategoryLabelPlan(graph: GraphPayload) {
  const degrees = degreeMap(graph);
  const groups = new Map<string, GraphNode[]>();
  for (const node of graph.nodes.slice(0, MAX_RENDERED_NODES)) {
    const type = graphNodeCategory(node);
    groups.set(type, [...(groups.get(type) || []), node]);
  }
  const labelNodeIds = new Set<string>();
  const displayLabels = new Map<string, string>();
  for (const type of orderedClusterTypes([...groups.keys()])) {
    const nodes = rankedNodes(groups.get(type) || [], degrees);
    const count = labelSampleCount(nodes.length);
    nodes.slice(0, count).forEach((node) => {
      labelNodeIds.add(node.id);
      displayLabels.set(node.id, compactGraphLabel(node.label, nodes.length));
    });
  }
  return {
    displayLabels,
    labelNodeIds,
  };
}

export function buildClusterGeometry(
  groups: Map<string, GraphNode[]>,
) {
  const types = orderedClusterTypes([...groups.keys()]);
  const columns = types.length <= 3 ? Math.max(1, types.length) : types.length <= 6 ? 3 : 4;
  const gap = 86;
  const clusters = types.map((type) => {
    const nodes = groups.get(type) || [];
    const radius = Math.max(92, 58 + Math.sqrt(nodes.length) * 32);
    return { type, nodes, radius, x: 0, y: 0 };
  });
  const rows = Array.from(
    { length: Math.ceil(clusters.length / columns) },
    (_, row) => clusters.slice(row * columns, (row + 1) * columns),
  );
  let yCursor = 0;
  for (const row of rows) {
    const rowRadius = Math.max(...row.map((cluster) => cluster.radius));
    let xCursor = 0;
    for (const cluster of row) {
      cluster.x = xCursor + cluster.radius;
      cluster.y = yCursor + rowRadius;
      xCursor += cluster.radius * 2 + gap;
    }
    const rowWidth = xCursor - gap;
    for (const cluster of row) {
      cluster.x -= rowWidth / 2;
    }
    yCursor += rowRadius * 2 + gap;
  }
  const totalHeight = yCursor - gap;
  for (const cluster of clusters) {
    cluster.y -= totalHeight / 2;
  }

  const positions = new Map<string, { x: number; y: number }>();
  const clusterElements: ElementDefinition[] = [];
  clusters.forEach((cluster, clusterIndex) => {
    const clusterId = `__cluster__${clusterIndex}`;
    clusterElements.push({
      data: {
        id: clusterId,
        isCluster: "yes",
        groupType: cluster.type,
        label: `${clusterName(cluster.type)}\n${cluster.nodes.length} nodes`,
        clusterColor: nodeTypeColors[cluster.type] || "#0f8a83",
        clusterDiameter: cluster.radius * 2,
      },
      position: { x: cluster.x, y: cluster.y },
      selectable: false,
      grabbable: false,
    });
    const usableRadius = Math.max(26, cluster.radius - 38);
    cluster.nodes.forEach((node, index) => {
      if (cluster.nodes.length === 1) {
        positions.set(node.id, { x: cluster.x, y: cluster.y });
        return;
      }
      const radial = Math.sqrt((index + 0.5) / cluster.nodes.length) * usableRadius;
      const angle = index * 2.399963229728653 + clusterIndex * 0.73;
      positions.set(node.id, {
        x: cluster.x + Math.cos(angle) * radial,
        y: cluster.y + Math.sin(angle) * radial,
      });
    });
  });
  return { clusterElements, positions };
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(
function GraphCanvas(
  {
    graph,
    onSelectEdge,
    onSelectNode,
    variant = "subgraph",
  },
  ref,
) {
  const { tr } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const renderedNodes = useMemo(
    () => graph.nodes.slice(0, MAX_RENDERED_NODES),
    [graph.nodes],
  );
  const labelPlan = useMemo(
    () => buildCategoryLabelPlan({ ...graph, nodes: renderedNodes }),
    [graph, renderedNodes],
  );
  const categoryCount = useMemo(
    () => new Set(renderedNodes.map(graphNodeCategory)).size,
    [renderedNodes],
  );

  useImperativeHandle(ref, () => ({
    fit: () => cyRef.current?.fit(undefined, 54),
    zoomIn: () => {
      const cy = cyRef.current;
      if (cy) cy.zoom({ level: Math.min(2.4, cy.zoom() * 1.22), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    },
    zoomOut: () => {
      const cy = cyRef.current;
      if (cy) cy.zoom({ level: Math.max(0.35, cy.zoom() / 1.22), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    },
  }), []);

  useEffect(() => {
    if (!containerRef.current) return;
    const byId = new Map(renderedNodes.map((node) => [node.id, node]));
    const edgesById = new Map(graph.edges.map((edge) => [edge.id, edge]));
    const clusterGroups = new Map<string, GraphNode[]>();
    for (const node of renderedNodes) {
      const type = graphNodeCategory(node);
      const group = clusterGroups.get(type) || [];
      group.push(node);
      clusterGroups.set(type, group);
    }
    const { clusterElements, positions } = buildClusterGeometry(clusterGroups);
    const visibleGraph = {
      ...graph,
      nodes: renderedNodes,
    };
    const childElements = toCytoscapeElements(visibleGraph).map((element) => {
      const graphNode = byId.get(String(element.data.id));
      if (!graphNode) return element;
      const type = graphNodeCategory(graphNode);
      const position = positions.get(graphNode.id);
      return {
        ...element,
        data: {
          ...element.data,
          isCluster: "no",
          groupType: type,
          color: nodeTypeColors[type] || "#0f8a83",
          status: graphNode.status,
          displayLabel: labelPlan.displayLabels.get(graphNode.id) || "",
          showLabel: labelPlan.labelNodeIds.has(graphNode.id) ? "yes" : "no",
          labelSide: (position?.x || 0) < 0 ? "left" : "right",
        },
        position,
      };
    });
    const elements = [...clusterElements, ...childElements];
    const cy = cytoscape({
      container: containerRef.current,
      elements,
      autoungrabify: true,
      minZoom: 0.3,
      maxZoom: 2.5,
      wheelSensitivity: 0.16,
      style: [
        {
          selector: 'node[isCluster = "no"]',
          style: {
            "background-color": "data(color)",
            "border-color": "#ffffff",
            "border-width": 1.5,
            color: "#27344b",
            label: "",
            "font-family": "Inter, Arial, sans-serif",
            "font-size": variant === "overview" ? 9 : 10,
            "font-weight": 600,
            "text-wrap": "wrap",
            "text-max-width": variant === "overview" ? "130px" : "150px",
            "text-valign": "center",
            "text-halign": "right",
            "text-margin-x": 8,
            "text-background-color": "#ffffff",
            "text-background-opacity": 0.82,
            "text-background-padding": "2px",
            "text-background-shape": "roundrectangle",
            width: 12,
            height: 12,
            "overlay-opacity": 0,
          },
        },
        {
          selector: 'node[isCluster = "no"][showLabel = "yes"]',
          style: {
            label: "data(displayLabel)",
          },
        },
        {
          selector: 'node[isCluster = "no"].is-emphasized, node[isCluster = "no"]:selected',
          style: {
            label: "data(label)",
          },
        },
        {
          selector: 'node[isCluster = "no"][labelSide = "left"]',
          style: {
            "text-halign": "left",
            "text-margin-x": -8,
          },
        },
        {
          selector: 'node[isCluster = "no"][labelSide = "right"]',
          style: {
            "text-halign": "right",
            "text-margin-x": 8,
          },
        },
        {
          selector: 'node[isCluster = "yes"]',
          style: {
            shape: "ellipse",
            width: "data(clusterDiameter)",
            height: "data(clusterDiameter)",
            "background-color": "data(clusterColor)",
            "background-opacity": 0.08,
            "border-color": "data(clusterColor)",
            "border-opacity": 0.2,
            "border-width": 1.2,
            label: "data(label)",
            color: "data(clusterColor)",
            "font-family": "Inter, Arial, sans-serif",
            "font-size": 10,
            "font-weight": 800,
            "text-wrap": "wrap",
            "text-valign": "top",
            "text-halign": "center",
            "text-margin-y": -11,
            "text-background-color": "#ffffff",
            "text-background-opacity": 0.9,
            "text-background-padding": "5px",
            "text-background-shape": "roundrectangle",
            events: "no",
            "z-index": -10,
            "z-index-compare": "manual",
            "overlay-opacity": 0,
          },
        },
        {
          selector: 'node[nodeType = "paper"]',
          style: {
            width: 16,
            height: 16,
            "background-color": "#2f6fec",
          },
        },
        {
          selector: 'node[status = "unresolved"]',
          style: {
            "background-color": "#ffffff",
            "border-color": "#9aa5b4",
            "border-style": "dashed",
            "border-width": 2,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.1,
            "line-color": "#77bdb5",
            "target-arrow-color": "#0f8a83",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "",
            "font-size": 7.5,
            color: "#56616d",
            "text-background-color": "#ffffff",
            "text-background-opacity": 0.88,
            "text-background-padding": "2px",
            "text-rotation": "autorotate",
            "arrow-scale": 0.7,
            opacity: 0.72,
          },
        },
        {
          selector: "edge.is-emphasized, edge:selected",
          style: {
            label: "data(label)",
            opacity: 1,
            width: 2.2,
            "z-index": 8,
          },
        },
        {
          selector: 'edge[edgeType = "citation"]',
          style: {
            "line-color": "#2f6fec",
            "target-arrow-color": "#2f6fec",
            width: 1.8,
          },
        },
        {
          selector: 'edge[edgeType = "related_suggestion"]',
          style: {
            "line-color": "#b47c2b",
            "target-arrow-color": "#b47c2b",
            "line-style": "dashed",
          },
        },
        {
          selector: ":selected",
          style: {
            "border-color": "#101828",
            "border-width": 3,
            opacity: 1,
          },
        },
      ],
      layout: {
        name: "preset",
        fit: true,
        padding: variant === "overview" ? 110 : 76,
      },
    });
    cy.on("mouseover", 'node[isCluster = "no"]', (event) => {
      const node = event.target;
      node.addClass("is-emphasized");
      node.connectedEdges().addClass("is-emphasized");
      node.neighborhood("node").addClass("is-neighbor");
    });
    cy.on("mouseout", 'node[isCluster = "no"]', (event) => {
      const node = event.target;
      node.removeClass("is-emphasized");
      node.connectedEdges().removeClass("is-emphasized");
      node.neighborhood("node").removeClass("is-neighbor");
    });
    cy.on("tap", "node", (event) => {
      const node = byId.get(event.target.id());
      if (node) onSelectNode(node);
    });
    cy.on("tap", "edge", (event) => {
      const edge = edgesById.get(event.target.id());
      if (edge) onSelectEdge(edge);
    });
    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [graph, labelPlan, onSelectEdge, onSelectNode, renderedNodes, variant]);

  return (
    <div className="interactive-graph-shell">
      <div className="graph-density-summary">
        {tr(
          `${renderedNodes.length} 个节点 · ${categoryCount} 个类别 · 显示 ${labelPlan.labelNodeIds.size} 个名称`,
          `${renderedNodes.length} nodes · ${categoryCount} categories · ${labelPlan.labelNodeIds.size} labels`,
        )}
      </div>
      <div
        className={`graph-canvas graph-canvas-${variant}`}
        ref={containerRef}
        aria-label={tr("研究图谱", "Research graph")}
      />
    </div>
  );
});
