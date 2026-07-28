import { describe, expect, it } from "vitest";

import { filterGraphByVisibility } from "./graph";
import type { GraphPayload } from "./types";

const graph: GraphPayload = {
  graph_id: "filter-test",
  title: "Filter test",
  description: "Filter test",
  nodes: [
    {
      id: "paper:1",
      node_type: "paper",
      label: "Paper",
      schema_id: "paper-1",
      status: "available",
    },
    {
      id: "entity:problem",
      node_type: "entity",
      label: "Problem",
      schema_id: "paper-1",
      entity_type: "Problem",
      status: "available",
    },
    {
      id: "entity:dataset",
      node_type: "entity",
      label: "Dataset",
      schema_id: "paper-1",
      entity_type: "Dataset",
      status: "available",
    },
  ],
  edges: [
    {
      id: "edge:internal",
      edge_type: "internal_relation",
      source: "entity:problem",
      target: "entity:dataset",
      label: "uses",
      directed: true,
      reasons: [],
      provenance_count: 1,
    },
    {
      id: "edge:suggestion",
      edge_type: "related_suggestion",
      source: "paper:1",
      target: "entity:problem",
      label: "related",
      directed: false,
      reasons: [],
      provenance_count: 0,
    },
  ],
  stats: {
    paper_nodes: 1,
    entity_nodes: 2,
    reference_nodes: 0,
    internal_relations: 1,
    citations: 0,
    suggestions: 1,
  },
  warnings: [],
  truncated: false,
};

describe("graph visibility filters", () => {
  it("removes hidden node categories and their connected edges", () => {
    const filtered = filterGraphByVisibility(
      graph,
      { Paper: true, Problem: false, Dataset: true },
      {
        internal_relation: true,
        citation: true,
        related_suggestion: true,
      },
    );

    expect(filtered.nodes.map((node) => node.id)).toEqual([
      "paper:1",
      "entity:dataset",
    ]);
    expect(filtered.edges).toHaveLength(0);
    expect(filtered.stats.entity_nodes).toBe(1);
  });

  it("removes only the disabled edge type when nodes stay visible", () => {
    const filtered = filterGraphByVisibility(
      graph,
      { Paper: true, Problem: true, Dataset: true },
      {
        internal_relation: false,
        citation: true,
        related_suggestion: true,
      },
    );

    expect(filtered.nodes).toHaveLength(3);
    expect(filtered.edges.map((edge) => edge.id)).toEqual(["edge:suggestion"]);
    expect(filtered.stats.internal_relations).toBe(0);
    expect(filtered.stats.suggestions).toBe(1);
  });
});
