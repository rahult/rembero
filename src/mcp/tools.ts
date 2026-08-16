import {
  evaluateQuerySpec,
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
import { assertBoundedInput, assertNamespaceCount } from '../safety.js';

export type LlmToolDeps = PipelineDeps;

export interface StoreToolDeps {
  store: MemoryStore;
}

type NamespacesArg = string[] | '*' | undefined;

const namespacesOrDefault = (namespaces: NamespacesArg): string[] | '*' => {
  const resolved = namespaces ?? ['default'];
  assertNamespaceCount(resolved);
  return resolved;
};

export function rememberTool(
  deps: LlmToolDeps,
  args: { text: string; namespace?: string }
): Promise<RememberResult> {
  assertBoundedInput(args.text, 'memory text');
  return rememberText(deps, args.text, args.namespace ?? 'default');
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
  }
): Promise<RecallResult> {
  assertBoundedInput(args.question, 'recall question');
  return recallQuestion(deps, args.question, namespacesOrDefault(args.namespaces), {
    explain: true,
    ...(args.schemaPredicateLimit === undefined
      ? {}
      : { schemaPredicateLimit: args.schemaPredicateLimit }),
  });
}

export function assertFactsTool(
  deps: StoreToolDeps,
  args: { clauses: string; namespace?: string }
): { added: string[]; duplicates: number; opId: string } {
  assertBoundedInput(args.clauses, 'clauses');
  const { added, duplicates, opId } = deps.store.assert(
    args.namespace ?? 'default',
    args.clauses
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
  args: { query: string; namespaces?: string[] | '*' }
): ExplainKnowledgeResult {
  assertBoundedInput(args.query, 'query');
  const namespaces = namespacesOrDefault(args.namespaces);
  return explainKnowledge(
    deps.store.clausesFor(namespaces),
    args.query,
    deps.store.sourcesFor(namespaces)
  );
}

export function forgetTool(
  deps: StoreToolDeps,
  args: { pattern: string; namespace?: string }
): { removed: number; opId: string } {
  assertBoundedInput(args.pattern, 'forget pattern');
  return deps.store.retract(args.namespace ?? 'default', args.pattern);
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
): { predicates: PredicateGroup[] } {
  const clauses = deps.store.clausesFor(namespacesOrDefault(args.namespaces));
  const groups = new Map<string, PredicateGroup>();
  for (const clause of clauses) {
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
  return { predicates: [...groups.values()] };
}
