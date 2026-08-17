import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  entityIdentityFromEnv,
  integrityEnforcementFromEnv,
  recallAnswerModeFromEnv,
  recallSchemaPredicateLimitFromEnv,
  validTimeModeFromEnv,
} from '../env.js';
import type { PipelineDeps } from '../llm/pipeline.js';
import { MAX_RECALL_SCHEMA_PREDICATES } from '../llm/schema.js';
import { MAX_PROOFS_PER_ROW } from '../engine/index.js';
import {
  MAX_INPUT_BYTES,
  MAX_NAMESPACE_COUNT,
  assertBoundedOutput,
  stringifyBoundedResult,
} from '../safety.js';
import {
  checkIntegrityTool,
  conflictViewsTool,
  assertFactsTool,
  assertTentativeTool,
  checkpointJournalTool,
  explainQueryTool,
  forgetTool,
  historyTool,
  listMemoriesTool,
  listCheckpointsTool,
  queryTool,
  recallExplainTool,
  recallTool,
  rememberTool,
  resolveTentativeTool,
  reviewTentativeTool,
  supersedeFactsTool,
  whatIfTool,
  whyNotTool,
  topologyTool,
  recordedDiffTool,
  repairPlanTool,
  auditRulesTool,
  searchKnowledgeTool,
  browseKnowledgeGraphTool,
  connectKnowledgeGraphTool,
  exportKnowledgeBundleTool,
  verifyKnowledgeBundleTool,
  runKnowledgeChecksTool,
  profileKnowledgeTool,
} from './tools.js';
import {
  IncompleteHistoryError,
  MAX_HISTORY_EVENTS,
  MAX_SUPERSEDE_PATTERNS,
} from '../store/store.js';
import { MAX_INTEGRITY_VIOLATIONS } from '../knowledge/integrity.js';
import { MAX_CONFLICT_FOCUS_BYTES } from '../knowledge/conflicts.js';
import {
  MAX_COUNTERFACTUAL_ASSUMPTIONS,
  MAX_COUNTERFACTUAL_RETRACTIONS,
} from '../knowledge/counterfactual.js';
import {
  MAX_WHY_NOT_CANDIDATES,
  MAX_WHY_NOT_DEPTH,
  MAX_WHY_NOT_EVIDENCE,
  MAX_WHY_NOT_FAILURES,
} from '../knowledge/why-not.js';
import { MAX_TOPOLOGY_FOCUS_BYTES } from '../knowledge/topology.js';
import {
  MAX_REPAIR_PLANS,
  MAX_REPAIR_SEARCH_STATES,
  MAX_REPAIR_STEPS,
} from '../knowledge/repair.js';
import { MAX_KNOWLEDGE_SEARCH_LIMIT } from '../knowledge/search.js';
import {
  MAX_BROWSE_ENTITY_FOCUS_BYTES,
  MAX_BROWSE_GRAPH_CLAIMS,
  MAX_BROWSE_GRAPH_DEPTH,
  MAX_BROWSE_PREDICATE_FOCUS_BYTES,
} from '../knowledge/browse.js';
import {
  MAX_KNOWLEDGE_PATH_DEPTH,
  MAX_KNOWLEDGE_PATHS,
} from '../knowledge/paths.js';
import {
  MAX_KNOWLEDGE_BUNDLE_BYTES,
  serializeKnowledgeBundle,
} from '../knowledge/bundle.js';
import { MAX_KNOWLEDGE_CHECK_SUITE_BYTES } from '../knowledge/checks.js';
import { TrustMetadataError } from '../knowledge/trust.js';
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
const whyNotFailureLimitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_WHY_NOT_FAILURES)
  .optional()
  .describe('Maximum complete blocker nodes (default: 32)');
const whyNotDepthField = z
  .number()
  .int()
  .min(1)
  .max(MAX_WHY_NOT_DEPTH)
  .optional()
  .describe('Maximum nested rule-diagnostic depth (default: 8)');
const whyNotCandidateLimitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_WHY_NOT_CANDIDATES)
  .optional()
  .describe('Maximum nearby sourced facts per blocker (default: 4)');
const whyNotEvidenceLimitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_WHY_NOT_EVIDENCE)
  .optional()
  .describe('Maximum distinct nearby facts carrying proof evidence (default: 16)');
const topologyFocusField = z
  .string()
  .min(1)
  .max(MAX_TOPOLOGY_FOCUS_BYTES)
  .optional()
  .describe("Optional 'predicate' or 'predicate/arity' focus");
const topologyDirectionField = z
  .enum(['upstream', 'downstream', 'both'])
  .optional()
  .describe('Focused dependency direction (default: both; requires focus)');
const repairPlanLimitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_REPAIR_PLANS)
  .optional()
  .describe('Maximum complete minimal repair plans (default: 8)');
const repairStepLimitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_REPAIR_STEPS)
  .optional()
  .describe('Maximum iterative blocker-repair depth (default: 4)');
const repairSearchStateLimitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_REPAIR_SEARCH_STATES)
  .optional()
  .describe('Maximum candidate edit states inspected (default: 128)');
const knowledgeSearchLimitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_KNOWLEDGE_SEARCH_LIMIT)
  .optional()
  .describe('Maximum ranked local knowledge matches (default: 20)');
const knowledgeSearchKindsField = z
  .array(z.enum(['fact', 'rule', 'constraint']))
  .min(1)
  .max(3)
  .optional()
  .describe('Optional fact, rule, or constraint filters');
const browseEntityFocusField = z
  .union([
    z.string().max(MAX_BROWSE_ENTITY_FOCUS_BYTES),
    z.number().finite(),
  ])
  .optional()
  .describe('Optional exact atom string or numeric entity seed');
const browsePredicateField = z
  .string()
  .min(1)
  .max(MAX_BROWSE_PREDICATE_FOCUS_BYTES)
  .optional()
  .describe("Optional seed predicate as 'name' or 'name/arity'");
const browseDepthField = z
  .number()
  .int()
  .min(1)
  .max(MAX_BROWSE_GRAPH_DEPTH)
  .optional()
  .describe('Explicit fact-neighborhood depth (default: 1)');
const browseClaimLimitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_BROWSE_GRAPH_CLAIMS)
  .optional()
  .describe('Maximum complete explicit claims (default: 100)');
const pathEndpointField = z
  .union([
    z.string().max(MAX_BROWSE_ENTITY_FOCUS_BYTES),
    z.number().finite(),
  ])
  .describe('Exact atom string or numeric path endpoint');
const pathDepthField = z
  .number()
  .int()
  .min(1)
  .max(MAX_KNOWLEDGE_PATH_DEPTH)
  .optional()
  .describe('Maximum explicit-claim hops (default: 4)');
const pathLimitField = z
  .number()
  .int()
  .min(1)
  .max(MAX_KNOWLEDGE_PATHS)
  .optional()
  .describe('Maximum complete shortest paths (default: 3)');
const conflictFocusField = z
  .string()
  .min(1)
  .max(MAX_CONFLICT_FOCUS_BYTES)
  .optional()
  .describe('Optional ground Datalog atom or number selecting one conflict focus');
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
const knowledgeTrustField = z
  .enum(['accepted', 'tentative'])
  .optional()
  .describe('Store extracted facts as accepted (default) or explicitly tentative');
const trustViewField = z
  .enum(['accepted', 'include_tentative'])
  .optional()
  .describe('Accepted knowledge only (default), or opt in to tentative claims');
const recallAnswerModeField = z
  .enum(['natural', 'deterministic'])
  .optional()
  .describe('LLM phrasing (natural default) or exact local binding rendering');
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
const recordedDiffSequenceField = z
  .number()
  .int()
  .min(0)
  .describe('Exact global journal sequence (0 is the empty initial state)');
const validTimeInstantField = z
  .string()
  .max(64)
  .optional()
  .describe('Canonical UTC valid-until instant, e.g. 2026-08-16T16:59:00.000Z');

function asContent(result: unknown) {
  return { content: [{ type: 'text' as const, text: stringifyBoundedResult(result, 'MCP result') }] };
}

function asRawContent(text: string, label: string) {
  assertBoundedOutput(text, label);
  return { content: [{ type: 'text' as const, text }] };
}

function asError(e: unknown) {
  let text: string;
  if (
    e instanceof OperationConflictError ||
    e instanceof IncompleteHistoryError ||
    e instanceof TrustMetadataError
  ) {
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
    recallAnswerMode: deps.recallAnswerMode ?? recallAnswerModeFromEnv(),
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
  const server = new McpServer({ name: 'rembero', version: '0.41.0' });

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
        trust: knowledgeTrustField,
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
      trust,
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
            trust,
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
        trustMode: trustViewField,
        answerMode: recallAnswerModeField,
        recordedSequence: recordedSequenceField,
      },
    },
    async ({
      question,
      namespaces,
      schemaPredicateLimit,
      entityIdentity,
      trustMode,
      answerMode,
      recordedSequence,
    }) => {
      try {
        return asContent(
          await recallTool(resolvedDeps, {
            question,
            namespaces,
            schemaPredicateLimit,
            entityIdentity,
            trustMode,
            answerMode,
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
        trustMode: trustViewField,
        answerMode: recallAnswerModeField,
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
      trustMode,
      answerMode,
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
            trustMode,
            answerMode,
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
    'assert_tentative',
    {
      title: 'Assert tentative facts',
      description:
        'Store explicit ground Datalog facts as tentative claims. They are journaled but excluded from ordinary query, recall, integrity, and conflict views until accepted or explicitly included.',
      inputSchema: {
        clauses: boundedText('One or more ordinary ground facts'),
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
          assertTentativeTool(
            { store: resolvedDeps.store },
            {
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
            }
          )
        );
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'review_tentative',
    {
      title: 'Review tentative claims',
      description:
        'List bounded tentative facts awaiting explicit acceptance or rejection, with stable IDs and durable sources.',
      inputSchema: { namespaces: namespacesField },
    },
    async ({ namespaces }) => {
      try {
        return asContent(
          reviewTentativeTool(
            { store: resolvedDeps.store },
            { namespaces }
          )
        );
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'resolve_tentative',
    {
      title: 'Accept or reject tentative facts',
      description:
        'Atomically accept or reject exact tentative ground facts. Every requested claim must still be current; acceptance passes configured integrity enforcement.',
      inputSchema: {
        clauses: boundedText('Exact ground facts previously stored as tentative'),
        action: z.enum(['accept', 'reject']),
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
      action,
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
          resolveTentativeTool(
            { store: resolvedDeps.store },
            {
              clauses,
              action,
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
            }
          )
        );
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'supersede_facts',
    {
      title: 'Supersede facts',
      description:
        "Atomically end current ground facts matching one or more patterns, preserve each as a system-managed '_until' fact, and add explicit replacement clauses. No LLM is used. Append order remains authoritative; the optional UTC timestamp is descriptive valid-time metadata.",
      inputSchema: {
        patterns: z
          .array(boundedText("A positive fact pattern, e.g. 'works_at(mira, _)'"))
          .min(1)
          .max(MAX_SUPERSEDE_PATTERNS),
        replacements: boundedText('Optional ground facts or other Datalog clauses to add')
          .optional(),
        namespace: namespaceField,
        at: validTimeInstantField,
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
      patterns,
      replacements,
      namespace,
      at,
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
          supersedeFactsTool(
            { store: resolvedDeps.store },
            {
              patterns,
              replacements,
              namespace,
              at,
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
            }
          )
        );
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'search_knowledge',
    {
      title: 'Search knowledge locally',
      description:
        'Rank selected facts, rules, and policies locally using fixed lexical evidence from predicate names, atoms, authored clauses, and redacted durable source text. Returns explicit score reasons, provenance, and a query/result/clause/predicate/entity graph. This is retrieval, not semantic proof; no LLM or vector service is used.',
      inputSchema: {
        text: boundedText(),
        namespaces: namespacesField,
        limit: knowledgeSearchLimitField,
        kinds: knowledgeSearchKindsField,
        entityIdentity: entityIdentityField,
        trustMode: trustViewField,
        recordedSequence: recordedSequenceField,
      },
    },
    async ({
      text,
      namespaces,
      limit,
      kinds,
      entityIdentity,
      trustMode,
      recordedSequence,
    }) => {
      try {
        return asContent(
          searchKnowledgeTool(resolvedDeps, {
            text,
            namespaces,
            limit,
            kinds,
            entityIdentity,
            trustMode,
            recordedSequence,
          })
        );
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'browse_knowledge_graph',
    {
      title: 'Browse the explicit personal knowledge graph',
      description:
        'Browse a bounded entity- or predicate-seeded hypergraph derived only from explicit stored ground facts. Returns claim/entity nodes, argument edges, provenance, aliases, trust, and recorded-view metadata. Rules and inferred claims require query/explain; no graph sidecar or LLM is used.',
      inputSchema: {
        focus: browseEntityFocusField,
        predicate: browsePredicateField,
        depth: browseDepthField,
        maxClaims: browseClaimLimitField,
        namespaces: namespacesField,
        entityIdentity: entityIdentityField,
        trustMode: trustViewField,
        recordedSequence: recordedSequenceField,
      },
    },
    async ({
      focus,
      predicate,
      depth,
      maxClaims,
      namespaces,
      entityIdentity,
      trustMode,
      recordedSequence,
    }) => {
      try {
        return asContent(
          browseKnowledgeGraphTool(resolvedDeps, {
            focus,
            predicate,
            depth,
            maxClaims,
            namespaces,
            entityIdentity,
            trustMode,
            recordedSequence,
          })
        );
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'connect_knowledge_graph',
    {
      title: 'Find explicit personal knowledge paths',
      description:
        'Find every bounded shortest path between two atom or numeric entities through explicit stored ground facts. Returns ordered claim segments, a provenance-bearing path graph, aliases, trust, and recorded-view metadata. A no_path result distinguishes complete component exhaustion from a depth-bounded search; no LLM or graph sidecar is used.',
      inputSchema: {
        from: pathEndpointField,
        to: pathEndpointField,
        maxDepth: pathDepthField,
        maxPaths: pathLimitField,
        maxClaims: browseClaimLimitField,
        namespaces: namespacesField,
        entityIdentity: entityIdentityField,
        trustMode: trustViewField,
        recordedSequence: recordedSequenceField,
      },
    },
    async ({
      from,
      to,
      maxDepth,
      maxPaths,
      maxClaims,
      namespaces,
      entityIdentity,
      trustMode,
      recordedSequence,
    }) => {
      try {
        return asContent(
          connectKnowledgeGraphTool(resolvedDeps, {
            from,
            to,
            maxDepth,
            maxPaths,
            maxClaims,
            namespaces,
            entityIdentity,
            trustMode,
            recordedSequence,
          })
        );
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'run_knowledge_checks',
    {
      title: 'Run deterministic knowledge regression suite',
      description:
        'Run a bounded JSON v1 suite of named empty, nonempty, exact-row, or set-row Datalog expectations against one current or recorded view. Passing checks stay compact by default; failures include row deltas plus proof or why-not evidence. No test metadata is stored and no LLM or mutation is used.',
      inputSchema: {
        suite: z
          .string()
          .max(MAX_KNOWLEDGE_CHECK_SUITE_BYTES)
          .describe('Serialized knowledge check suite JSON'),
        namespaces: namespacesField,
        proofLimit: proofLimitField,
        entityIdentity: entityIdentityField,
        trustMode: trustViewField,
        recordedSequence: recordedSequenceField,
        includePassingEvidence: z.boolean().optional(),
      },
    },
    async ({
      suite,
      namespaces,
      proofLimit,
      entityIdentity,
      trustMode,
      recordedSequence,
      includePassingEvidence,
    }) => {
      try {
        return asContent(
          runKnowledgeChecksTool(resolvedDeps, {
            suite,
            namespaces,
            proofLimit,
            entityIdentity,
            trustMode,
            recordedSequence,
            includePassingEvidence,
          })
        );
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'profile_query',
    {
      title: 'Profile deterministic query work',
      description:
        'Run a Datalog query with exact proofs and graph while returning deterministic relation lookup, index-build, and candidate-fact counters. Optional full-scan comparison reruns with indexes disabled and returns only if explanations are byte-identical. No timing, LLM, or mutation is used.',
      inputSchema: {
        query: boundedText(),
        namespaces: namespacesField,
        proofLimit: proofLimitField,
        entityIdentity: entityIdentityField,
        trustMode: trustViewField,
        graphSelector: graphSelectorField,
        recordedSequence: recordedSequenceField,
        compareFullScan: z.boolean().optional(),
      },
    },
    async ({
      query,
      namespaces,
      proofLimit,
      entityIdentity,
      trustMode,
      graphSelector,
      recordedSequence,
      compareFullScan,
    }) => {
      try {
        return asContent(
          profileKnowledgeTool(resolvedDeps, {
            query,
            namespaces,
            proofLimit,
            entityIdentity,
            trustMode,
            graphSelector,
            recordedSequence,
            compareFullScan,
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
        trustMode: trustViewField,
        recordedSequence: recordedSequenceField,
      },
    },
    async ({ query, namespaces, entityIdentity, trustMode, recordedSequence }) => {
      try {
        return asContent(
          queryTool(resolvedDeps, {
            query,
            namespaces,
            entityIdentity,
            trustMode,
            recordedSequence,
          })
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
        trustMode: trustViewField,
        graphSelector: graphSelectorField,
        recordedSequence: recordedSequenceField,
      },
    },
    async ({
      query,
      namespaces,
      proofLimit,
      entityIdentity,
      trustMode,
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
            trustMode,
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
    'why_not',
    {
      title: 'Explain why a query is blocked',
      description:
        'Deterministically explain an empty Datalog query by following conjunction bindings and rule alternatives to missing facts, present negated facts, false comparisons, recursive cycles, or aggregate output mismatches. Includes sourced nearby facts and a blocker graph; no LLM is used.',
      inputSchema: {
        query: boundedText(),
        namespaces: namespacesField,
        proofLimit: proofLimitField,
        entityIdentity: entityIdentityField,
        trustMode: trustViewField,
        recordedSequence: recordedSequenceField,
        maxFailures: whyNotFailureLimitField,
        maxDiagnosticDepth: whyNotDepthField,
        maxCandidatesPerFailure: whyNotCandidateLimitField,
        maxEvidenceFacts: whyNotEvidenceLimitField,
      },
    },
    async ({
      query,
      namespaces,
      proofLimit,
      entityIdentity,
      trustMode,
      recordedSequence,
      maxFailures,
      maxDiagnosticDepth,
      maxCandidatesPerFailure,
      maxEvidenceFacts,
    }) => {
      try {
        return asContent(
          whyNotTool(resolvedDeps, {
            query,
            namespaces,
            proofLimit,
            entityIdentity,
            trustMode,
            recordedSequence,
            maxFailures,
            maxDiagnosticDepth,
            maxCandidatesPerFailure,
            maxEvidenceFacts,
          })
        );
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'audit_rules',
    {
      title: 'Audit deterministic rule health',
      description:
        'Audit the selected current or recorded rule program for undefined closed-world negation, policy inputs without definitions, inert recursion, open positive inputs, inactive derived predicates, alpha-equivalent duplicates, and predicate arity overload. Findings link to an evidence topology graph; no LLM or mutation is used.',
      inputSchema: {
        namespaces: namespacesField,
        focus: topologyFocusField,
        direction: topologyDirectionField,
        entityIdentity: entityIdentityField,
        trustMode: trustViewField,
        recordedSequence: recordedSequenceField,
      },
    },
    async ({
      namespaces,
      focus,
      direction,
      entityIdentity,
      trustMode,
      recordedSequence,
    }) => {
      try {
        return asContent(
          auditRulesTool(resolvedDeps, {
            namespaces,
            focus,
            direction,
            entityIdentity,
            trustMode,
            recordedSequence,
          })
        );
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'plan_query_repair',
    {
      title: 'Plan verified query repairs',
      description:
        'Search bounded why-not blockers for subset-minimal ground fact assumptions or retractions, then counterfactually verify every returned plan against the query and integrity policies on one captured baseline. Plans are proposals only; no fact, source, or journal entry is written.',
      inputSchema: {
        query: boundedText(),
        namespace: namespaceField,
        namespaces: namespacesField,
        proofLimit: proofLimitField,
        maxViolations: maxViolationsField,
        entityIdentity: entityIdentityField,
        trustMode: trustViewField,
        maxPlans: repairPlanLimitField,
        maxSteps: repairStepLimitField,
        maxSearchStates: repairSearchStateLimitField,
      },
    },
    async ({
      query,
      namespace,
      namespaces,
      proofLimit,
      maxViolations,
      entityIdentity,
      trustMode,
      maxPlans,
      maxSteps,
      maxSearchStates,
    }) => {
      try {
        return asContent(
          repairPlanTool(resolvedDeps, {
            query,
            namespace,
            namespaces,
            proofLimit,
            maxViolations,
            entityIdentity,
            trustMode,
            maxPlans,
            maxSteps,
            maxSearchStates,
          })
        );
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'knowledge_topology',
    {
      title: 'Map knowledge topology',
      description:
        'Build a deterministic semantic graph of predicates, alpha-equivalent rule groups, integrity policies, positive/negative/aggregate dependencies, strata, recursive components, provenance, and open inputs. Optional focus selects complete upstream/downstream influence without an LLM or persistent graph.',
      inputSchema: {
        namespaces: namespacesField,
        focus: topologyFocusField,
        direction: topologyDirectionField,
        entityIdentity: entityIdentityField,
        trustMode: trustViewField,
        recordedSequence: recordedSequenceField,
      },
    },
    async ({
      namespaces,
      focus,
      direction,
      entityIdentity,
      trustMode,
      recordedSequence,
    }) => {
      try {
        return asContent(
          topologyTool(resolvedDeps, {
            namespaces,
            focus,
            direction,
            entityIdentity,
            trustMode,
            recordedSequence,
          })
        );
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'diff_recorded_knowledge',
    {
      title: 'Diff recorded knowledge',
      description:
        'Compare two exact global journal positions as one coherent read. Returns semantic fact/rule/policy and provenance changes, topology node/edge impact, introduced/resolved integrity violations, and optional before/after query proofs. Timestamps never order the diff and no memory is changed.',
      inputSchema: {
        fromSequence: recordedDiffSequenceField,
        toSequence: recordedDiffSequenceField,
        namespaces: namespacesField,
        query: boundedText('Optional Datalog query whose result/proof impact is compared').optional(),
        proofLimit: proofLimitField,
        maxViolations: maxViolationsField,
        entityIdentity: entityIdentityField,
        trustMode: trustViewField,
      },
    },
    async ({
      fromSequence,
      toSequence,
      namespaces,
      query,
      proofLimit,
      maxViolations,
      entityIdentity,
      trustMode,
    }) => {
      try {
        return asContent(
          recordedDiffTool(resolvedDeps, {
            fromSequence,
            toSequence,
            namespaces,
            query,
            proofLimit,
            maxViolations,
            entityIdentity,
            trustMode,
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
        trustMode: trustViewField,
        graphSelector: graphSelectorField,
        recordedSequence: recordedSequenceField,
      },
    },
    async ({
      namespaces,
      proofLimit,
      maxViolations,
      entityIdentity,
      trustMode,
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
            trustMode,
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
    'conflict_views',
    {
      title: 'Inspect focused knowledge conflicts',
      description:
        "Group complete integrity violations by each constraint's first alpha-stable binding. Optional focus, canonical identity, recorded snapshots, proofs, durable sources, and per-cluster graph selection are supported. No LLM is used and no conflict store is persisted.",
      inputSchema: {
        focus: conflictFocusField,
        namespaces: namespacesField,
        proofLimit: proofLimitField,
        maxViolations: maxViolationsField,
        entityIdentity: entityIdentityField,
        trustMode: trustViewField,
        graphSelector: graphSelectorField,
        recordedSequence: recordedSequenceField,
      },
    },
    async ({
      focus,
      namespaces,
      proofLimit,
      maxViolations,
      entityIdentity,
      trustMode,
      graphSelector,
      recordedSequence,
    }) => {
      try {
        return asContent(
          conflictViewsTool(resolvedDeps, {
            focus,
            namespaces,
            proofLimit,
            maxViolations,
            entityIdentity,
            trustMode,
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
    'what_if',
    {
      title: 'Simulate knowledge changes',
      description:
        'Read-only deterministic counterfactual: retract target-namespace fact patterns, assume ordinary ground facts, then compare query rows, proofs, provenance, graphs, and integrity violations with the unchanged baseline. No LLM is used and nothing is persisted.',
      inputSchema: {
        query: boundedText('Datalog query whose result impact should be explained'),
        assume: boundedText(
          `Ordinary ground Datalog facts to assume (maximum ${MAX_COUNTERFACTUAL_ASSUMPTIONS})`
        ).optional(),
        without: z
          .array(boundedText('One positive ground-fact pattern'))
          .max(MAX_COUNTERFACTUAL_RETRACTIONS)
          .optional(),
        namespace: namespaceField,
        namespaces: namespacesField,
        proofLimit: proofLimitField,
        maxViolations: maxViolationsField,
        entityIdentity: entityIdentityField,
        trustMode: trustViewField,
      },
    },
    async ({
      query,
      assume,
      without,
      namespace,
      namespaces,
      proofLimit,
      maxViolations,
      entityIdentity,
      trustMode,
    }) => {
      try {
        return asContent(
          whatIfTool(resolvedDeps, {
            query,
            assume,
            without,
            namespace,
            namespaces,
            proofLimit,
            maxViolations,
            entityIdentity,
            trustMode,
          })
        );
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'export_knowledge_bundle',
    {
      title: 'Export content-addressed knowledge bundle',
      description:
        'Export raw portable namespace clauses, trust/identity metadata, and durable provenance as deterministic JSON with a SHA-256 content digest. Defaults to all namespaces; an optional recorded sequence exports that exact state. The bundle contains personal data and is returned verbatim without an LLM.',
      inputSchema: {
        namespaces: namespacesField,
        recordedSequence: recordedSequenceField,
      },
    },
    async ({ namespaces, recordedSequence }) => {
      try {
        const bundle = exportKnowledgeBundleTool(
          { store: resolvedDeps.store },
          { namespaces, recordedSequence }
        );
        return asRawContent(
          serializeKnowledgeBundle(bundle),
          'MCP knowledge bundle'
        );
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'verify_knowledge_bundle',
    {
      title: 'Verify standalone knowledge bundle',
      description:
        'Verify bundle JSON structure, canonical clauses and ordering, durable provenance, resource bounds, recorded coordinates, and SHA-256 digest without importing or mutating knowledge.',
      inputSchema: {
        bundle: z
          .string()
          .max(MAX_KNOWLEDGE_BUNDLE_BYTES)
          .describe('Serialized rembero knowledge bundle JSON'),
      },
    },
    async ({ bundle }) => {
      try {
        return asContent(verifyKnowledgeBundleTool({ bundle }));
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'checkpoint_journal',
    {
      title: 'Checkpoint journal',
      description:
        'Rotate the active append-only journal into an immutable SHA-256 verified segment and publish an exact namespace/source checkpoint without changing global recorded sequences.',
      inputSchema: {
        opId: operationIdField,
        at: validTimeInstantField,
        dryRun: z.boolean().optional(),
      },
    },
    async ({ opId, at, dryRun }) => {
      try {
        return asContent(
          checkpointJournalTool(
            { store: resolvedDeps.store },
            { opId, at, dryRun }
          )
        );
      } catch (e) {
        return asError(e);
      }
    }
  );

  server.registerTool(
    'list_checkpoints',
    {
      title: 'List journal checkpoints',
      description:
        'List validated immutable journal checkpoint artifacts and their global sequence boundaries.',
      inputSchema: {},
    },
    async () => {
      try {
        return asContent(listCheckpointsTool({ store: resolvedDeps.store }));
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
        trustMode: trustViewField,
        recordedSequence: recordedSequenceField,
      },
    },
    async ({ namespaces, predicate, trustMode, recordedSequence }) => {
      try {
        return asContent(
          listMemoriesTool(resolvedDeps, {
            namespaces,
            predicate,
            trustMode,
            recordedSequence,
          })
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
