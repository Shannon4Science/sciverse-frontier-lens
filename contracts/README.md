# FrontierLens Public Contract

Contract version: `2026-07-24`.

Public graph nodes are `paper`, `entity`, `reference`, or `evidence`. Public
edges are:

1. `internal_relation`: a factual relation between two paper-scoped Entities;
2. `citation`: a resolved paper-to-paper citation;
3. `related_suggestion`: a ranked similarity suggestion with score/reasons.

The complete reference list is separate from citation graph edges so unresolved
references remain visible. Entity identity is
`entity:{schema_id}:{entity_id}` and is not canonical across papers.

All API request models reject extra fields. Responses are generated through
Pydantic allowlist models and cannot expose raw payloads, internal storage
paths, index names, or warehouse IDs.
