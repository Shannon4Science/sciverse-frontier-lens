import { describe, expect, it } from "vitest";

import {
  buildCategoryLabelPlan,
  compactGraphLabel,
  labelSampleCount,
} from "./GraphCanvas";
import type { GraphNode, GraphPayload } from "./types";

function node(
  id: string,
  nodeType: GraphNode["node_type"],
  entityType?: string,
): GraphNode {
  return {
    id,
    node_type: nodeType,
    label: id,
    schema_id: id.startsWith("paper") ? id : "paper-1",
    entity_type: entityType,
    status: "available",
  };
}

function graph(nodes: GraphNode[]): GraphPayload {
  return {
    graph_id: "test-graph",
    title: "test",
    description: "test",
    nodes,
    edges: [],
    stats: {
      paper_nodes: nodes.filter((item) => item.node_type === "paper").length,
      entity_nodes: nodes.filter((item) => item.node_type === "entity").length,
      reference_nodes: 0,
      internal_relations: 0,
      citations: 0,
      suggestions: 0,
    },
    warnings: [],
    truncated: false,
  };
}

describe("graph label sampling", () => {
  it("reduces the visible label percentage as a category grows", () => {
    expect(labelSampleCount(5)).toBe(5);
    expect(labelSampleCount(10)).toBe(5);
    expect(labelSampleCount(20)).toBe(5);
    expect(labelSampleCount(25)).toBe(4);
    expect(labelSampleCount(50)).toBe(6);
  });

  it("keeps every small-category label and samples dense categories", () => {
    const papers = Array.from({ length: 25 }, (_, index) => (
      node(`paper-${index + 1}`, "paper")
    ));
    const findings = Array.from({ length: 4 }, (_, index) => (
      node(`finding-${index + 1}`, "entity", "Finding")
    ));
    const plan = buildCategoryLabelPlan(graph([...papers, ...findings]));

    expect([...plan.labelNodeIds].filter((id) => id.startsWith("paper-"))).toHaveLength(4);
    expect([...plan.labelNodeIds].filter((id) => id.startsWith("finding-"))).toHaveLength(4);
  });

  it("shortens dense-category labels without losing the recognizable prefix", () => {
    const value = compactGraphLabel(
      "A very long entity name describing a detailed experimental configuration",
      30,
    );

    expect(value).toBe("A very long entity name…");
  });
});
