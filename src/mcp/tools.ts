import {
  evaluateQuerySpec,
  isComparison,
  isIntegrityConstraint,
  isNegation,
  parseQuerySpec,
  predKey,
  serializeClause,
  serializeTerm,
} from '../engine/index.js';
import {
  type RecallResult,
  type RememberResult,
  type PipelineDeps,
  recallQuestion,
  rememberText,
} from '../llm/pipeline.js';
import type {
  MemoryHistory,
  MemorySource,
  MemoryStore,
  RecordedSnapshotMetadata,
  SupersedeResult,
} from '../store/store.js';
import type { Clause } from '../engine/index.js';
import { explainKnowledge, type ExplainKnowledgeResult } from '../knowledge/graph.js';
import {
  checkIntegrity,
  type IntegrityCheckResult,
} from '../knowledge/integrity.js';
import type { IntegrityEnforcementOptions } from '../knowledge/enforcement.js';
import {
  EntityIdentityError,
  buildEntityResolver,
  canonicalizeKnowledge,
  literalKnowledge,
  type EntityAlias,
  type EntityIdentityMode,
  type EntityPosition,
  type EntityResolver,
} from '../knowledge/identity.js';
import { assertBoundedInput, assertNamespaceCount } from '../safety.js';
import type { ExplanationGraphSelector } from '../knowledge/graph-navigation.js';

export type LlmToolDeps = PipelineDeps;

export interface StoreToolDeps {
  store: MemoryStore;
  integrityEnforcement?: IntegrityEnforcementOptions | false;
  entityIdentity?: EntityIdentityMode | false;
}

type NamespacesArg = string[] | '*' | undefined;

const namespacesOrDefault = (namespaces: NamespacesArg): string[] | '*' => {
  const resolved = namespaces ?? ['default'];
  assertNamespaceCount(resolved);
  return resolved;
};

function recordedView(
  store: MemoryStore,
  namespaces: string[] | '*',
  sequence?: number
): {
  clauses: Clause[];
  sources: Map<string, MemorySource[]>;
  recordedSnapshot?: RecordedSnapshotMetadata;
} {
  if (sequence === undefined) {
    return { clauses: store.clausesFor(namespaces), sources: store.sourcesFor(namespaces) };
  }
  const snapshot = store.recordedSnapshot(namespaces, sequence);
  return {
    clauses: snapshot.clauses,
    sources: snapshot.sources,
    recordedSnapshot: {
      sequence: snapshot.sequence,
      journalEntries: snapshot.journalEntries,
      namespaces: snapshot.namespaces,
    },
  };
}

export function rememberTool(
  deps: LlmToolDeps,
  args: {
    text: string;
    namespace?: string;
    integrityEnforcement?: IntegrityEnforcementOptions;
    entityIdentity?: EntityIdentityMode;
  }
): Promise<RememberResult> {
  assertBoundedInput(args.text, 'memory text');
  return rememberText(deps, args.text, args.namespace ?? 'default', {
    ...(args.integrityEnforcement === undefined
      ? {}
      : { integrityEnforcement: args.integrityEnforcement }),
    ...(args.entityIdentity === undefined
      ? {}
      : { entityIdentity: args.entityIdentity }),
  });
}

export function recallTool(
  deps: LlmToolDeps,
  args: {
    question: string;
    namespaces?: string[] | '*';
    schemaPredicateLimit?: number;
    entityIdentity?: EntityIdentityMode;
    recordedSequence?: number;
  }
): Promise<RecallResult> {
  assertBoundedInput(args.question, 'recall question');
  return recallQuestion(deps, args.question, namespacesOrDefault(args.namespaces), {
    ...(args.schemaPredicateLimit === undefined
      ? {}
      : { schemaPredicateLimit: args.schemaPredicateLimit }),
    ...(args.entityIdentity === undefined
      ? {}
      : { entityIdentity: args.entityIdentity }),
    ...(args.recordedSequence === undefined
      ? {}
      : { recordedSequence: args.recordedSequence }),
  });
}

export function recallExplainTool(
  deps: LlmToolDeps,
  args: {
    question: string;
    namespaces?: string[] | '*';
    schemaPredicateLimit?: number;
    proofLimit?: number;
    entityIdentity?: EntityIdentityMode;
    graphSelector?: ExplanationGraphSelector;
    recordedSequence?: number;
  }
): Promise<RecallResult> {
  assertBoundedInput(args.question, 'recall question');
  return recallQuestion(deps, args.question, namespacesOrDefault(args.namespaces), {
    explain: true,
    ...(args.proofLimit === undefined ? {} : { proofLimit: args.proofLimit }),
    ...(args.schemaPredicateLimit === undefined
      ? {}
      : { schemaPredicateLimit: args.schemaPredicateLimit }),
    ...(args.entityIdentity === undefined
      ? {}
      : { entityIdentity: args.entityIdentity }),
    ...(args.graphSelector === undefined ? {} : { graphSelector: args.graphSelector }),
    ...(args.recordedSequence === undefined
      ? {}
      : { recordedSequence: args.recordedSequence }),
  });
}

export function assertFactsTool(
  deps: StoreToolDeps,
  args: {
    clauses: string;
    namespace?: string;
    opId?: string;
    integrityEnforcement?: IntegrityEnforcementOptions;
  }
): { added: string[]; duplicates: number; opId: string } {
  assertBoundedInput(args.clauses, 'clauses');
  const configured = args.integrityEnforcement ?? deps.integrityEnforcement;
  const integrity = configured === false ? undefined : configured;
  const { added, duplicates, opId } = deps.store.assert(
    args.namespace ?? 'default',
    args.clauses,
    {
      ...(args.opId === undefined ? {} : { opId: args.opId }),
      ...(integrity === undefined ? {} : { integrity }),
    }
  );
  return { added: added.map(serializeClause), duplicates, opId };
}

export function validTimeInstant(value: string): Date {
  assertBoundedInput(value, 'valid-time instant');
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== value) {
    throw new Error(
      'valid-time instant must be a canonical UTC timestamp such as 2026-08-16T16:59:00.000Z'
    );
  }
  return instant;
}

export interface SupersedeFactsResult {
  added: string[];
  duplicates: number;
  retracted: number;
  archived: string[];
  opId: string;
}

export function supersedeFactsTool(
  deps: StoreToolDeps,
  args: {
    patterns: string[];
    replacements?: string;
    namespace?: string;
    at?: string;
    opId?: string;
    integrityEnforcement?: IntegrityEnforcementOptions;
  }
): SupersedeFactsResult {
  for (const pattern of args.patterns) assertBoundedInput(pattern, 'supersede pattern');
  assertBoundedInput(args.patterns.join('\n'), 'supersede patterns');
  const replacements = args.replacements ?? '';
  assertBoundedInput(replacements, 'replacement clauses');
  const configured = args.integrityEnforcement ?? deps.integrityEnforcement;
  const integrity = configured === false ? undefined : configured;
  const result: SupersedeResult = deps.store.supersede(
    args.namespace ?? 'default',
    args.patterns,
    replacements,
    {
      ...(args.at === undefined ? {} : { at: validTimeInstant(args.at) }),
      ...(args.opId === undefined ? {} : { opId: args.opId }),
      ...(integrity === undefined ? {} : { integrity }),
    }
  );
  return {
    added: result.added.map(serializeClause),
    duplicates: result.duplicates,
    retracted: result.retracted,
    archived: result.archived.map(serializeClause),
    opId: result.opId,
  };
}

export function queryTool(
  deps: StoreToolDeps,
  args: {
    query: string;
    namespaces?: string[] | '*';
    entityIdentity?: EntityIdentityMode;
    recordedSequence?: number;
  }
): { bindings: Record<string, string>[]; recordedSnapshot?: RecordedSnapshotMetadata } {
  assertBoundedInput(args.query, 'query');
  const namespaces = namespacesOrDefault(args.namespaces);
  const recorded = recordedView(deps.store, namespaces, args.recordedSequence);
  const { clauses, sources } = recorded;
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const view = entityIdentity === 'canonical'
    ? canonicalizeKnowledge(clauses, sources)
    : literalKnowledge(clauses, sources);
  const parsed = parseQuerySpec(args.query);
  const query = entityIdentity === 'canonical'
    ? view.resolver.canonicalizeQuery(parsed).query
    : parsed;
  const bindings = evaluateQuerySpec(view.clauses, query).map((b) =>
    Object.fromEntries(Object.entries(b).map(([name, term]) => [name, serializeTerm(term)]))
  );
  return {
    bindings,
    ...(recorded.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: recorded.recordedSnapshot }),
  };
}

export function explainQueryTool(
  deps: StoreToolDeps,
  args: {
    query: string;
    namespaces?: string[] | '*';
    proofLimit?: number;
    entityIdentity?: EntityIdentityMode;
    graphSelector?: ExplanationGraphSelector;
    recordedSequence?: number;
  }
): ExplainKnowledgeResult & { recordedSnapshot?: RecordedSnapshotMetadata } {
  assertBoundedInput(args.query, 'query');
  const namespaces = namespacesOrDefault(args.namespaces);
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const recorded = recordedView(deps.store, namespaces, args.recordedSequence);
  const result = explainKnowledge(
    recorded.clauses,
    args.query,
    recorded.sources,
    {
      ...(args.proofLimit === undefined ? {} : { maxProofsPerRow: args.proofLimit }),
      ...(entityIdentity === undefined ? {} : { entityIdentity }),
      ...(args.graphSelector === undefined ? {} : { graphSelector: args.graphSelector }),
    }
  );
  return {
    ...result,
    ...(recorded.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: recorded.recordedSnapshot }),
  };
}

export function checkIntegrityTool(
  deps: StoreToolDeps,
  args: {
    namespaces?: string[] | '*';
    proofLimit?: number;
    maxViolations?: number;
    entityIdentity?: EntityIdentityMode;
    graphSelector?: ExplanationGraphSelector;
    recordedSequence?: number;
  }
): IntegrityCheckResult & { recordedSnapshot?: RecordedSnapshotMetadata } {
  const namespaces = namespacesOrDefault(args.namespaces);
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  const recorded = recordedView(deps.store, namespaces, args.recordedSequence);
  const result = checkIntegrity(
    recorded.clauses,
    recorded.sources,
    {
      ...(args.proofLimit === undefined
        ? {}
        : { maxProofsPerRow: args.proofLimit }),
      ...(args.maxViolations === undefined
        ? {}
        : { maxViolations: args.maxViolations }),
      ...(entityIdentity === undefined ? {} : { entityIdentity }),
      ...(args.graphSelector === undefined ? {} : { graphSelector: args.graphSelector }),
    }
  );
  return {
    ...result,
    ...(recorded.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: recorded.recordedSnapshot }),
  };
}

export function forgetTool(
  deps: StoreToolDeps,
  args: {
    pattern: string;
    namespace?: string;
    opId?: string;
    integrityEnforcement?: IntegrityEnforcementOptions;
  }
): { removed: number; opId: string } {
  assertBoundedInput(args.pattern, 'forget pattern');
  const configured = args.integrityEnforcement ?? deps.integrityEnforcement;
  const integrity = configured === false ? undefined : configured;
  return deps.store.retract(
    args.namespace ?? 'default',
    args.pattern,
    {
      ...(args.opId === undefined ? {} : { opId: args.opId }),
      ...(integrity === undefined ? {} : { integrity }),
    }
  );
}

export function historyTool(
  deps: StoreToolDeps,
  args: { pattern: string; namespaces?: string[] | '*'; limit?: number }
): MemoryHistory {
  assertBoundedInput(args.pattern, 'history pattern');
  const namespaces = namespacesOrDefault(args.namespaces);
  return deps.store.history(args.pattern, {
    namespaces,
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  });
}

export interface PredicateGroup {
  predicate: string;
  facts: string[];
  rules?: string[];
}

export function listMemoriesTool(
  deps: StoreToolDeps,
  args: { namespaces?: string[] | '*'; predicate?: string; recordedSequence?: number }
): {
  predicates: PredicateGroup[];
  constraints?: string[];
  aliases?: EntityAlias[];
  entityPositions?: EntityPosition[];
  identityError?: { code: 'entity_identity_error'; message: string };
  recordedSnapshot?: RecordedSnapshotMetadata;
} {
  const namespaces = namespacesOrDefault(args.namespaces);
  const recorded = recordedView(deps.store, namespaces, args.recordedSequence);
  const storedClauses = recorded.clauses;
  const storedSources = recorded.sources;
  const view = literalKnowledge(storedClauses, storedSources);
  let resolver: EntityResolver | undefined;
  let identityError: { code: 'entity_identity_error'; message: string } | undefined;
  try {
    resolver = buildEntityResolver(storedClauses, storedSources);
  } catch (error) {
    if (!(error instanceof EntityIdentityError)) throw error;
    identityError = { code: error.code, message: error.message };
  }
  const clauses = view.clauses;
  const groups = new Map<string, PredicateGroup>();
  const constraints: string[] = [];
  for (const clause of clauses) {
    if (isIntegrityConstraint(clause)) {
      const matchesFilter =
        args.predicate === undefined ||
        clause.body.some((goal) => {
          if (isComparison(goal)) return false;
          const literal = isNegation(goal) ? goal.not : goal;
          return (
            literal.predicate === args.predicate ||
            predKey(literal) === args.predicate
          );
        });
      if (matchesFilter) constraints.push(serializeClause(clause));
      continue;
    }
    const key = predKey(clause.head);
    if (args.predicate && key !== args.predicate && clause.head.predicate !== args.predicate) {
      continue;
    }
    let group = groups.get(key);
    if (!group) {
      group = { predicate: key, facts: [] };
      groups.set(key, group);
    }
    if (clause.body.length === 0) {
      group.facts.push(serializeClause(clause));
    } else {
      (group.rules ??= []).push(serializeClause(clause));
    }
  }
  const aliases = resolver?.aliases() ?? [];
  const entityPositions = resolver?.positions() ?? [];
  return {
    predicates: [...groups.values()],
    ...(constraints.length === 0 ? {} : { constraints }),
    ...(aliases.length === 0 ? {} : { aliases }),
    ...(entityPositions.length === 0 ? {} : { entityPositions }),
    ...(identityError === undefined ? {} : { identityError }),
    ...(recorded.recordedSnapshot === undefined
      ? {}
      : { recordedSnapshot: recorded.recordedSnapshot }),
  };
}
