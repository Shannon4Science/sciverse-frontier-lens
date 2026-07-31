# API and operations

## Local API

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/capabilities` | Contract version, corpus scope, resources, limits |
| GET | `/api/discovery-map` | Live bounded opening map from Sciverse |
| POST | `/api/search` | Keyword and metadata paper search |
| POST | `/api/topic-explore` | Query plan, bounded graph and grounded guide in one request |
| POST | `/api/topic-explore/stream` | The same result with real NDJSON progress milestones |
| POST | `/api/topic-graph` | Seed search plus bounded related/citation expansion |
| POST | `/api/topic-guide` | LLM-generated closed-catalog reading path |
| GET | `/api/papers/{schema_id}` | Public paper metadata used by the opening progress flow |
| GET | `/api/papers/{schema_id}/overview` | Schema-grounded paper overview in the requested language |
| GET | `/api/papers/{schema_id}/reading-source` | Select the requested paper or an equivalent version with paragraph data |
| GET | `/api/papers/{schema_id}/graph` | Complete paper-scoped Entity/Relation graph |
| GET | `/api/papers/{schema_id}/paragraphs` | Ordered marker page for the local source reader |
| POST | `/api/papers/{schema_id}/context-search` | Approximate paper-local source lookup when no anchor exists |
| GET | `/api/papers/{schema_id}/citations` | Complete references, including unresolved |
| GET | `/api/papers/{schema_id}/citation-graph` | Resolved paper-to-paper citation graph |
| POST | `/api/evidence/search` | High-value public Evidence search |
| POST | `/api/provenance` | Resolve marker/paragraph locators to public context |
| GET | `/api/settings/sciverse` | Sciverse connection status without returning the key |
| PUT | `/api/settings/sciverse` | Save the local Sciverse API connection |
| POST | `/api/settings/sciverse/test` | Test the submitted Sciverse connection draft without saving it |
| GET | `/api/settings/model` | Model status without returning the secret |
| PUT | `/api/settings/model` | Save local OpenAI-compatible model configuration |
| POST | `/api/settings/model/test` | Test the currently saved model connection |

The upstream 18-route Paper Schema surface is intentionally narrowed into these
task-oriented view contracts. Internal fields are not passed through.

`POST /api/topic-explore`, `/api/topic-graph`, and `/api/topic-guide` accept
`response_language: "zh" | "en"`. The field controls generated Guide/Roadmap
copy only. Search planning and source records retain their own language and
semantics.

The same routes accept bounded structure-expansion controls:

| Field | Default | Range | Meaning |
|---|---:|---:|---|
| `entities_per_seed` | 30 | 0–60 | Balanced high-value Entity sample per seed paper; Reference is excluded |
| `relations_per_seed` | 60 | 0–120 | Paper-internal Relations considered per seed |

Failure to load structure for one seed adds a warning and does not discard the
remaining topic graph. Complete paper structure is still loaded only through
`GET /api/papers/{schema_id}/graph`.

`GET /api/papers/{schema_id}/paragraphs` accepts `start_marker` and `size`
(`1..100`). The BFF asks the existing public provenance endpoint for that
marker range, sorts returned segments by `marker_num`, and removes locator
roles that are meaningful only to the paging request. A non-empty response
returns the next marker; the first empty response marks the paper complete.
This relies on the current Paper Schema paragraph contract, where paragraph
markers are ordered and paragraph IDs are deterministic within a schema.
When the selected Schema Paper v2 publication has no paragraph rows, the BFF
searches for a title- and author-aligned publication version, verifies the
candidate against both signals, and returns its real `source_schema_id`.
Subsequent pages continue against that source version.

The browser incrementally merges those pages with Entity/Evidence locator
results. Exact provenance and approximate paper-local matching remain visibly
distinct. Related-version text is labeled separately and is never presented as
exact Entity provenance. No paragraph, paper, or graph response is written to
`local.config.json`.

## Error envelope

```json
{
  "error": {
    "code": "SCIVERSE_RATE_LIMITED",
    "message": "Sciverse request was rejected",
    "retryable": true,
    "request_id": "opaque-request-id"
  }
}
```

Network failures, 429, and eligible 5xx responses receive bounded retries.
Validation and authentication failures are not retried.
LLM configuration is mandatory for discovery, topic exploration, topic graph,
topic guide, and paper overview routes. A missing configuration returns 503.
An LLM network, HTTP, parsing, or contract failure returns
`MODEL_REQUEST_FAILED` with HTTP 502, or a terminal error event on the NDJSON
exploration stream. Model failures never return a dictionary or deterministic
guide as a successful result.

## Environment

| Variable | Required | Default |
|---|---|---|
| `SCIVERSE_API_BASE_URL` | no | `https://api.sciverse.space` |
| `SCIVERSE_API_TOKEN` | no | none |
| `LOCAL_CONFIG_PATH` | no | `<project-root>/local.config.json` |
| `ALLOW_LOCAL_SCIVERSE_CONFIG` | no | `true` |
| `REQUEST_TIMEOUT_SECONDS` | no | `20` |
| `CACHE_TTL_SECONDS` | no | `300` |
| `MAX_REQUEST_BODY_BYTES` | no | `262144` |
| `MODEL_BASE_URL` | no | `https://api.openai.com/v1` |
| `MODEL_NAME` | no | `gpt-4.1-mini` |
| `MODEL_TIMEOUT_SECONDS` | no | `30` |
| `ALLOW_LOCAL_MODEL_CONFIG` | no | `true` |

This standalone local application accepts OpenAI-compatible model endpoints
over HTTP or HTTPS. Users should prefer HTTPS because HTTP transmits prompts
and credentials without transport encryption.

The application has no fixture or local-data runtime mode. Without a configured
Sciverse key, all research-data routes fail closed with HTTP 503 and the
frontend shows a connection prompt. `local.config.json` stores the Sciverse and
model connections together as plaintext and is ignored by Git. It never stores
papers or graph payloads.

## Health and local runtime

- Liveness/readiness: `GET /healthz`
- The backend listens on `127.0.0.1:8040`.
- The Vite frontend listens on `127.0.0.1:3040` and proxies `/api/*` and
  `/healthz` to the backend.
- CORS allows only configured local development origins; the deployment uses
  same-origin access.
- Do not expose the local settings API to an untrusted network. The settings
  page is intended for this standalone single-user application.

## Token rotation

1. Create or obtain the replacement Sciverse API key.
2. Update it in Local Settings, or update the backend secret/environment for an
   unattended deployment.
3. Test the connection in Local Settings or run `make prod-smoke`.
4. Revoke the previous key after smoke tests pass.

No frontend rebuild is required.

## Rollback

Check out the previous release and reinstall its Python and npm dependencies.
The application performs read-only Sciverse calls. The required model
configuration is local user state and does not require a data migration. Keep
the same keys unless rotation caused the incident.
