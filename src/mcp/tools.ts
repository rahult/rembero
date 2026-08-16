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
import { assertBoundedInput, assertNamespaceCount } from '../safety.js';

export type LlmToolDeps = PipelineDeps;

export interface StoreToolDeps {
  store: MemoryStore;
  integrityEnforcement?: IntegrityEnforcementOptions | false;
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
  }
): Promise<RememberResult> {
  assertBoundedInput(args.text, 'memory text');
  return rememberText(deps, args.text, args.namespace ?? 'default', {
    ...(args.integrityEnforcement === undefined
      ? {}
      : { integrityEnforcement: args.integrityEnforcement }),
  });
}

export function recallTool(
  deps: LlmToolDeps,
  args: {
    question: string;
    namespaces?: string[] | '*';
    schemaPredicateLimit?: number;
  }
): Promise<RecallResult> {
  assertBoundedInput(args.question, 'recall question');
  return recallQuestion(deps, args.question, namespacesOrDefault(args.namespaces), {
    ...(args.schemaPredicateLimit === undefined
      ? {}
      : { schemaPredicateLimit: args.schemaPredicateLimit }),
  });
}

export function recallExplainTool(
  deps: LlmToolDeps,
  args: {
    question: string;
    namespaces?: string[] | '*';
    schemaPredicateLimit?: number;
    proofLimit?: number;
  }
): Promise<RecallResult> {
  assertBoundedInput(args.question, 'recall question');
  return recallQuestion(deps, args.question, namespacesOrDefault(args.namespaces), {
    explain: true,
    ...(args.proofLimit === undefined ? {} : { proofLimit: args.proofLimit }),
    ...(args.schemaPredicateLimit === undefined
      ? {}
      : { schemaPredicateLimit: args.schemaPredicateLimit }),
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
  args: { query: string; namespaces?: string[] | '*' }
): { bindings: Record<string, string>[] } {
  assertBoundedInput(args.query, 'query');
  const clauses = deps.store.clausesFor(namespacesOrDefault(args.namespaces));
  const bindings = evaluateQuerySpec(clauses, parseQuerySpec(args.query)).map((b) =>
    Object.fromEntries(Object.entries(b).map(([name, term]) => [name, serializeTerm(term)]))
  );
  return { bindings };
}

export function explainQueryTool(
  deps: StoreToolDeps,
  args: { query: string; namespaces?: string[] | '*'; proofLimit?: number }
): ExplainKnowledgeResult {
  assertBoundedInput(args.query, 'query');
  const namespaces = namespacesOrDefault(args.namespaces);
  return explainKnowledge(
    deps.store.clausesFor(namespaces),
    args.query,
    deps.store.sourcesFor(namespaces),
    args.proofLimit === undefined ? {} : { maxProofsPerRow: args.proofLimit }
  );
}

export function checkIntegrityTool(
  deps: StoreToolDeps,
  args: {
    namespaces?: string[] | '*';
    proofLimit?: number;
    maxViolations?: number;
  }
): IntegrityCheckResult {
  const namespaces = namespacesOrDefault(args.namespaces);
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
): { predicates: PredicateGroup[]; constraints?: string[] } {
  const clauses = deps.store.clausesFor(namespacesOrDefault(args.namespaces));
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
  return {
    predicates: [...groups.values()],
    ...(constraints.length === 0 ? {} : { constraints }),
  };
}
