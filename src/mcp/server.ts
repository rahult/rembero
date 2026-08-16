import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  entityIdentityFromEnv,
  integrityEnforcementFromEnv,
  recallSchemaPredicateLimitFromEnv,
  validTimeModeFromEnv,
} from '../env.js';
import type { PipelineDeps } from '../llm/pipeline.js';
import { MAX_RECALL_SCHEMA_PREDICATES } from '../llm/schema.js';
import { MAX_PROOFS_PER_ROW } from '../engine/index.js';
import { MAX_INPUT_BYTES, MAX_NAMESPACE_COUNT, stringifyBoundedResult } from '../safety.js';
import {
  checkIntegrityTool,
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
import { IncompleteHistoryError, MAX_HISTORY_EVENTS } from '../store/store.js';
import { MAX_INTEGRITY_VIOLATIONS } from '../knowledge/integrity.js';
import {
  IntegrityViolationError,
  type IntegrityEnforcementMode,
  type IntegrityEnforcementOptions,
} from '../knowledge/enforcement.js';
import type { EntityIdentityMode } from '../knowledge/identity.js';
import {
  MAX_OPERATION_ID_BYTES,
  OperationConflictError,
} from '../store/store.js';
import {
  MAX_GRAPH_NEIGHBOR_DEPTH,
  MAX_GRAPH_NODE_ID_BYTES,
  MAX_GRAPH_RESULT_ROW,
  type ExplanationGraphSelector,
} from '../knowledge/graph-navigation.js';

const namespaceField = z
  .string()
  .optional()
  .describe('Memory namespace (default: "default")');
const namespacesField = z
  .union([z.array(z.string()).max(MAX_NAMESPACE_COUNT), z.literal('*')])
  .optional()
  .describe('Namespaces to search: a list, or "*" for all (default: ["default"])');
const schemaPredicateLimitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_RECALL_SCHEMA_PREDICATES)
  .optional()
  .describe('Maximum predicates receiving detailed recall context');
const proofLimitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_PROOFS_PER_ROW)
  .optional()
  .describe('Total deterministic proof witnesses per result, including the primary witness');
const maxViolationsField = z
  .number()
  .int()
  .min(1)
  .max(MAX_INTEGRITY_VIOLATIONS)
  .optional()
  .describe('Maximum complete integrity-violation rows returned across all constraints');
const integrityModeField = z
  .enum(['strict', 'no_new_violations'])
  .optional()
  .describe('Atomically reject writes that violate policy; cannot weaken a server default');
const integrityNamespacesField = z
  .union([z.array(z.string()).max(MAX_NAMESPACE_COUNT), z.literal('*')])
  .optional()
  .describe('Knowledge view governed by write enforcement; must include the target namespace');
const entityIdentityField = z
  .literal('canonical')
  .optional()
  .describe('Project aliases only at explicitly declared predicate positions');
const graphSelectorField = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('result'),
      row: z.number().int().min(1).max(MAX_GRAPH_RESULT_ROW),
    }),
    z.object({
      kind: z.literal('support'),
      nodeId: z.string().min(1).max(MAX_GRAPH_NODE_ID_BYTES),
    }),
    z.object({
      kind: z.literal('neighbors'),
      nodeId: z.string().min(1).max(MAX_GRAPH_NODE_ID_BYTES),
      depth: z.number().int().min(1).max(MAX_GRAPH_NEIGHBOR_DEPTH).optional(),
    }),
  ])
  .optional()
  .describe('Select one complete result support chain, node support closure, or bounded neighborhood');
const boundedText = (description?: string) => {
  const field = z.string().max(MAX_INPUT_BYTES);
  return description ? field.describe(description) : field;
};
const operationIdField = z
  .string()
  .min(1)
  .max(MAX_OPERATION_ID_BYTES)
  .optional()
  .describe('Caller-stable idempotency key for safe retries');
const recordedSequenceField = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Read the deterministic knowledge snapshot after global journal entry n; 0 is empty');

function asContent(result: unknown) {
  return { content: [{ type: 'text' as const, text: stringifyBoundedResult(result, 'MCP result') }] };
}

function asError(e: unknown) {
  let text: string;
  if (e instanceof OperationConflictError || e instanceof IncompleteHistoryError) {
    text = stringifyBoundedResult(e.toJSON(), 'MCP structured error');
  } else if (e instanceof IntegrityViolationError) {
    try {
      text = stringifyBoundedResult(e.toJSON(), 'MCP integrity rejection');
    } catch {
      text = JSON.stringify({
        error: 'integrity_rejection_output_exceeded',
        message: 'write was rejected, but complete evidence exceeds the MCP output bound',
        mode: e.mode,
        baselineViolationCount: e.baselineViolationCount,
        blockingViolationCount: e.blockingViolations.length,
        introducedViolationCount: e.introducedViolations.length,
      });
    }
  } else {
    text = e instanceof Error ? e.message : String(e);
  }
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function requestedIntegrity(
  fallback: IntegrityEnforcementOptions | false | undefined,
  mode: IntegrityEnforcementMode | undefined,
  namespaces: string[] | '*' | undefined,
  proofLimit: number | undefined,
  maxViolations: number | undefined,
  entityIdentity: EntityIdentityMode | undefined,
  graphSelector: ExplanationGraphSelector | undefined
): IntegrityEnforcementOptions | undefined {
  const activeFallback = fallback === false ? undefined : fallback;
  if (mode === undefined) {
    if (
      activeFallback === undefined &&
      (
        namespaces !== undefined ||
        proofLimit !== undefined ||
        maxViolations !== undefined ||
        graphSelector !== undefined
      )
    ) {
      throw new Error('integrity write options require integrityMode or a server default');
    }
    return activeFallback === undefined
      ? undefined
      : {
          ...activeFallback,
          ...(namespaces === undefined ? {} : { namespaces }),
          ...(proofLimit === undefined ? {} : { maxProofsPerRow: proofLimit }),
          ...(maxViolations === undefined ? {} : { maxViolations }),
          ...(entityIdentity === undefined ? {} : { entityIdentity }),
          ...(graphSelector === undefined ? {} : { graphSelector }),
        };
  }
  if (activeFallback?.mode === 'strict' && mode !== 'strict') {
    throw new Error('tool call cannot weaken strict server integrity enforcement');
  }
  return {
    ...(activeFallback ?? {}),
    mode,
    ...(namespaces === undefined ? {} : { namespaces }),
    ...(proofLimit === undefined ? {} : { maxProofsPerRow: proofLimit }),
    ...(maxViolations === undefined ? {} : { maxViolations }),
    ...(entityIdentity === undefined ? {} : { entityIdentity }),
    ...(graphSelector === undefined ? {} : { graphSelector }),
  };
}

export function createServer(deps: PipelineDeps): McpServer {
  const entityIdentity = deps.entityIdentity ?? entityIdentityFromEnv();
  const configuredIntegrity = deps.integrityEnforcement ?? integrityEnforcementFromEnv();
  const resolvedDeps: PipelineDeps = {
    ...deps,
    validTimeMode: deps.validTimeMode ?? validTimeModeFromEnv(),
    recallSchemaPredicateLimit:
      deps.recallSchemaPredicateLimit ?? recallSchemaPredicateLimitFromEnv(),
    integrityEnforcement:
      configuredIntegrity === undefined || configuredIntegrity === false
        ? configuredIntegrity
        : {
            ...configuredIntegrity,
            ...(configuredIntegrity.entityIdentity !== undefined || entityIdentity !== 'canonical'
              ? {}
              : { entityIdentity }),
          },
    entityIdentity,
  };
  const server = new McpServer({ name: 'rembero', version: '0.14.0' });

  server.registerTool(
    'remember',
    {
      title: 'Remember',
      description:
        "Store a natural-language statement in long-term memory as logical facts/rules. Use proactively when the user states something durable: preferences, relationships, decisions, project facts, biography ('my dentist is Dr Chen', 'we picked Postgres', 'Mira now works at Initech' — updates supersede old facts). Do NOT store secrets (passwords, keys) or transient context (today's error message).",
      inputSchema: {
        text: boundedText('What to remember, in plain language'),
        namespace: namespaceField,
        integrityMode: integrityModeField,
        integrityNamespaces: integrityNamespacesField,
        proofLimit: proofLimitField,
        maxViolations: maxViolationsField,
        entityIdentity: entityIdentityField,
        graphSelector: graphSelectorField,
      },
    },
    async ({
      text,
      namespace,
      integrityMode,
      integrityNamespaces,
      proofLimit,
      maxViolations,
      entityIdentity,
      graphSelector,
    }) => {
      try {
        return asContent(
          await rememberTool(resolvedDeps, {
            text,
            namespace,
            integrityEnforcement: requestedIntegrity(
              resolvedDeps.integrityEnforcement,
              integrityMode,
              integrityNamespaces,
              proofLimit,
              maxViolations,
              entityIdentity,
              graphSelector
            ),
            entityIdentity,
          })
        );
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
        "Answer a question from current or explicitly selected recorded long-term memory using logical inference over stored facts and rules. Use when the user asks about anything previously discussed or personal ('who is my dentist?', 'what did we decide about the database?'), and at the start of tasks where remembered context would help. Returns an explicit recall status plus the query, bindings, and bounded schema diagnostics when pruning activates.",
      inputSchema: {
        question: boundedText(),
        namespaces: namespacesField,
        schemaPredicateLimit: schemaPredicateLimitField,
        entityIdentity: entityIdentityField,
        recordedSequence: recordedSequenceField,
      },
    },
    async ({
      question,
      namespaces,
      schemaPredicateLimit,
      entityIdentity,
      recordedSequence,
    }) => {
      try {
        return asContent(
          await recallTool(resolvedDeps, {
            question,
            namespaces,
            schemaPredicateLimit,
            entityIdentity,
            recordedSequence,
          })
        );
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
        'Answer from long-term memory and return the recall status, generated query, bindings, deterministic derivation proofs, durable source statements, query-scoped knowledge graph, and bounded schema diagnostics when pruning activates.',
      inputSchema: {
        question: boundedText(),
        namespaces: namespacesField,
        schemaPredicateLimit: schemaPredicateLimitField,
        proofLimit: proofLimitField,
        entityIdentity: entityIdentityField,
        graphSelector: graphSelectorField,
        recordedSequence: recordedSequenceField,
      },
    },
    async ({
      question,
      namespaces,
      schemaPredicateLimit,
      proofLimit,
      entityIdentity,
      graphSelector,
      recordedSequence,
    }) => {
      try {
        return asContent(
          await recallExplainTool(resolvedDeps, {
            question,
            namespaces,
            schemaPredicateLimit,
            proofLimit,
            entityIdentity,
            graphSelector,
            recordedSequence,
          })
        );
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
        "Store raw Datalog clauses directly, no LLM translation. Accepts facts like 'works_at(rahul, acme).', rules like 'senior(X) :- years(X, Y), Y >= 10 + 5.', and explicit integrity constraints like ':- active(X), suspended(X).'. Arithmetic is allowed only in comparison filters.",
      inputSchema: {
        clauses: boundedText(),
        namespace: namespaceField,
        opId: operationIdField,
        integrityMode: integrityModeField,
        integrityNamespaces: integrityNamespacesField,
        proofLimit: proofLimitField,
        maxViolations: maxViolationsField,
        entityIdentity: entityIdentityField,
        graphSelector: graphSelectorField,
      },
    },
    async ({
      clauses,
      namespace,
      opId,
      integrityMode,
      integrityNamespaces,
      proofLimit,
      maxViolations,
      entityIdentity,
      graphSelector,
    }) => {
      try {
        return asContent(
          assertFactsTool({ store: resolvedDeps.store }, {
            clauses,
            namespace,
            opId,
            integrityEnforcement: requestedIntegrity(
              resolvedDeps.integrityEnforcement,
              integrityMode,
              integrityNamespaces,
              proofLimit,
              maxViolations,
              entityIdentity,
              graphSelector
            ),
          })
        );
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
      inputSchema: {
        query: boundedText(),
        namespaces: namespacesField,
        entityIdentity: entityIdentityField,
        recordedSequence: recordedSequenceField,
      },
    },
    async ({ query, namespaces, entityIdentity, recordedSequence }) => {
      try {
        return asContent(
          queryTool(resolvedDeps, { query, namespaces, entityIdentity, recordedSequence })
        );
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
      inputSchema: {
        query: boundedText(),
        namespaces: namespacesField,
        proofLimit: proofLimitField,
        entityIdentity: entityIdentityField,
        graphSelector: graphSelectorField,
        recordedSequence: recordedSequenceField,
      },
    },
    async ({
      query,
      namespaces,
      proofLimit,
      entityIdentity,
      graphSelector,
      recordedSequence,
    }) => {
      try {
        return asContent(
          explainQueryTool(resolvedDeps, {
            query,
            namespaces,
            proofLimit,
            entityIdentity,
            graphSelector,
            recordedSequence,
          })
        );
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'check_integrity',
    {
      title: 'Check knowledge integrity',
      description:
        'Evaluate every explicit headless Datalog constraint over the selected current or recorded knowledge view. Returns one policy check each; violating rows include deterministic proofs, durable sources, and query-scoped graphs. No LLM is used and no memory is changed.',
      inputSchema: {
        namespaces: namespacesField,
        proofLimit: proofLimitField,
        maxViolations: maxViolationsField,
        entityIdentity: entityIdentityField,
        graphSelector: graphSelectorField,
        recordedSequence: recordedSequenceField,
      },
    },
    async ({
      namespaces,
      proofLimit,
      maxViolations,
      entityIdentity,
      graphSelector,
      recordedSequence,
    }) => {
      try {
        return asContent(
          checkIntegrityTool(resolvedDeps, {
            namespaces,
            proofLimit,
            maxViolations,
            entityIdentity,
            graphSelector,
            recordedSequence,
          })
        );
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
      inputSchema: {
        pattern: boundedText(),
        namespace: namespaceField,
        opId: operationIdField,
        integrityMode: integrityModeField,
        integrityNamespaces: integrityNamespacesField,
        proofLimit: proofLimitField,
        maxViolations: maxViolationsField,
        entityIdentity: entityIdentityField,
        graphSelector: graphSelectorField,
      },
    },
    async ({
      pattern,
      namespace,
      opId,
      integrityMode,
      integrityNamespaces,
      proofLimit,
      maxViolations,
      entityIdentity,
      graphSelector,
    }) => {
      try {
        return asContent(
          forgetTool({ store: resolvedDeps.store }, {
            pattern,
            namespace,
            opId,
            integrityEnforcement: requestedIntegrity(
              resolvedDeps.integrityEnforcement,
              integrityMode,
              integrityNamespaces,
              proofLimit,
              maxViolations,
              entityIdentity,
              graphSelector
            ),
          })
        );
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
      description:
        'List stored facts and rules grouped by predicate, plus explicit integrity constraints when present.',
      inputSchema: {
        namespaces: namespacesField,
        predicate: z.string().optional().describe("Filter: 'name' or 'name/arity'"),
        recordedSequence: recordedSequenceField,
      },
    },
    async ({ namespaces, predicate, recordedSequence }) => {
      try {
        return asContent(
          listMemoriesTool(resolvedDeps, { namespaces, predicate, recordedSequence })
        );
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
