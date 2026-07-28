from collections.abc import Mapping, Sequence
from typing import Any

from fastapi.testclient import TestClient

from app.main import app

FORBIDDEN_KEYS = {
    "raw",
    "raw_ref",
    "raw_path",
    "doc_kind",
    "starrocks_unique_id",
    "index",
    "index_name",
    "internal_04_relations",
}


def walk_keys(value: Any) -> set[str]:
    keys: set[str] = set()
    if isinstance(value, Mapping):
        for key, child in value.items():
            keys.add(str(key))
            keys.update(walk_keys(child))
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        for child in value:
            keys.update(walk_keys(child))
    return keys


def test_public_routes_do_not_expose_internal_keys() -> None:
    client = TestClient(app)
    response = client.get("/api/capabilities")
    assert response.status_code == 200
    assert not (walk_keys(response.json()) & FORBIDDEN_KEYS)


def test_openapi_does_not_define_authorization_token_input() -> None:
    client = TestClient(app)
    text = client.get("/openapi.json").text
    assert "SCIVERSE_API_TOKEN" not in text
    assert "starrocks_unique_id" not in text
    assert "/api/demo-graph" not in text
