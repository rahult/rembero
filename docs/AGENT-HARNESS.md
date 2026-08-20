# Add Remembero to an agent harness

This guide shows the narrow production pattern behind the browser lab:

```text
user question
  -> model selects a bounded Query tool
  -> harness validates the call
  -> Remembero evaluates memory and rules
  -> tool returns bindings, sources, and proof
  -> harness gives only that result to the model
  -> deterministic contract accepts, corrects, or blocks the answer
```

The model never receives the entire memory store and never receives mutation authority.

## Choose an integration path

| Path | Use it when | Remembero surface |
| --- | --- | --- |
| MCP server | Your harness already supports MCP tools | `remembero serve` |
| Embedded Node.js | You own a TypeScript agent runtime | `MemoryStore`, `recallQuestion`, `explainKnowledge` |
| SQLite adapter | Your application data already lives in SQLite | `openDatalogDatabase` or the SQLite extension |

Start with MCP unless your runtime needs an in-process database lifecycle.

## 1. Start the MCP server

Install and start Remembero over stdio:

```bash
npm install -g remembero
remembero serve
```

Equivalent harness configuration:

```json
{
  "mcpServers": {
    "remembero": {
      "command": "npx",
      "args": ["-y", "remembero", "serve"],
      "env": {
        "REMBERO_HOME": "/absolute/path/to/agent-memory"
      }
    }
  }
}
```

Raw tools such as `query`, `explain_query`, `assert_facts`, and
`check_integrity` do not require an LLM API key. Natural-language tools such as
`remember`, `recall`, and `recall_explain` require the configured LLM provider.

## 2. Expose one bounded agent tool

Keep the model-facing contract small and stable. A useful default is one semantic
`Query` function:

```ts
export const queryTool = {
  type: "function",
  function: {
    name: "Query",
    description:
      "Query governed long-term memory and return bindings, sources, and proof.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The user's memory question, unchanged",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
} as const;
```

Do not expose arbitrary SQL, filesystem paths, namespaces, integrity modes, or
write operations through this read tool. The harness supplies those values from
trusted application configuration.

## 3. Add the tool-use prompt

The prompt should describe tool policy, not memory content:

```text
Call the Query function exactly once with the user's question.
Do not invent another function or write SQL or Datalog yourself.
After the tool result is returned, answer using only that evidence.
If the result is unsupported or empty, say so explicitly.
```

No facts, rules, database rows, or expected answer belong in this first prompt.

## 4. Run the model -> tool -> model loop

This example is deliberately framework-neutral. Map `model.complete` and
`remembero.callTool` to your provider and MCP client.

```ts
type ToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

type HarnessDeps = {
  model: {
    complete(input: {
      messages: Array<Record<string, unknown>>;
      tools?: readonly unknown[];
      toolChoice?: unknown;
    }): Promise<{ text?: string; toolCall?: ToolCall }>;
  };
  remembero: {
    callTool(name: string, input: Record<string, unknown>): Promise<unknown>;
  };
};

const MAX_QUERY_CHARS = 2_000;

function validateQueryCall(call: ToolCall, question: string): string {
  if (call.name.toLowerCase() !== "query") {
    throw new Error("unexpected tool name");
  }

  const args = call.arguments as { query?: unknown };
  if (typeof args.query !== "string" || args.query !== question) {
    throw new Error("tool query must equal the user question");
  }
  if (args.query.length > MAX_QUERY_CHARS) {
    throw new Error("tool query is too large");
  }
  return args.query;
}

export async function runRememberoAgent(
  question: string,
  deps: HarnessDeps,
) {
  const first = await deps.model.complete({
    messages: [
      {
        role: "user",
        content: [
          "Call Query exactly once with the user's question.",
          "Do not answer until the tool result is available.",
          `Question: ${question}`,
        ].join("\n"),
      },
    ],
    tools: [queryTool],
    toolChoice: { type: "function", function: { name: "Query" } },
  });

  if (!first.toolCall) throw new Error("model did not call Query");
  const query = validateQueryCall(first.toolCall, question);

  const toolResult = await deps.remembero.callTool("recall_explain", {
    question: query,
    namespaces: ["agent"],
    answerMode: "evidence",
    proofLimit: 4,
  });

  const final = await deps.model.complete({
    messages: [
      {
        role: "system",
        content:
          "Answer using only TOOL_RESULT. Cite concrete bindings and sources. " +
          "If status is not answered, return an explicit non-answer.",
      },
      {
        role: "user",
        content: [
          `QUESTION: ${question}`,
          `TOOL_CALL: ${JSON.stringify(first.toolCall)}`,
          `TOOL_RESULT: ${JSON.stringify(toolResult)}`,
        ].join("\n"),
      },
    ],
  });

  return {
    answer: final.text ?? "",
    toolCall: first.toolCall,
    toolResult,
  };
}
```

The final prompt includes tool output because the model must phrase the result. It does
not include a memory dump or facts that the tool did not return.

## 5. Choose the Remembero read tool

### General personal or project memory

Use `recall_explain` when the tool receives natural-language questions:

```ts
await remembero.callTool("recall_explain", {
  question,
  namespaces: ["agent"],
  answerMode: "evidence",
  proofLimit: 4,
});
```

The result includes an explicit status, generated query, bindings, deterministic proof,
durable source statements, and a query-scoped graph.

### Governed application workflows

Use an allowlisted application router plus `explain_query` when the domain has known
relations and rules:

```ts
const preparedQueries = {
  "follow-up-maya": "needs_follow_up(maya, Project)",
  "schedule-atlas": "schedule_review(atlas, Day, Window, Blocker)",
} as const;

const datalog = preparedQueries[trustedCaseId];
const result = await remembero.callTool("explain_query", {
  query: datalog,
  namespaces: ["agent"],
  proofLimit: 4,
});
```

The model selects the semantic tool. Trusted application code selects the namespace,
prepared relation, limits, and authority.

## 6. Keep writes proposal-only

Do not let a model call accepted-memory mutation tools directly. Use:

```text
model -> propose_memory -> typed human review -> apply_memory_proposal
```

Apply reviewed proposals with a caller-stable `opId` so retries are idempotent. Run
integrity and knowledge checks before the commit. The agent proposes; deterministic
validation and explicit review own mutation authority.

## 7. Fail closed

Reject or hand off when any of these are true:

- tool name is not allowlisted (a provider label may be canonicalized only when the
  request exposed exactly one forced tool and all arguments pass validation);
- arguments fail schema validation;
- the model changes the user's query;
- the requested namespace is outside the agent's scope;
- recall status is `unanswerable`, `no_match`, or `schema_budget_exhausted`;
- proof, source, or result limits are exceeded;
- the answer contradicts bindings or omits required grounded values;
- a write lacks review, integrity checks, or an idempotency key.

Never silently replace a failed call with invented context.

## 8. Instrument the harness

Record these separately:

```text
model tool-call latency
tool name + validated arguments
Remembero/SQLite execution latency
bounded tool result size
final model latency
answer-contract outcome
handoff or mutation decision
```

Do not call end-to-end timings a model benchmark. Report the model, device, case, and
whether weights were already cached.

## 9. Test the boundary

At minimum, automate these cases:

1. valid call returns bindings and proof;
2. wrong tool name is rejected;
3. changed or oversized query is rejected;
4. empty memory produces an explicit non-answer;
5. contradictory answer fails the contract;
6. model never sees rows before tool execution;
7. unreviewed writes cannot mutate accepted memory;
8. retries with the same `opId` do not duplicate a write.

## System-prompt snippet

```markdown
## Remembero memory

- Use Query before answering questions that may depend on prior decisions, preferences,
  relationships, commitments, or governed application state.
- Treat tool bindings, sources, and proof as evidence; never invent missing values.
- If the tool returns a non-answer, say what is missing instead of guessing.
- Never mutate accepted memory directly. Propose changes for review.
```

## See the complete trace

The browser lab shows the prompt, native model tool call, SQL or Remembero execution,
tool result, final prompt, raw answer, and deterministic contract side by side:

<http://remembero.rahultrikha.com/labs/chat-memory>

## Measure the database boundary

Run the executable agent database gate after integrating:

```bash
npm run bench:agent-db:check
npm run bench:agent-db:scale -- --check
npm run bench:agent-db:cost
```

It verifies exact answers and citations, zero stale leakage, engine and real MCP latency,
a 100,000-fact indexed query/proof sweep, zero model/embedding/API-key cost for structured
queries, and provider-reported natural-language recall cost. See
[the current scorecard](AGENT-DATABASE-SCORECARD.md) for measured results and limitations.

### Route fuzzy recommendations explicitly

Use `semantic_search_knowledge` when the user asks for recommendations, preferences,
suggestions, advice, or remembered context expressed with different words. The tool performs
local lexical shortlisting first, then one bounded embedding request. Keep it out of exact
workflow decisions: similarity retrieves candidate memory, while `query`, `explain_query`,
or `recall_explain` establishes the answer.

The semantic result reports its model, provider tokens/cost, cache hits/misses, semantic
score, lexical rank, clause, and durable sources. Restrict exported namespaces with
`REMBERO_LLM_ALLOWED_NAMESPACES`; detected secrets fail before the provider call.
Long sources are scored by their best bounded chunk. A high-confidence lexical leader is
retained only at the published absolute-score and margin gate, which is reported in the
tool result as `lexicalGuardApplied`.
Document vectors are cached as bounded derived data across MCP restarts, so repeated agent
sessions pay only for query embeddings. Deleting `.semantic-embeddings/` is always safe.
After an accepted `apply_memory_proposal`, call `prepare_semantic_search` in bounded batches
until it returns `status: "complete"`. This moves provider latency out of the next user turn
without making mutation success depend on the embedding service.

### Use two answer contracts

A single “answer only from memory” prompt is wrong for personalized recommendations. Keep
the grounding rule strict for user facts, but let the model contribute general knowledge
when the task asks it to recommend something:

```text
Factual recall:
Answer only from TOOL_RESULT. If it does not support the answer, say you do not know.

Personalized recommendation:
Use TOOL_RESULT to ground every claim about the user. You may use general knowledge to
make recommendations, but do not invent user details. State the remembered preference or
context that drives the recommendation.
```

This distinction moved LongMemEval-S development preference accuracy from the initial 20%
lexical/history-only baseline to 86.7% in the locked full run; held-out accuracy was 93.3%.
The model still receives only bounded retrieved sources, never the full store. Run the
complete development harness with:

```bash
npm run bench:longmemeval:answer -- --split dev \
  --output /tmp/remembero-longmemeval-dev.json \
  --hypotheses /tmp/remembero-longmemeval-dev.jsonl
```

The result separates durable formation, retrieval coverage, reader accuracy, judge cost,
and failures by question type. See the
[end-to-end benchmark contract](research/LONGMEMEVAL.md).

### Filter roles after retrieval

Rank the complete durable transcript, then minimize what the answer model rereads:

```ts
const answerTurns = questionAsksAboutAssistantOutput
  ? retrievedSession.turns
  : retrievedSession.turns.filter((turn) => turn.role === "user");
```

Do this after retrieval so assistant wording can still help find the right session. Keep
both roles when the user asks what the assistant previously said or recommended. For user
facts, preferences, updates, temporal events, and multi-session aggregation, user turns are
usually the authority and assistant prose is often repeated cost and distraction.

On the 500-question LongMemEval-S post-hoc v2 run, this role-aware reader context raises
accuracy from 75.4% to 77.0%, cuts reader tokens 76.7%, lowers runtime provider cost 76.5%,
and improves multi-session accuracy from 56.4% to 61.7%. Retrieval IDs and Recall@4 are
unchanged. The [v2 evidence artifact](research/results/longmemeval-answer-v2-summary.json)
also records the rejected alternatives.

Use a slightly larger result set only when the task requires evidence from multiple
sessions. The measured default is top four for ordinary recall and top five for
multi-session synthesis. Top six raised retrieval coverage but reduced development answer
accuracy and abstention quality. The
[adaptive v3 result](research/results/longmemeval-answer-v3-summary.json) reaches 63.9%
multi-session and 77.6% overall accuracy at $0.000760 runtime cost per question.
