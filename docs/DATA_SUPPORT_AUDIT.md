# Data and model support audit

Verified against the public Paper Schema API implementation and contracts on
2026-07-27.

## Directly supported by Sciverse data

| Product capability | Public source | Boundary |
| --- | --- | --- |
| Paper discovery | `POST /paper-schema/search` | English keyword and metadata matching over the current 1M+ AI conference-paper corpus. |
| Paper entities | `GET /paper-schema/schemas/{schema_id}/entities` | Paper-scoped extracted Entity nodes; absence is displayed as absence and is not synthesized. |
| Internal graph | `POST /paper-schema/relations/search` | Relations between Entity nodes inside a known paper only. |
| Complete outbound references | `GET /paper-schema/schemas/{schema_id}/citations` | Keeps unresolved references; only resolved items can open another Schema paper. |
| Citation graph | `GET /paper-schema/schemas/{schema_id}/citation-graph` | Contains only references resolved to Schema paper IDs in the current corpus. |
| Related papers | `POST /paper-schema/schemas/{schema_id}/related-papers` | Ranked suggestions from Entity, Term and Citation signals; suggestions are not factual edges. |
| Evidence | `POST /paper-schema/evidence/search` | Uses public groups such as `resource`, `formula`, `citation_signal`, `reference_semantics`, `table_evidence` and `comparison_detail`. |
| Paragraph trace | `POST /paper-schema/resolve-provenance` | Uses exactly one locator mode: paragraph IDs, or schema ID plus marker numbers. |

## Model participation

### Query planning

Chinese and long natural-language questions are rewritten into one to three
short English search phrases. This is necessary for reliable recall because
the indexed source text is predominantly English. A small local glossary is a
fallback, not a general Chinese search solution.

### Research guide

The model may order and explain only papers already present in the assembled
session graph. Returned Schema IDs are validated against that graph. If the
model fails, a deterministic guide is returned.

The reading order, stage labels and narrative summary are product-level
derivations. They are not fields returned by Sciverse and must not be presented
as extracted facts or a factual research chronology.

The user may explicitly request Chinese or English Guide/Roadmap output. This is
a presentation preference, not source-data translation. Paper titles, Entity
labels, Evidence, and provenance remain unchanged.

### Deliberately not delegated to the model

- Entity and relation extraction
- Citation resolution or edge creation
- Evidence values and paragraph text
- Paper IDs, titles and bibliographic metadata
- Empty-result interpretation

## Not supported as direct data capabilities

- General Chinese full-text retrieval without query translation
- Automatic Chinese translation of paper titles, abstracts, Entity labels or
  evidence text
- Coverage outside the current completed Paper Schema corpus
- A citation edge for an unresolved reference
- A globally canonical Entity identity across different papers; Entity IDs are
  paper-scoped extraction identities
- A factual reading order, roadmap or topic chronology
- A complete long-form Chinese paper summary from a single upstream response
- Claims that an empty result means the research does not exist
- A complete global knowledge graph assembled without query and size limits

## Corrections made during this audit

- Replaced obsolete internal Evidence group names with the public API groups.
- Made provenance locator modes mutually exclusive.
- Added support for public `paragraph_ids` and `§N` marker provenance.
- Removed synthetic Problem and Method nodes when Entity data is absent.
- Replaced the former synthetic opening data with a live bounded discovery map.
- Replaced obsolete UI Entity categories with the public taxonomy.
- Marked paper reading as Schema-structured rather than falsely claiming model
  generation.
- Added a persistent Chinese/English presentation preference while preserving
  source-language facts.
- Replaced static decorative overview circles with data-driven semantic
  clusters and added bounded seed-paper Entity/Relation expansion.
