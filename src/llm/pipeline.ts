import {
  type Bindings,
  type Clause,
  type Goal,
  evaluate,
  isComparison,
  parseProgram,
  parseQuery,
  serializeClause,
  serializeGoal,
  serializeTerm,
} from '../engine/index.js';
import type { MemoryStore } from '../store/store.js';
import type { ChatMessage, LlmClient } from './client.js';
import {
  NOTHING_SENTINEL,
  PHRASING_SYSTEM_PROMPT,
  UNANSWERABLE,
  buildSchemaSummary,
  extractionSystemPrompt,
  phrasingUserPrompt,
  queryGenSystemPrompt,
} from './prompts.js';

export interface PipelineDeps {
  store: MemoryStore;
  llm: LlmClient;
}

export interface RememberResult {
  added: string[];
  duplicates: number;
}

export interface RecallResult {
  answer: string;
  query: string | null;
  bindings: Record<string, string>[];
}

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
}

/** Ask the LLM, validate its output; on failure, retry once with the error message. */
async function completeWithRetry<T>(
  llm: LlmClient,
  messages: ChatMessage[],
  validate: (response: string) => T
): Promise<T> {
  const response = stripFences(await llm.complete(messages));
  try {
    return validate(response);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: response },
      {
        role: 'user',
        content: `Your previous output failed validation.\nError: ${error}\nOutput corrected lines only.`,
      },
    ];
    return validate(stripFences(await llm.complete(retryMessages)));
  }
}

export async function rememberText(
  deps: PipelineDeps,
  text: string,
  namespace = 'default'
): Promise<RememberResult> {
  const schema = buildSchemaSummary(deps.store.load(namespace));
  const messages: ChatMessage[] = [
    { role: 'system', content: extractionSystemPrompt(schema) },
    { role: 'user', content: text },
  ];
  const clauses = await completeWithRetry(deps.llm, messages, (response): Clause[] | null => {
    if (response === NOTHING_SENTINEL) return null;
    return parseProgram(response);
  });
  if (clauses === null || clauses.length === 0) return { added: [], duplicates: 0 };
  const { added, duplicates } = deps.store.assert(namespace, clauses);
  return { added: added.map(serializeClause), duplicates };
}

function validateQueryPredicates(goals: Goal[], clauses: Clause[]): void {
  const known = new Set(clauses.map((c) => `${c.head.predicate}/${c.head.args.length}`));
  for (const goal of goals) {
    if (isComparison(goal)) continue;
    const key = `${goal.predicate}/${goal.args.length}`;
    if (!known.has(key)) {
      throw new Error(
        `unknown predicate ${key} — available: ${[...known].sort().join(', ') || '(none)'}`
      );
    }
  }
}

const UNANSWERABLE_RE = new RegExp(`^(\\?-)?\\s*${UNANSWERABLE}\\s*\\.?$`);

export async function recallQuestion(
  deps: PipelineDeps,
  question: string,
  namespaces: string[] | '*' = ['default']
): Promise<RecallResult> {
  const clauses = deps.store.clausesFor(namespaces);
  const schema = buildSchemaSummary(clauses);
  const messages: ChatMessage[] = [
    { role: 'system', content: queryGenSystemPrompt(schema) },
    { role: 'user', content: question },
  ];
  const goals = await completeWithRetry(deps.llm, messages, (response): Goal[] | null => {
    if (UNANSWERABLE_RE.test(response)) return null;
    const parsed = parseQuery(response);
    validateQueryPredicates(parsed, clauses);
    return parsed;
  });
  if (goals === null) {
    return { answer: 'I have no relevant memories to answer that.', query: null, bindings: [] };
  }

  const queryText = goals.map(serializeGoal).join(', ');
  const rows = evaluate(clauses, goals).map((b: Bindings) =>
    Object.fromEntries(Object.entries(b).map(([name, term]) => [name, serializeTerm(term)]))
  );

  const answer = await deps.llm.complete([
    { role: 'system', content: PHRASING_SYSTEM_PROMPT },
    { role: 'user', content: phrasingUserPrompt(question, queryText, rows) },
  ]);
  return { answer: answer.trim(), query: queryText, bindings: rows };
}
