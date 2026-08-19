#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = [
#   "fastembed==0.8.0",
#   "mem0ai==2.0.14",
# ]
# ///

import json
import os
import re
import sys
import tempfile
import threading
from pathlib import Path
from time import perf_counter
from typing import Any

os.environ["MEM0_TELEMETRY"] = "false"
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from mem0 import Memory

PROTOCOL_VERSION = "rembero.memory-stack.v1"
LLM_MODEL = "openai/gpt-5.6-luna"
EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIMENSIONS = 384


class Usage:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.model_calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.cost_usd = 0.0

    def callback(self, _client: Any, response: Any, _params: dict[str, Any]) -> None:
        payload = response.model_dump()
        usage = payload.get("usage") or {}
        input_tokens = int(usage.get("prompt_tokens") or 0)
        output_tokens = int(usage.get("completion_tokens") or 0)
        cost = float(usage.get("cost") or 0.0)
        with self._lock:
            self.model_calls += 1
            self.input_tokens += input_tokens
            self.output_tokens += output_tokens
            self.cost_usd += cost

    def payload(self) -> dict[str, Any]:
        return {
            "modelCalls": self.model_calls,
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "totalTokens": self.input_tokens + self.output_tokens,
            "costUsd": self.cost_usd,
        }


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def safe_id(value: Any) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", str(value)).strip("-") or "case"


def create_memory(root: Path, identifier: str, usage: Usage) -> Memory:
    return Memory.from_config(
        {
            "vector_store": {
                "provider": "qdrant",
                "config": {
                    "collection_name": f"remembero-{identifier}",
                    "path": str(root / f"qdrant-{identifier}"),
                    "embedding_model_dims": EMBEDDING_DIMENSIONS,
                },
            },
            "llm": {
                "provider": "openai",
                "config": {
                    "model": LLM_MODEL,
                    "temperature": 0,
                    "max_tokens": 512,
                    "openrouter_base_url": "https://openrouter.ai/api/v1",
                    "response_callback": usage.callback,
                },
            },
            "embedder": {
                "provider": "fastembed",
                "config": {
                    "model": EMBEDDING_MODEL,
                    "embedding_dims": EMBEDDING_DIMENSIONS,
                },
            },
            "history_db_path": str(root / f"history-{identifier}.db"),
            "custom_instructions": (
                "Every input is a durable knowledge record. Store its concrete statement, "
                "including named relationships, lineage, policy or rule statements, revision "
                "numbers, and uncertainty markers. Do not invent unstated facts."
            ),
        }
    )


def close_memory(memory: Memory) -> None:
    vector_store = getattr(memory, "vector_store", None)
    client = getattr(vector_store, "client", None)
    close = getattr(client, "close", None)
    if callable(close):
        close()


def run_question(
    root: Path,
    test_case: dict[str, Any],
    question: dict[str, Any],
    usage: Usage,
) -> dict[str, Any]:
    identifier = f"{safe_id(test_case['id'])}-{safe_id(question['id'])}"
    memory = create_memory(root, identifier, usage)
    started = perf_counter()
    include_tentative = question.get("includeTentative") is True
    user_id = f"remembero-{identifier}"
    try:
        for event_value in test_case["events"]:
            event = require_object(event_value, "event")
            if event.get("trust") == "tentative" and not include_tentative:
                continue
            memory.add(
                str(event["text"]),
                user_id=user_id,
                metadata={
                    "event_id": str(event["id"]),
                    "at": str(event["at"]),
                    "trust": str(event["trust"]),
                },
            )
        limit_value = question.get("topK", 5)
        limit = limit_value if isinstance(limit_value, int) and limit_value > 0 else 5
        response = memory.search(
            str(question["text"]),
            filters={"user_id": user_id},
            limit=limit,
        )
        results = response.get("results", []) if isinstance(response, dict) else []
        event_ids: list[str] = []
        for result_value in results:
            result = require_object(result_value, "search result")
            metadata = result.get("metadata")
            if not isinstance(metadata, dict) or "event_id" not in metadata:
                continue
            event_id = str(metadata["event_id"])
            if event_id not in event_ids:
                event_ids.append(event_id)
        event_ids = event_ids[:limit]
        return {
            "questionId": str(question["id"]),
            "status": "unsupported",
            "answerRows": [],
            "retrieved": [
                {"eventId": event_id, "rank": index + 1}
                for index, event_id in enumerate(event_ids)
            ],
            "citations": [],
            "wallMs": (perf_counter() - started) * 1000,
        }
    finally:
        close_memory(memory)


def main() -> None:
    request = require_object(json.load(sys.stdin), "request")
    if request.get("protocolVersion") != PROTOCOL_VERSION:
        raise ValueError("unsupported protocol version")
    test_case = require_object(request.get("case"), "case")
    questions = test_case.get("questions")
    events = test_case.get("events")
    if not isinstance(questions, list) or not isinstance(events, list):
        raise ValueError("case questions and events must be arrays")
    usage = Usage()
    with tempfile.TemporaryDirectory(prefix="remembero-mem0-") as temp:
        root = Path(temp)
        response = {
            "caseId": str(test_case["id"]),
            "questions": [
                run_question(root, test_case, require_object(question, "question"), usage)
                for question in questions
            ],
            "providerUsage": usage.payload(),
        }
        json.dump(response, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
