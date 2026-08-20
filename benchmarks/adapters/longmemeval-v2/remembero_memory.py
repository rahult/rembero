from __future__ import annotations

import atexit
import json
from pathlib import Path
import subprocess
import threading
from typing import Any

from memory_modules.memory import Memory, MemoryContextItem, register_memory, require


@register_memory
class RememberoMemory(Memory):
    """Official LongMemEval-V2 backend using Remembero local sourced-state search."""

    memory_type = "remembero"

    def __init__(self, memory_params: dict[str, object]) -> None:
        super().__init__(memory_params)
        bridge = memory_params.get("bridge_path")
        bridge_path = (
            Path(str(bridge)).expanduser().resolve()
            if bridge
            else Path(__file__).with_name("bridge.mjs").resolve()
        )
        require(bridge_path.exists(), f"Missing Remembero bridge: {bridge_path}")
        self.top_k = int(memory_params.get("top_k", 6))
        self.source_characters = int(memory_params.get("source_characters", 16384))
        self.context_characters = int(memory_params.get("context_characters", 12000))
        require(1 <= self.top_k <= 100, "top_k must be from 1 to 100")
        require(1 <= self.source_characters <= 32768, "source_characters must be from 1 to 32768")
        require(256 <= self.context_characters <= 32768, "context_characters must be from 256 to 32768")
        self._lock = threading.Lock()
        self._last_metadata: dict[str, object] = {}
        self._process = subprocess.Popen(
            [str(memory_params.get("node_binary", "node")), str(bridge_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            bufsize=1,
        )
        atexit.register(self.close)

    def _call(self, payload: dict[str, object]) -> dict[str, Any]:
        with self._lock:
            require(self._process.poll() is None, "Remembero bridge is not running")
            require(self._process.stdin is not None, "Remembero bridge stdin is unavailable")
            require(self._process.stdout is not None, "Remembero bridge stdout is unavailable")
            self._process.stdin.write(json.dumps(payload, ensure_ascii=True) + "\n")
            self._process.stdin.flush()
            line = self._process.stdout.readline()
            require(bool(line), "Remembero bridge closed without a response")
            response = json.loads(line)
            require(isinstance(response, dict), "Remembero bridge response must be an object")
            require(response.get("ok") is True, f"Remembero bridge error: {response.get('error')}")
            result = response.get("result")
            require(isinstance(result, dict), "Remembero bridge result must be an object")
            return result

    def insert(self, trajectory: dict[str, object]) -> None:
        self._call({
            "op": "insert",
            "trajectory": trajectory,
            "sourceCharacters": self.source_characters,
        })

    def query(
        self,
        query: str,
        query_image: str | None = None,
    ) -> list[MemoryContextItem]:
        result = self._call({
            "op": "query",
            "query": query,
            "topK": self.top_k,
            "sourceCharacters": self.source_characters,
            "contextCharacters": self.context_characters,
        })
        items = result.get("items")
        require(isinstance(items, list), "Remembero bridge items must be a list")
        self._last_metadata = dict(result.get("metadata") or {})
        self._last_metadata["query_image_ignored"] = query_image is not None
        return items

    def post_query_hook(
        self,
        *,
        query: str,
        query_image: str | None,
        memory_context: list[MemoryContextItem],
    ) -> dict[str, object] | None:
        return dict(self._last_metadata)

    def close(self) -> None:
        process = getattr(self, "_process", None)
        if process is None or process.poll() is not None:
            return
        try:
            self._call({"op": "close"})
        except Exception:
            pass
        try:
            process.terminate()
            process.wait(timeout=5)
        except Exception:
            process.kill()
