import type { ElementDefinition } from "cytoscape";

import type {
  EdgeType,
  GraphNode,
  GraphPayload,
} from "./types";

export const MAX_RENDERED_NODES = 800;
export const MAX_RENDERED_EDGES = 1200;

export function graphNodeCategory(node: GraphNode): string {
  if (node.node_type === "paper") return "Paper";
  if (node.node_type === "reference") return "Reference";
  if (node.node_type === "evidence") return "Evidence";
  return node.entity_type || "Entity";
}

export function filterGraphByVisibility(
  graph: GraphPayload,
  visibleNodeTypes: Readonly<Record<string, boolean>>,
  visibleEdgeTypes: Readonly<Partial<Record<EdgeType, boolean>>>,
): GraphPayload {
  const nodes = graph.nodes.filter((node) => {
    const preference = visibleNodeTypes[graphNodeCategory(node)];
    return preference === undefined ? true : preference;
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => (
    visibleEdgeTypes[edge.edge_type] !== false
    && nodeIds.has(edge.source)
    && nodeIds.has(edge.target)
  ));

  return {
    ...graph,
    nodes,
    edges,
    stats: {
      paper_nodes: nodes.filter((node) => node.node_type === "paper").length,
      entity_nodes: nodes.filter((node) => node.node_type === "entity").length,
      reference_nodes: nodes.filter((node) => node.node_type === "reference").length,
      internal_relations: edges.filter((edge) => (
        edge.edge_type === "internal_relation"
      )).length,
      citations: edges.filter((edge) => edge.edge_type === "citation").length,
      suggestions: edges.filter((edge) => (
        edge.edge_type === "related_suggestion"
      )).length,
    },
  };
}

export function toCytoscapeElements(graph: GraphPayload): ElementDefinition[] {
  const visibleNodes = graph.nodes.slice(0, MAX_RENDERED_NODES);
  const nodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = graph.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .slice(0, MAX_RENDERED_EDGES);
  const nodes: ElementDefinition[] = visibleNodes.map((node) => ({
    data: {
      id: node.id,
      label: node.label,
      nodeType: node.node_type,
      subtitle: node.subtitle ?? "",
    },
  }));
  const edges: ElementDefinition[] = visibleEdges.map((edge) => ({
    data: {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      edgeType: edge.edge_type,
    },
  }));
  return [...nodes, ...edges];
}
