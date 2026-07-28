from __future__ import annotations

import json
import os
from pathlib import Path
from threading import Lock
from typing import Any


class LocalConfigDocument:
    """One plaintext JSON document for this local single-user application."""

    def __init__(self, path: Path) -> None:
        self.path = path.expanduser().resolve()
        self._lock = Lock()

    def section(self, name: str) -> dict[str, Any] | None:
        with self._lock:
            value = self._read().get(name)
            return value if isinstance(value, dict) else None

    def update_section(self, name: str, value: dict[str, Any]) -> None:
        with self._lock:
            document = self._read()
            document[name] = value
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(f"{self.path.suffix}.tmp")
            temporary.write_text(
                json.dumps(document, ensure_ascii=True, indent=2) + "\n",
                encoding="utf-8",
            )
            os.chmod(temporary, 0o600)
            temporary.replace(self.path)
            os.chmod(self.path, 0o600)

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError, TypeError):
            return {}
