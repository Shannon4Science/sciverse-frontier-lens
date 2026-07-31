# Architecture Decisions

## AD-001: API-backed session graph

The product builds a bounded graph for the current query or selected paper. It
does not construct or load a global literature graph.

## AD-002: Standalone project

ScholarWeave is a design and interaction reference. This project has its own
source tree, dependencies, tests, configuration, and release process.

## AD-003: Public Sciverse contract only

The backend calls the authenticated public Paper Schema endpoints through the
Sciverse gateway. It does not read OpenSearch, SQLite graph databases, S3
objects, or internal index names.

## AD-004: Three edge semantics

1. Internal relation: a factual relation between entities inside one paper.
2. Citation edge: a resolved paper-to-paper citation.
3. Related suggestion: a ranked similarity result, not a factual edge.

The UI must render these differently and must not relabel similarity as fact.

## AD-005: Paper-scoped entity identity

Entity identity is scoped to a paper:

```text
entity:{schema_id}:{entity_id}
```

Same-name entities from different papers are not automatically merged.

## AD-006: Complete references versus resolved citation graph

The complete citation list retains unresolved references. Only resolved
references may become paper-to-paper graph edges.

## AD-007: Progressive disclosure

Initial pages use bounded search, related-paper, citation-graph, and materials
responses. Complete entity and relation pages are fetched only when the user
opens a paper or requests more results.

## AD-008: Server-side token

The browser never receives a persistent Sciverse API token. Authentication,
retry, quota handling, and request IDs are owned by the backend-for-frontend.

## AD-009: Grounded generation only

An LLM may organize a guide or roadmap, but every statement must be grounded in
the closed API result set and traceable to paper, entity, relation, citation, or
evidence identifiers. Sciverse and LLM connections must both be configured and
enabled before research workflows begin. Missing configuration or any LLM
request, parsing, or output-contract failure stops the current task and is
reported to the user; no dictionary or deterministic guide is returned as a
successful fallback.

## AD-010: Coverage statement

Empty results mean no match in the current 1M+ AI conference-paper Schema
corpus. The UI must not claim that the research does not exist globally.

## AD-011: FrontierLens is the product baseline

The original ScholarWeave FrontierLens experience is the interaction and visual
baseline, not merely inspiration. The standalone application keeps:

1. discovery map plus research-question sidebar;
2. Research Guide plus Roadmap/Subgraph switch;
3. Paper Reading Guide plus Structure/Internal switch;
4. optional Entity and Relation inspector.

The data implementation is deliberately different: all graphs are bounded to a
query or paper and are assembled from Sciverse APIs. The original global local
graph, SQLite database, SciKGR retrieval, and LLM graph-generation pipeline are
not copied.

## AD-012: Language is a presentation preference

The toolbar exposes one language button. It shows the language available after
the next click (`EN` in the Chinese interface and `中` in the English
interface), and persists the selected language locally.

The preference controls product copy plus the generated Guide and Roadmap.
Retrieval planning may still rewrite a Chinese or long-form question into
concise English keywords. Paper titles, bibliographic metadata, Entity labels,
Evidence values, and provenance text remain in their source language so that a
presentation preference cannot mutate extracted facts.

## AD-013: Semantic clusters are data-driven

Cluster circles are not decorative overlays. The graph renderer derives one
geometry per visible node type, places that type's nodes inside the same
geometry, and renders the circle and label from those shared coordinates.
Citation and related-suggestion semantics remain edges and never become node
clusters.

Topic exploration enriches seed papers with a bounded, balanced sample of
paper-scoped Entity nodes and their valid internal Relations. The default
limits are 30 Entity nodes and 60 Relations per seed, excluding Reference
entities from the topic cluster view. Complete entities, references, and
relations remain available in the on-demand paper view.

## AD-014: Real progress, adjustable reading, and paragraph paging

Long-running topic exploration and paper opening use one compact blocking
dialog over the current page. Its steps correspond to real backend milestones;
cancelled requests are aborted and stale responses cannot replace current UI
state.

The paper workspace has an adjustable/collapsible guide pane and an
adjustable/collapsible source reader. Both card and graph Entity selections use
the same reader contract.

The public provenance API already resolves ordered paragraph markers. The local
BFF therefore restores paper text in bounded batches (`§1..§100`,
`§101..§200`, and so on) until an empty batch is returned. It does not infer
OpenSearch index names or read storage directly. Entity/Evidence provenance is
overlaid on that ordered text:

1. exact marker or paragraph anchors produce an exact highlight;
2. objects without an anchor use paper-local text search and are labeled
   approximate;
3. a publication without paragraph rows may use a title- and author-verified
   related publication version, which is labeled separately rather than
   treated as exact provenance;
4. full-text paging clears upstream target roles so only the selected
   Entity/Evidence locations receive target styling.

Paragraph text is session data only and is never persisted to local files.
