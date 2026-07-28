from __future__ import annotations

import json

import pytest

from app.local_config import LocalConfigDocument
from app.model_config import ModelConfigStore, ModelConfigUpdate, ModelConnection
from app.sciverse_config import (
    SciverseConfigStore,
    SciverseConfigUpdate,
    SciverseConnection,
)


def test_sciverse_config_is_owner_only_and_never_returns_secret(tmp_path) -> None:
    path = tmp_path / "nested" / "sciverse.json"
    store = SciverseConfigStore(
        path,
        SciverseConnection(base_url="https://api.sciverse.test"),
    )

    status = store.update(
        SciverseConfigUpdate(
            base_url="https://api.sciverse.test",
            api_key="unit-test-value",
            timeout_seconds=12,
        )
    )

    assert status.configured is True
    assert status.api_key_set is True
    assert status.api_key_hint == "••••alue"
    assert "secret-value" not in status.model_dump_json()
    assert path.stat().st_mode & 0o777 == 0o600


def test_remote_sciverse_plain_http_is_rejected() -> None:
    with pytest.raises(ValueError, match="HTTPS"):
        SciverseConfigUpdate(
            base_url="http://api.sciverse.test",
            api_key="test-key",
        )


def test_local_sciverse_plain_http_is_allowed_for_development() -> None:
    update = SciverseConfigUpdate(
        base_url="http://127.0.0.1:3022",
        api_key="test-key",
    )

    assert update.base_url == "http://127.0.0.1:3022"


def test_resolving_sciverse_draft_does_not_write_local_config(tmp_path) -> None:
    path = tmp_path / "local.config.json"
    store = SciverseConfigStore(
        path,
        SciverseConnection(base_url="https://api.sciverse.test"),
    )

    connection = store.resolve(
        SciverseConfigUpdate(
            base_url="https://draft.sciverse.test",
            api_key="draft-test-value",
            timeout_seconds=17,
        )
    )

    assert connection.base_url == "https://draft.sciverse.test"
    assert connection.api_key is not None
    assert connection.api_key.get_secret_value() == "draft-test-value"
    assert connection.timeout_seconds == 17
    assert not path.exists()


def test_sciverse_and_model_share_one_plaintext_project_json(tmp_path) -> None:
    path = tmp_path / "local.config.json"
    document = LocalConfigDocument(path)
    sciverse = SciverseConfigStore(
        document,
        SciverseConnection(base_url="https://api.sciverse.test"),
    )
    model = ModelConfigStore(
        document,
        ModelConnection(base_url="https://models.example/v1", model="demo"),
    )

    sciverse.update(
        SciverseConfigUpdate(
            base_url="https://api.sciverse.test",
            api_key="sciverse-test",
        )
    )
    model.update(
        ModelConfigUpdate(
            base_url="https://models.example/v1",
            model="demo",
            api_key="model-test",
        )
    )

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["sciverse"]["api_key"] == "sciverse-test"
    assert payload["model"]["api_key"] == "model-test"
    assert set(payload) == {"sciverse", "model"}
