#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path
import sys


def load_local_env() -> None:
    env_path = Path(__file__).resolve().parents[3] / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if value[:1] == value[-1:] and value.startswith(("'", '"')):
            value = value[1:-1]
        if key:
            os.environ.setdefault(key, value)


def main() -> None:
    load_local_env()
    if "OPENAI_API_KEY" not in os.environ and os.getenv("LLM_API_KEY"):
        os.environ["OPENAI_API_KEY"] = str(os.environ["LLM_API_KEY"])
    harness_root_raw = os.getenv("LME_V2_HARNESS_ROOT")
    if not harness_root_raw:
        raise SystemExit("LME_V2_HARNESS_ROOT is required")
    harness_root = Path(harness_root_raw).expanduser().resolve()
    if not (harness_root / "evaluation" / "harness.py").exists():
        raise SystemExit(f"Invalid LongMemEval-V2 harness root: {harness_root}")
    sys.path.insert(0, str(harness_root))
    import remembero_memory  # noqa: F401
    from evaluation.harness import main as harness_main

    harness_main()


if __name__ == "__main__":
    main()
