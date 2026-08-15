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
  retracted: number;
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
  const extraction = await completeWithRetry(
    deps.llm,
    messages,
    (response): { clauses: Clause[]; retractions: Goal[][] } | null => {
      if (response === NOTHING_SENTINEL) return null;
      const retractionLines: string[] = [];
      const clauseLines: string[] = [];
      for (const line of response.split('\n')) {
        const retractMatch = line.trim().match(/^retract\s+(.*)$/);
        if (retractMatch) retractionLines.push(retractMatch[1].replace(/\.\s*$/, ''));
        else clauseLines.push(line);
      }
      // parse retraction patterns up front so a bad one triggers the retry loop
      return {
        clauses: parseProgram(clauseLines.join('\n')),
        retractions: retractionLines.map((p) => parseQuery(p)),
      };
    }
  );
  if (extraction === null) return { added: [], duplicates: 0, retracted: 0 };

  let retracted = 0;
  for (const pattern of extraction.retractions) {
    retracted += deps.store.retract(namespace, pattern.map(serializeGoal).join(', ')).removed;
  }
  if (extraction.clauses.length > 0 || retracted > 0) {
    deps.store.note(namespace, 'remember', { text });
  }
  if (extraction.clauses.length === 0) return { added: [], duplicates: 0, retracted };
  const { added, duplicates } = deps.store.assert(namespace, extraction.clauses);
  return { added: added.map(serializeClause), duplicates, retracted };
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
  if (clauses.length === 0) {
    return { answer: 'I have no relevant memories to answer that.', query: null, bindings: [] };
  }
  const schema = buildSchemaSummary(clauses);
  const messages: ChatMessage[] = [
    { role: 'system', content: queryGenSystemPrompt(schema) },
    { role: 'user', content: question },
  ];
  const validateResponse = (response: string): Goal[] | null => {
    if (UNANSWERABLE_RE.test(response)) return null;
    const parsed = parseQuery(response);
    validateQueryPredicates(parsed, clauses);
    return parsed;
  };
  const noMemories: RecallResult = {
    answer: 'I have no relevant memories to answer that.',
    query: null,
    bindings: [],
  };
  const evalRows = (goals: Goal[]) =>
    evaluate(clauses, goals).map((b: Bindings) =>
      Object.fromEntries(Object.entries(b).map(([name, term]) => [name, serializeTerm(term)]))
    );

  let goals = await completeWithRetry(deps.llm, messages, validateResponse);
  if (goals === null) return noMemories;

  let queryText = goals.map(serializeGoal).join(', ');
  let rows = evalRows(goals);

  // one shot at an alternative query before giving up on an empty result
  if (rows.length === 0) {
    const fallbackMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: `?- ${queryText}.` },
      {
        role: 'user',
        content: `The query ${queryText} returned no results. Try ONE alternative query — different predicates or fewer constraints — or output exactly: ?- ${UNANSWERABLE}.`,
      },
    ];
    goals = await completeWithRetry(deps.llm, fallbackMessages, validateResponse);
    if (goals === null) return noMemories;
    queryText = goals.map(serializeGoal).join(', ');
    rows = evalRows(goals);
  }

  const answer = await deps.llm.complete([
    { role: 'system', content: PHRASING_SYSTEM_PROMPT },
    { role: 'user', content: phrasingUserPrompt(question, queryText, rows) },
  ]);
  return { answer: answer.trim(), query: queryText, bindings: rows };
}
