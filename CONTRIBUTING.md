# Contributing

## Development setup

Backend development requires Python 3.11+ and
[uv](https://docs.astral.sh/uv/). Frontend development additionally requires
Node.js 22+.

```bash
git clone https://github.com/Shannon4Science/sciverse-frontier-lens.git
cd sciverse-frontier-lens
make setup
```

Run the backend and frontend development servers in separate terminals:

```bash
make backend
make frontend
```

## Before opening a pull request

```bash
make lint
make test
make build
npm --prefix frontend audit --omit=dev --audit-level=high
```

Do not commit `frontend/dist`, `node_modules`, `.venv`, `.env`,
`local.config.json`, test output, screenshots containing keys, or live API
responses.

## Product contracts

- All research facts come from the public Sciverse Paper Schema API.
- An empty result is scoped to the current completed Schema corpus.
- Entity identity is paper-scoped.
- Internal Relation and paper-to-paper Citation remain distinct.
- Related suggestions are not factual edges.
- Model output may organize returned facts but cannot add papers, entities,
  relations, citations, or evidence.
- Public responses use explicit allowlists and never expose upstream raw
  payloads or credentials.

Add focused tests for behavior changes. Keep pull requests scoped and describe
their user-visible effect, data-contract effect, and verification results.
