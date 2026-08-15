import {
  evaluate,
  parseQuery,
  predKey,
  serializeClause,
  serializeTerm,
} from '../engine/index.js';
import type { LlmClient } from '../llm/client.js';
import {
  type RecallResult,
  type RememberResult,
  recallQuestion,
  rememberText,
} from '../llm/pipeline.js';
import type { MemoryStore } from '../store/store.js';

export interface LlmToolDeps {
  store: MemoryStore;
  llm: LlmClient;
}

export interface StoreToolDeps {
  store: MemoryStore;
}

type NamespacesArg = string[] | '*' | undefined;

const namespacesOrDefault = (namespaces: NamespacesArg): string[] | '*' =>
  namespaces ?? ['default'];

export function rememberTool(
  deps: LlmToolDeps,
  args: { text: string; namespace?: string }
): Promise<RememberResult> {
  return rememberText(deps, args.text, args.namespace ?? 'default');
}

export function recallTool(
  deps: LlmToolDeps,
  args: { question: string; namespaces?: string[] | '*' }
): Promise<RecallResult> {
  return recallQuestion(deps, args.question, namespacesOrDefault(args.namespaces));
}

export function assertFactsTool(
  deps: StoreToolDeps,
  args: { clauses: string; namespace?: string }
): { added: string[]; duplicates: number } {
  const { added, duplicates } = deps.store.assert(args.namespace ?? 'default', args.clauses);
  return { added: added.map(serializeClause), duplicates };
}

export function queryTool(
  deps: StoreToolDeps,
  args: { query: string; namespaces?: string[] | '*' }
): { bindings: Record<string, string>[] } {
  const clauses = deps.store.clausesFor(namespacesOrDefault(args.namespaces));
  const bindings = evaluate(clauses, parseQuery(args.query)).map((b) =>
    Object.fromEntries(Object.entries(b).map(([name, term]) => [name, serializeTerm(term)]))
  );
  return { bindings };
}

export function forgetTool(
  deps: StoreToolDeps,
  args: { pattern: string; namespace?: string }
): { removed: number } {
  return deps.store.retract(args.namespace ?? 'default', args.pattern);
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
