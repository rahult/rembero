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
import type { MemoryHistory, MemoryStore } from '../store/store.js';
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
  });
}

export function assertFactsTool(
  deps: StoreToolDeps,
  args: {
    clauses: string;
    namespace?: string;
    integrityEnforcement?: IntegrityEnforcementOptions;
  }
): { added: string[]; duplicates: number; opId: string } {
  assertBoundedInput(args.clauses, 'clauses');
  const configured = args.integrityEnforcement ?? deps.integrityEnforcement;
  const integrity = configured === false ? undefined : configured;
  const { added, duplicates, opId } = deps.store.assert(
    args.namespace ?? 'default',
    args.clauses,
    integrity === undefined ? {} : { integrity }
  );
  return { added: added.map(serializeClause), duplicates, opId };
}

export function queryTool(
  deps: StoreToolDeps,
  args: {
    query: string;
    namespaces?: string[] | '*';
    entityIdentity?: EntityIdentityMode;
  }
): { bindings: Record<string, string>[] } {
  assertBoundedInput(args.query, 'query');
  const namespaces = namespacesOrDefault(args.namespaces);
  const clauses = deps.store.clausesFor(namespaces);
  const sources = deps.store.sourcesFor(namespaces);
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
  return { bindings };
}

export function explainQueryTool(
  deps: StoreToolDeps,
  args: {
    query: string;
    namespaces?: string[] | '*';
    proofLimit?: number;
    entityIdentity?: EntityIdentityMode;
    graphSelector?: ExplanationGraphSelector;
  }
): ExplainKnowledgeResult {
  assertBoundedInput(args.query, 'query');
  const namespaces = namespacesOrDefault(args.namespaces);
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  return explainKnowledge(
    deps.store.clausesFor(namespaces),
    args.query,
    deps.store.sourcesFor(namespaces),
    {
      ...(args.proofLimit === undefined ? {} : { maxProofsPerRow: args.proofLimit }),
      ...(entityIdentity === undefined ? {} : { entityIdentity }),
      ...(args.graphSelector === undefined ? {} : { graphSelector: args.graphSelector }),
    }
  );
}

export function checkIntegrityTool(
  deps: StoreToolDeps,
  args: {
    namespaces?: string[] | '*';
    proofLimit?: number;
    maxViolations?: number;
    entityIdentity?: EntityIdentityMode;
    graphSelector?: ExplanationGraphSelector;
  }
): IntegrityCheckResult {
  const namespaces = namespacesOrDefault(args.namespaces);
  const configuredIdentity = args.entityIdentity ?? deps.entityIdentity;
  const entityIdentity = configuredIdentity === false ? undefined : configuredIdentity;
  return checkIntegrity(
    deps.store.clausesFor(namespaces),
    deps.store.sourcesFor(namespaces),
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
}

export function forgetTool(
  deps: StoreToolDeps,
  args: {
    pattern: string;
    namespace?: string;
    integrityEnforcement?: IntegrityEnforcementOptions;
  }
): { removed: number; opId: string } {
  assertBoundedInput(args.pattern, 'forget pattern');
  const configured = args.integrityEnforcement ?? deps.integrityEnforcement;
  const integrity = configured === false ? undefined : configured;
  return deps.store.retract(
    args.namespace ?? 'default',
    args.pattern,
    integrity === undefined ? {} : { integrity }
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
  args: { namespaces?: string[] | '*'; predicate?: string }
): {
  predicates: PredicateGroup[];
  constraints?: string[];
  aliases?: EntityAlias[];
  entityPositions?: EntityPosition[];
  identityError?: { code: 'entity_identity_error'; message: string };
} {
  const namespaces = namespacesOrDefault(args.namespaces);
  const storedClauses = deps.store.clausesFor(namespaces);
  const storedSources = deps.store.sourcesFor(namespaces);
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
  };
}
