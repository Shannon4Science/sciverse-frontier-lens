from __future__ import annotations

from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import router
from app.config import get_settings
from app.errors import UpstreamError
from app.local_config import LocalConfigDocument
from app.model_config import ModelConfigStore, ModelConnection
from app.model_runtime import GuideGenerator, ModelRuntime, QueryPlanner
from app.models import Coverage, EdgeType, ProductCapabilities
from app.sciverse_config import (
    SciverseConfigStore,
    SciverseConnection,
    activate_sciverse_connection,
)


@asynccontextmanager
async def lifespan(application: FastAPI):
    await activate_sciverse_connection(
        application,
        application.state.sciverse_store.load(),
    )
    yield
    close = (
        getattr(application.state.gateway, "close", None)
        if application.state.gateway is not None
        else None
    )
    if close is not None:
        await close()


def create_app() -> FastAPI:
    settings = get_settings()
    application = FastAPI(
        title="FrontierLens API",
        version="0.3.0",
        lifespan=lifespan,
    )
    local_config = LocalConfigDocument(settings.local_config_path)
    sciverse_store = SciverseConfigStore(
        local_config,
        SciverseConnection(
            base_url=settings.sciverse_api_base_url,
            api_key=settings.sciverse_api_token,
            timeout_seconds=settings.request_timeout_seconds,
        ),
    )
    sciverse_connection = sciverse_store.load()
    application.state.gateway = None
    application.state.sciverse_store = sciverse_store
    application.state.cache_ttl_seconds = settings.cache_ttl_seconds
    application.state.allow_local_sciverse_config = (
        settings.allow_local_sciverse_config
    )
    model_store = ModelConfigStore(
        local_config,
        ModelConnection(
            base_url=settings.model_base_url,
            model=settings.model_name,
            api_key=settings.model_api_key,
            timeout_seconds=settings.model_timeout_seconds,
        ),
    )
    model_runtime = ModelRuntime(model_store)
    application.state.model_store = model_store
    application.state.model_runtime = model_runtime
    application.state.query_planner = QueryPlanner(model_runtime)
    application.state.guide_generator = GuideGenerator(model_runtime)
    application.state.allow_local_model_config = settings.allow_local_model_config
    application.state.product_capabilities = ProductCapabilities(
        contract_version="2026-07-24",
        mode="production" if sciverse_connection.configured else "unconfigured",
        coverage=Coverage(
            current_focus="AI conference papers with completed Paper Schema extraction",
            paper_count="1M+",
            empty_result_message=(
                "No match was found in the current Sciverse Paper Schema corpus. "
                "This does not mean the research is absent from the scholarly literature."
            ),
        ),
        resources=[
            "paper_search",
            "paper_entities",
            "internal_relations",
            "complete_references",
            "citation_graph",
            "evidence",
            "provenance",
            "query_planning",
            "research_guide",
        ],
        edge_types=list(EdgeType),
        limits={
            "topic_graph_default_papers": 60,
            "citation_graph_max_nodes": 500,
            "citation_graph_max_edges": 500,
            "material_batch_schema_ids": 20,
            "evidence_hydrate_items": 50,
        },
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT"],
        allow_headers=["Content-Type", "X-Request-ID"],
    )

    @application.middleware("http")
    async def add_request_id(request: Request, call_next):
        rid = request.headers.get("x-request-id") or str(uuid4())
        request.state.request_id = rid
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                too_large = int(content_length) > settings.max_request_body_bytes
            except ValueError:
                too_large = True
            if too_large:
                return JSONResponse(
                    status_code=413,
                    content={
                        "error": {
                            "code": "REQUEST_TOO_LARGE",
                            "message": "Request body exceeds the configured limit",
                            "retryable": False,
                            "request_id": rid,
                        }
                    },
                    headers={"X-Request-ID": rid},
                )
        response = await call_next(request)
        response.headers["X-Request-ID"] = rid
        return response

    @application.exception_handler(UpstreamError)
    async def upstream_error_handler(_: Request, exc: UpstreamError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "code": exc.code,
                    "message": exc.message,
                    "retryable": exc.retryable,
                    "request_id": exc.request_id,
                }
            },
            headers=(
                {"Retry-After": str(exc.retry_after)}
                if exc.retry_after is not None
                else None
            ),
        )

    @application.get("/healthz", include_in_schema=False)
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    application.include_router(router)

    return application


app = create_app()
