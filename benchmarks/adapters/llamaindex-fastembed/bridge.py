#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = [
#   "fastembed==0.8.0",
#   "llama-index-core==0.14.23",
#   "llama-index-embeddings-fastembed==0.6.0",
# ]
# ///

import json
import os
import sys
from time import perf_counter
from typing import Any

os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from llama_index.core.llms import ChatMessage, MessageRole
from llama_index.core.memory import VectorMemory
from llama_index.embeddings.fastembed import FastEmbedEmbedding

PROTOCOL_VERSION = "rembero.memory-stack.v1"
MODEL_ID = "BAAI/bge-small-en-v1.5"


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def run_question(
    test_case: dict[str, Any],
    question: dict[str, Any],
    embedding: FastEmbedEmbedding,
) -> dict[str, Any]:
    started = perf_counter()
    limit_value = question.get("topK", 5)
    limit = limit_value if isinstance(limit_value, int) and limit_value > 0 else 5
    memory = VectorMemory.from_defaults(
        embed_model=embedding,
        retriever_kwargs={"similarity_top_k": limit},
    )
    include_tentative = question.get("includeTentative") is True
    for event_value in test_case["events"]:
        event = require_object(event_value, "event")
        if event.get("trust") == "tentative" and not include_tentative:
            continue
        memory.put(
            ChatMessage(
                role=MessageRole.USER,
                content=str(event["text"]),
                additional_kwargs={"event_id": str(event["id"])},
            )
        )
    matches = memory.get(input=str(question["text"]))
    event_ids = [
        str(message.additional_kwargs["event_id"])
        for message in matches
        if "event_id" in message.additional_kwargs
    ]
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


def main() -> None:
    request = require_object(json.load(sys.stdin), "request")
    if request.get("protocolVersion") != PROTOCOL_VERSION:
        raise ValueError("unsupported protocol version")
    test_case = require_object(request.get("case"), "case")
    questions = test_case.get("questions")
    events = test_case.get("events")
    if not isinstance(questions, list) or not isinstance(events, list):
        raise ValueError("case questions and events must be arrays")
    embedding = FastEmbedEmbedding(
        model_name=MODEL_ID,
        providers=["CPUExecutionProvider"],
        doc_embed_type="passage",
    )
    response = {
        "caseId": str(test_case["id"]),
        "questions": [
            run_question(test_case, require_object(question, "question"), embedding)
            for question in questions
        ],
    }
    json.dump(response, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
