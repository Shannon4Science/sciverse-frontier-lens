# FrontierLens Backend

FastAPI backend-for-frontend for the public Sciverse Paper Schema API.

It owns server-side Bearer authentication, request IDs, timeouts, retries,
cursor pagination, TTL caching, in-flight request coalescing, strict request
models, output allowlists, graph assembly, and safe error envelopes.

The backend does not expose its upstream token or call OpenSearch directly.
