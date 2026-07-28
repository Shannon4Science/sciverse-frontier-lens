# Security Policy

## Supported versions

Security fixes are applied to the latest released version.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or exposed
credential. Report it privately to the OpenDataLab maintainers through the
security reporting channel configured for this GitHub repository. Include the
affected version, reproduction steps, impact, and any proposed mitigation.

Never include a real Sciverse key, model key, prompt containing private data,
or `local.config.json` in a report.

## Local security model

FrontierLens is a local, single-user application:

- it listens on `127.0.0.1` by default;
- Sciverse and model credentials stay in the Python process;
- the browser calls only same-origin `/api/*` routes;
- credentials are stored as plaintext in `local.config.json`;
- the config file is created with owner-only permissions where supported;
- paper, graph, Entity, Relation, Citation, Evidence, and paragraph responses
  are not persisted by FrontierLens;
- the application does not access OpenSearch, S3, SQLite paper stores, or
  internal index names.

Do not expose FrontierLens directly to the public internet. Do not commit
`.env` or `local.config.json`. Prefer HTTPS model endpoints; an HTTP model
endpoint transmits the model key and prompts without transport encryption.

## Secret response

If a key is accidentally committed:

1. revoke or rotate it immediately;
2. remove it from the complete Git history;
3. verify that CI artifacts, logs, screenshots, and releases do not contain it;
4. run the repository secret scan before publishing again.
