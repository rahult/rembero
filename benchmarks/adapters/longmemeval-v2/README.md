# LongMemEval-V2 adapter

This adapter implements the official `Memory.insert` / `Memory.query` contract at pinned
LongMemEval-V2 revision `2cc8c540bdb87fe6761629b585e727e1c4704520`.

Each trajectory state becomes one sourced Remembero fact in a persistent Node sidecar.
`query` runs bounded local source search, keeps at most two states per trajectory, and
returns at most six text evidence items. The
backend receives only the official trajectory objects and question text/image path; it never
receives question IDs, types, gold answers, or evaluator configuration.

The first evidence lane is text-only. It indexes goals, outcomes, URLs, actions, thoughts,
and accessibility trees, and explicitly reports when a question image was ignored. It does
not claim multimodal support.

The default lane is lexical-only: zero model calls, zero embedding calls, and zero provider
cost. For accuracy-sensitive deployments, the checked-in
`memory_config.semantic.json` enables a prepared state-level semantic index. It embeds
bounded 1,400-character state summaries after the configured 100 inserts, then uses one
query embedding plus local lexical/proof ranking. Maintenance time and provider usage are
reported separately from user-turn retrieval; the semantic lane never establishes answer
authority, and summaries pass the same sensitive-text redaction boundary before leaving the
process.

On the same ten-question official pilot, the prepared semantic lane scored 6/10 versus 3/10
for the lexical pilot, with 0.51 s memory-query p95. Its measured one-time maintenance was
46.8 s for 3,358 states and $0.00538 embedding cost for the shared 100-trajectory haystack.
These are pilot measurements, not universal guarantees; use the lexical config when the
provider boundary or maintenance budget is unacceptable.

Run through the pinned official harness after building Remembero with Python 3.11, the
official requirements, and CPU-appropriate Torch/Torchvision packages. The official Qwen
processor imports Torch/Torchvision even for text-only token counting.

```bash
export LME_V2_HARNESS_ROOT=/absolute/path/to/LongMemEval-V2
export OPENAI_API_KEY=...
export OPENAI_BASE_URL=https://openrouter.ai/api/v1

npm run bench:longmemeval:v2:prepare -- \
  --data-root /absolute/path/to/longmemeval-v2 \
  --output-root /tmp/remembero-lme-v2-subset \
  --domain enterprise \
  --count 10 \
  --exclude 01307e07

python benchmarks/adapters/longmemeval-v2/run_official.py \
  --domain enterprise \
  --questions-path /tmp/remembero-lme-v2-subset/questions.json \
  --haystack-path /tmp/remembero-lme-v2-subset/haystack.json \
  --trajectories-path /tmp/remembero-lme-v2-subset/trajectories-small.jsonl \
  --memory-config-path benchmarks/adapters/longmemeval-v2/memory_config.json \
  --output-dir /tmp/remembero-lme-v2-enterprise \
  --model qwen/qwen3.5-9b \
  --base-url https://openrouter.ai/api/v1 \
  --api-key-env OPENAI_API_KEY \
  --temperature 0.6 \
  --top-p 0.95 \
  --top-k 20 \
  --max-completion-tokens 20000 \
  --memory-context-max-tokens 200000 \
  --reader-max-concurrent-requests 1 \
  --prompt-build-max-workers 1 \
  --evaluator-model openai/gpt-5.2
```
