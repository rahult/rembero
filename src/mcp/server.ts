import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { validTimeModeFromEnv } from '../env.js';
import type { PipelineDeps } from '../llm/pipeline.js';
import { MAX_INPUT_BYTES, MAX_NAMESPACE_COUNT, stringifyBoundedResult } from '../safety.js';
import {
  assertFactsTool,
  explainQueryTool,
  forgetTool,
  historyTool,
  listMemoriesTool,
  queryTool,
  recallExplainTool,
  recallTool,
  rememberTool,
} from './tools.js';
import { MAX_HISTORY_EVENTS } from '../store/store.js';

const namespaceField = z
  .string()
  .optional()
  .describe('Memory namespace (default: "default")');
const namespacesField = z
  .union([z.array(z.string()).max(MAX_NAMESPACE_COUNT), z.literal('*')])
  .optional()
  .describe('Namespaces to search: a list, or "*" for all (default: ["default"])');
const boundedText = (description?: string) => {
  const field = z.string().max(MAX_INPUT_BYTES);
  return description ? field.describe(description) : field;
};

function asContent(result: unknown) {
  return { content: [{ type: 'text' as const, text: stringifyBoundedResult(result, 'MCP result') }] };
}

function asError(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function createServer(deps: PipelineDeps): McpServer {
  const resolvedDeps: PipelineDeps =
    deps.validTimeMode === undefined
      ? { ...deps, validTimeMode: validTimeModeFromEnv() }
      : deps;
  const server = new McpServer({ name: 'rembero', version: '0.6.0' });

  server.registerTool(
    'remember',
    {
      title: 'Remember',
      description:
        "Store a natural-language statement in long-term memory as logical facts/rules. Use proactively when the user states something durable: preferences, relationships, decisions, project facts, biography ('my dentist is Dr Chen', 'we picked Postgres', 'Mira now works at Initech' — updates supersede old facts). Do NOT store secrets (passwords, keys) or transient context (today's error message).",
      inputSchema: { text: boundedText('What to remember, in plain language'), namespace: namespaceField },
    },
    async ({ text, namespace }) => {
      try {
        return asContent(await rememberTool(resolvedDeps, { text, namespace }));
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'recall',
    {
      title: 'Recall',
      description:
        "Answer a question from long-term memory using logical inference over stored facts and rules. Use when the user asks about anything previously discussed or personal ('who is my dentist?', 'what did we decide about the database?'), and at the start of tasks where remembered context would help. Returns the answer plus the query and bindings used to derive it.",
      inputSchema: { question: boundedText(), namespaces: namespacesField },
    },
    async ({ question, namespaces }) => {
      try {
        return asContent(await recallTool(deps, { question, namespaces }));
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'recall_explain',
    {
      title: 'Recall with explanation',
      description:
        'Answer from long-term memory and return the generated query, bindings, deterministic derivation proofs, durable source statements, and a query-scoped knowledge graph.',
      inputSchema: { question: boundedText(), namespaces: namespacesField },
    },
    async ({ question, namespaces }) => {
      try {
        return asContent(await recallExplainTool(deps, { question, namespaces }));
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'assert_facts',
    {
      title: 'Assert facts',
      description:
        "Store raw Datalog clauses directly, no LLM translation. Facts like 'works_at(rahul, acme).' or rules like 'senior(X) :- years(X, Y), Y >= 10 + 5.'. Arithmetic is allowed only in comparison filters.",
      inputSchema: { clauses: boundedText(), namespace: namespaceField },
    },
    async ({ clauses, namespace }) => {
      try {
        return asContent(assertFactsTool(deps, { clauses, namespace }));
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'query',
    {
      title: 'Query',
      description:
        "Run a raw Datalog query and get variable bindings, e.g. 'works_at(X, acme)', 'score(X, S), S > 10 + 5', 'employee(X), \\+ suspended(X)', or 'count(*) as Count where works_at(Person, acme)'.",
      inputSchema: { query: boundedText(), namespaces: namespacesField },
    },
    async ({ query, namespaces }) => {
      try {
        return asContent(queryTool(deps, { query, namespaces }));
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'explain_query',
    {
      title: 'Explain query',
      description:
        'Run a raw Datalog query and return bindings, deterministic derivation or aggregate proofs, durable memory sources, and a query-scoped knowledge graph.',
      inputSchema: { query: boundedText(), namespaces: namespacesField },
    },
    async ({ query, namespaces }) => {
      try {
        return asContent(explainQueryTool(deps, { query, namespaces }));
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'forget',
    {
      title: 'Forget',
      description:
        "Retract facts matching a pattern, e.g. 'works_at(rahul, _)', or remove an exact rule by giving it in full.",
      inputSchema: { pattern: boundedText(), namespace: namespaceField },
    },
    async ({ pattern, namespace }) => {
      try {
        return asContent(forgetTool(deps, { pattern, namespace }));
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'history',
    {
      title: 'Memory history',
      description:
        'Show the deterministic append-order life story of facts matching one Datalog literal, including exact supersession archives and redacted provenance. No LLM is used.',
      inputSchema: {
        pattern: boundedText("One fact pattern, e.g. 'works_at(mira, _)'"),
        namespaces: namespacesField,
        limit: z.number().int().min(1).max(MAX_HISTORY_EVENTS).optional(),
      },
    },
    async ({ pattern, namespaces, limit }) => {
      try {
        return asContent(historyTool(deps, { pattern, namespaces, limit }));
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'list_memories',
    {
      title: 'List memories',
      description: 'List stored facts and rules, grouped by predicate, optionally filtered.',
      inputSchema: {
        namespaces: namespacesField,
        predicate: z.string().optional().describe("Filter: 'name' or 'name/arity'"),
      },
    },
    async ({ namespaces, predicate }) => {
      try {
        return asContent(listMemoriesTool(deps, { namespaces, predicate }));
      } catch (e) {
        return asError(e);
      }
    }
  );

  return server;
}

export async function serveStdio(deps: PipelineDeps): Promise<void> {
  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel — diagnostics must use stderr
  console.error('rembero MCP server listening on stdio');
}
