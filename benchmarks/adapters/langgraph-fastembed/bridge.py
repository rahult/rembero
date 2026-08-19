#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = [
#   "fastembed==0.8.0",
#   "langgraph==1.2.10",
# ]
# ///

import json
import os
import sys
from time import perf_counter
from typing import Any

os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from fastembed import TextEmbedding
from langchain_core.embeddings import Embeddings
from langgraph.store.memory import InMemoryStore

PROTOCOL_VERSION = "rembero.memory-stack.v1"
MODEL_ID = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIMENSIONS = 384


class FastEmbedEmbeddings(Embeddings):
    def __init__(self) -> None:
        self.model = TextEmbedding(
            model_name=MODEL_ID,
            providers=["CPUExecutionProvider"],
        )

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [vector.tolist() for vector in self.model.passage_embed(texts)]

    def embed_query(self, text: str) -> list[float]:
        return next(self.model.query_embed([text])).tolist()


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def run_question(
    test_case: dict[str, Any],
    question: dict[str, Any],
    embeddings: FastEmbedEmbeddings,
) -> dict[str, Any]:
    started = perf_counter()
    store = InMemoryStore(
        index={
            "dims": EMBEDDING_DIMENSIONS,
            "embed": embeddings,
            "fields": ["text"],
        }
    )
    namespace = ("remembero-benchmark", str(test_case["id"]), str(question["id"]))
    include_tentative = question.get("includeTentative") is True
    for event_value in test_case["events"]:
        event = require_object(event_value, "event")
        if event.get("trust") == "tentative" and not include_tentative:
            continue
        store.put(
            namespace,
            str(event["id"]),
            {
                "text": str(event["text"]),
                "at": str(event["at"]),
                "trust": str(event["trust"]),
            },
        )
    limit_value = question.get("topK", 5)
    limit = limit_value if isinstance(limit_value, int) and limit_value > 0 else 5
    matches = store.search(
        namespace,
        query=str(question["text"]),
        limit=limit,
    )
    return {
        "questionId": str(question["id"]),
        "status": "unsupported",
        "answerRows": [],
        "retrieved": [
            {"eventId": str(item.key), "rank": index + 1}
            for index, item in enumerate(matches)
        ],
        "citations": [],
        "wallMs": (perf_counter() - started) * 1000,
    }


def main() -> None:
    request = require_object(json.load(sys.stdin), "request")
    if request.get("protocolVersion") != PROTOCOL_VERSION:
        raise ValueError("unsupported protocol version")
    test_case = require_object(request.get("case"), "case")
    questions = test_case.get("questions")
    events = test_case.get("events")
    if not isinstance(questions, list) or not isinstance(events, list):
        raise ValueError("case questions and events must be arrays")
    embeddings = FastEmbedEmbeddings()
    response = {
        "caseId": str(test_case["id"]),
        "questions": [
            run_question(test_case, require_object(question, "question"), embeddings)
            for question in questions
        ],
    }
    json.dump(response, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
