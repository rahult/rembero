import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { LlmClient } from '../llm/client.js';
import type { MemoryStore } from '../store/store.js';
import {
  assertFactsTool,
  forgetTool,
  listMemoriesTool,
  queryTool,
  recallTool,
  rememberTool,
} from './tools.js';

const namespaceField = z
  .string()
  .optional()
  .describe('Memory namespace (default: "default")');
const namespacesField = z
  .union([z.array(z.string()), z.literal('*')])
  .optional()
  .describe('Namespaces to search: a list, or "*" for all (default: ["default"])');

function asContent(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}

function asError(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function createServer(deps: { store: MemoryStore; llm: LlmClient }): McpServer {
  const server = new McpServer({ name: 'rembero', version: '0.1.0' });

  server.registerTool(
    'remember',
    {
      title: 'Remember',
      description:
        "Store a natural-language statement in long-term memory as logical facts/rules. Use proactively when the user states something durable: preferences, relationships, decisions, project facts, biography ('my dentist is Dr Chen', 'we picked Postgres', 'Mira now works at Initech' — updates supersede old facts). Do NOT store secrets (passwords, keys) or transient context (today's error message).",
      inputSchema: { text: z.string().describe('What to remember, in plain language'), namespace: namespaceField },
    },
    async ({ text, namespace }) => {
      try {
        return asContent(await rememberTool(deps, { text, namespace }));
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
      inputSchema: { question: z.string(), namespaces: namespacesField },
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
    'assert_facts',
    {
      title: 'Assert facts',
      description:
        "Store raw Datalog clauses directly, no LLM translation. Facts like 'works_at(rahul, acme).' or rules like 'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.'",
      inputSchema: { clauses: z.string(), namespace: namespaceField },
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
        "Run a raw Datalog query and get variable bindings, e.g. 'works_at(X, acme)' or 'works_at(X, C), lives_in(X, sydney)'.",
      inputSchema: { query: z.string(), namespaces: namespacesField },
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
    'forget',
    {
      title: 'Forget',
      description:
        "Retract facts matching a pattern, e.g. 'works_at(rahul, _)', or remove an exact rule by giving it in full.",
      inputSchema: { pattern: z.string(), namespace: namespaceField },
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

export async function serveStdio(deps: { store: MemoryStore; llm: LlmClient }): Promise<void> {
  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel — diagnostics must use stderr
  console.error('rembero MCP server listening on stdio');
}
