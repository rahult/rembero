#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = [
#   "fastembed==0.8.0",
#   "falkordblite==0.10.0",
#   "graphiti-core[falkordblite]==0.29.3",
#   "httpx==0.28.1",
#   "openai==3.3.1",
#   "redis==8.1.0",
# ]
# ///

import asyncio
import json
import logging
import os
import re
import sys
import tempfile
import threading
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path
from time import perf_counter
from typing import Any

os.environ["EMBEDDING_DIM"] = "384"
os.environ["GRAPHITI_TELEMETRY_ENABLED"] = "false"
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import httpx
from fastembed import TextEmbedding
from graphiti_core import Graphiti
from graphiti_core.cross_encoder.client import CrossEncoderClient
from graphiti_core.driver.falkordb_driver import FalkorDriver
from graphiti_core.embedder import EmbedderClient
from graphiti_core.llm_client.config import LLMConfig
from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
from graphiti_core.nodes import EpisodeType
from graphiti_core.utils.bulk_utils import RawEpisode
from openai import AsyncOpenAI
from redislite.async_falkordb_client import AsyncFalkorDB

PROTOCOL_VERSION = "rembero.memory-stack.v1"
LLM_MODEL = "openai/gpt-5.6-luna"
EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIMENSIONS = 384
OPENROUTER_URL = "https://openrouter.ai/api/v1"

logging.getLogger().setLevel(logging.ERROR)


class Usage:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.model_calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.cost_usd = 0.0

    async def response_hook(self, response: httpx.Response) -> None:
        if not response.request.url.path.endswith("/chat/completions"):
            return
        await response.aread()
        try:
            payload = response.json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            return
        usage = payload.get("usage") if isinstance(payload, dict) else None
        if not isinstance(usage, dict):
            return
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


class FastEmbedClient(EmbedderClient):
    def __init__(self) -> None:
        self.model = TextEmbedding(
            model_name=EMBEDDING_MODEL,
            providers=["CPUExecutionProvider"],
        )

    async def create(
        self,
        input_data: str | list[str] | Iterable[int] | Iterable[Iterable[int]],
    ) -> list[float]:
        if isinstance(input_data, str):
            return next(self.model.query_embed([input_data])).tolist()
        values = list(input_data)
        if not values or not isinstance(values[0], str):
            raise ValueError("Graphiti FastEmbed input must contain text")
        return next(self.model.passage_embed([str(values[0])])).tolist()

    async def create_batch(self, input_data_list: list[str]) -> list[list[float]]:
        return [vector.tolist() for vector in self.model.passage_embed(input_data_list)]


class NoOpCrossEncoder(CrossEncoderClient):
    async def rank(self, query: str, passages: list[str]) -> list[tuple[str, float]]:
        del query
        return [
            (passage, float(len(passages) - index))
            for index, passage in enumerate(passages)
        ]


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TypeError(f"{label} must be an object")
    return value


def safe_id(value: Any) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", str(value)).strip("-") or "case"


def event_time(value: Any) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def event_ids_from_edges(
    edges: list[Any],
    episode_ids: dict[str, str],
    limit: int,
) -> list[str]:
    event_ids: list[str] = []
    for edge in edges:
        for episode_uuid in getattr(edge, "episodes", []):
            event_id = episode_ids.get(str(episode_uuid))
            if event_id is not None and event_id not in event_ids:
                event_ids.append(event_id)
                if len(event_ids) >= limit:
                    return event_ids
    return event_ids


async def run_question(
    root: Path,
    test_case: dict[str, Any],
    question: dict[str, Any],
    usage: Usage,
    llm_client: OpenAIGenericClient,
    embeddings: FastEmbedClient,
) -> dict[str, Any]:
    identifier = f"{safe_id(test_case['id'])}-{safe_id(question['id'])}"
    database = identifier[:63]
    falkor_db = AsyncFalkorDB(dbfilename=str(root / f"{identifier}.db"))
    driver = FalkorDriver(falkor_db=falkor_db, database=database)
    graphiti = Graphiti(
        graph_driver=driver,
        llm_client=llm_client,
        embedder=embeddings,
        cross_encoder=NoOpCrossEncoder(),
        max_coroutines=4,
    )
    started = perf_counter()
    include_tentative = question.get("includeTentative") is True
    events: list[dict[str, Any]] = []
    for event_value in test_case["events"]:
        event = require_object(event_value, "event")
        if event.get("trust") != "tentative" or include_tentative:
            events.append(event)
    try:
        await graphiti.build_indices_and_constraints()
        formed = await graphiti.add_episode_bulk(
            [
                RawEpisode(
                    name=str(event["id"]),
                    content=str(event["text"]),
                    source_description="Remembero memory-stack benchmark event",
                    source=EpisodeType.text,
                    reference_time=event_time(event["at"]),
                )
                for event in events
            ],
            group_id=database,
            custom_extraction_instructions=(
                "Extract only explicit durable claims and named relationships from each "
                "episode. Preserve concrete names, values, revision markers, uncertainty, "
                "and stated policies. Do not invent unstated facts or apply policy rules."
            ),
        )
        episode_ids = {
            str(episode.uuid): str(event["id"])
            for episode, event in zip(formed.episodes, events, strict=True)
        }
        limit_value = question.get("topK", 5)
        limit = limit_value if isinstance(limit_value, int) and limit_value > 0 else 5
        edges = await graphiti.search(
            str(question["text"]),
            group_ids=[database],
            num_results=max(limit * 3, limit),
        )
        event_ids = event_ids_from_edges(edges, episode_ids, limit)
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
        await falkor_db.connection.shutdown(nosave=True, now=True, force=True)
        await graphiti.close()


async def async_main() -> None:
    request = require_object(json.load(sys.stdin), "request")
    if request.get("protocolVersion") != PROTOCOL_VERSION:
        raise ValueError("unsupported protocol version")
    test_case = require_object(request.get("case"), "case")
    questions = test_case.get("questions")
    events = test_case.get("events")
    if not isinstance(questions, list) or not isinstance(events, list):
        raise TypeError("case questions and events must be arrays")

    usage = Usage()
    http_client = httpx.AsyncClient(event_hooks={"response": [usage.response_hook]})
    openai_client = AsyncOpenAI(
        api_key=os.environ["OPENROUTER_API_KEY"],
        base_url=OPENROUTER_URL,
        http_client=http_client,
    )
    llm_client = OpenAIGenericClient(
        config=LLMConfig(
            api_key=os.environ["OPENROUTER_API_KEY"],
            model=LLM_MODEL,
            small_model=LLM_MODEL,
            base_url=OPENROUTER_URL,
            temperature=0,
            max_tokens=2_048,
        ),
        client=openai_client,
        max_tokens=2_048,
        structured_output_mode="json_object",
    )
    embeddings = FastEmbedClient()
    try:
        with tempfile.TemporaryDirectory(prefix="remembero-graphiti-") as temp:
            root = Path(temp)
            response = {
                "caseId": str(test_case["id"]),
                "questions": [
                    await run_question(
                        root,
                        test_case,
                        require_object(question, "question"),
                        usage,
                        llm_client,
                        embeddings,
                    )
                    for question in questions
                ],
                "providerUsage": usage.payload(),
            }
            json.dump(response, sys.stdout, separators=(",", ":"))
    finally:
        await http_client.aclose()


def main() -> None:
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
