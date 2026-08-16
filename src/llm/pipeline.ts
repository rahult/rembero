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
import { explainKnowledge, type ExplainKnowledgeResult } from '../knowledge/graph.js';
import { assertSafeForExternalLlm } from '../safety.js';
import {
  NOTHING_SENTINEL,
  PHRASING_SYSTEM_PROMPT,
  UNANSWERABLE,
  buildSchemaSummary,
  extractionSystemPrompt,
  phrasingUserPrompt,
  queryGenSystemPrompt,
  type QueryPromptVariant,
} from './prompts.js';

export interface PipelineDeps {
  store: MemoryStore;
  llm: LlmClient;
}

export interface RememberResult {
  added: string[];
  duplicates: number;
  retracted: number;
  opId?: string;
}

export interface RecallResult {
  answer: string;
  query: string | null;
  bindings: Record<string, string>[];
  explanation?: ExplainKnowledgeResult;
}

export interface RetrievalResult {
  query: string | null;
  bindings: Record<string, string>[];
  explanation?: ExplainKnowledgeResult;
}

export interface RecallOptions {
  queryPromptVariant?: QueryPromptVariant;
  explain?: boolean;
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
  assertSafeForExternalLlm(text, 'memory text');
  const schema = buildSchemaSummary(deps.store.load(namespace));
  assertSafeForExternalLlm(schema, 'memory schema');
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

  const opId = deps.store.createOperationId();
  const context = { opId, sourceText: text };
  let retracted = 0;
  for (const pattern of extraction.retractions) {
    retracted += deps.store.retract(
      namespace,
      pattern.map(serializeGoal).join(', '),
      context
    ).removed;
  }
  if (extraction.clauses.length > 0 || retracted > 0) {
    deps.store.note(namespace, 'remember', { opId, text });
  }
  if (extraction.clauses.length === 0) {
    return { added: [], duplicates: 0, retracted, ...(retracted > 0 ? { opId } : {}) };
  }
  const { added, duplicates } = deps.store.assert(namespace, extraction.clauses, context);
  return { added: added.map(serializeClause), duplicates, retracted, opId };
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

export async function retrieveQuestion(
  deps: PipelineDeps,
  question: string,
  namespaces: string[] | '*' = ['default'],
  options: RecallOptions = {}
): Promise<RetrievalResult> {
  assertSafeForExternalLlm(question, 'recall question');
  const clauses = deps.store.clausesFor(namespaces);
  if (clauses.length === 0) {
    return { query: null, bindings: [] };
  }
  const schema = buildSchemaSummary(clauses);
  assertSafeForExternalLlm(schema, 'memory schema');
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: queryGenSystemPrompt(schema, options.queryPromptVariant),
    },
    { role: 'user', content: question },
  ];
  const validateResponse = (response: string): Goal[] | null => {
    if (UNANSWERABLE_RE.test(response)) return null;
    const parsed = parseQuery(response);
    validateQueryPredicates(parsed, clauses);
    return parsed;
  };
  const evaluateQuery = (goals: Goal[], queryText: string): RetrievalResult => {
    if (options.explain) {
      const explanation = explainKnowledge(
        clauses,
        queryText,
        deps.store.sourcesFor(namespaces)
      );
      return {
        query: queryText,
        bindings: explanation.rows.map((row) => row.bindings),
        explanation,
      };
    }
    return {
      query: queryText,
      bindings: evaluate(clauses, goals).map((b: Bindings) =>
        Object.fromEntries(
          Object.entries(b).map(([name, term]) => [name, serializeTerm(term)])
        )
      ),
    };
  };

  let goals = await completeWithRetry(deps.llm, messages, validateResponse);
  if (goals === null) return { query: null, bindings: [] };

  let queryText = goals.map(serializeGoal).join(', ');
  let retrieval = evaluateQuery(goals, queryText);

  // one shot at an alternative query before giving up on an empty result
  if (retrieval.bindings.length === 0) {
    const fallbackMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: `?- ${queryText}.` },
      {
        role: 'user',
        content: `The query ${queryText} returned no results. If it correctly expresses the question, repeat it unchanged: an empty result is valid evidence that no stored fact matches. Try ONE alternative only if the first query mistranslated the question. Output exactly ?- ${UNANSWERABLE}. only when the schema cannot express the question at all, never merely because the result was empty.`,
      },
    ];
    goals = await completeWithRetry(deps.llm, fallbackMessages, validateResponse);
    if (goals === null) return { query: null, bindings: [] };
    queryText = goals.map(serializeGoal).join(', ');
    retrieval = evaluateQuery(goals, queryText);
  }

  return retrieval;
}

export async function recallQuestion(
  deps: PipelineDeps,
  question: string,
  namespaces: string[] | '*' = ['default'],
  options: RecallOptions = {}
): Promise<RecallResult> {
  const retrieval = await retrieveQuestion(deps, question, namespaces, options);
  if (retrieval.query === null) {
    return {
      answer: 'I have no relevant memories to answer that.',
      query: null,
      bindings: [],
    };
  }

  const phrasing = phrasingUserPrompt(question, retrieval.query, retrieval.bindings);
  assertSafeForExternalLlm(phrasing, 'recall evidence');
  const answer = await deps.llm.complete([
    { role: 'system', content: PHRASING_SYSTEM_PROMPT },
    {
      role: 'user',
      content: phrasing,
    },
  ]);
  return { answer: answer.trim(), ...retrieval };
}
