import {
  type Bindings,
  type Clause,
  type Goal,
  type QuerySpec,
  evaluateQuerySpec,
  isComparison,
  isNegation,
  parseProgram,
  parseQuery,
  parseQuerySpec,
  serializeClause,
  serializeGoal,
  serializeQuerySpec,
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
  /** When set, natural-language operations may export only these namespaces to the LLM. */
  llmAllowedNamespaces?: ReadonlySet<string>;
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

function assertLlmNamespacesAllowed(
  deps: PipelineDeps,
  namespaces: string[] | '*'
): void {
  const allowed = deps.llmAllowedNamespaces;
  if (allowed === undefined) return;
  const selected = namespaces === '*' ? deps.store.listNamespaces() : namespaces;
  const denied = selected.find((namespace) => !allowed.has(namespace));
  if (denied !== undefined) {
    throw new Error(
      `namespace '${denied}' is local-only under REMBERO_LLM_ALLOWED_NAMESPACES`
    );
  }
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
  assertLlmNamespacesAllowed(deps, [namespace]);
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

function canonicalWord(word: string): string {
  const irregular: Record<string, string> = {
    are: 'be',
    been: 'be',
    had: 'have',
    has: 'have',
    is: 'be',
    was: 'be',
    were: 'be',
  };
  if (irregular[word]) return irregular[word];
  if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(canonicalWord);
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function validateQueryPredicates(goals: Goal[], clauses: Clause[], question: string): void {
  const known = new Set(clauses.map((c) => `${c.head.predicate}/${c.head.args.length}`));
  const questionWords = new Set(words(question));
  for (const goal of goals) {
    if (isComparison(goal)) continue;
    const literal = isNegation(goal) ? goal.not : goal;
    const key = `${literal.predicate}/${literal.args.length}`;
    if (known.has(key)) continue;
    if (isNegation(goal)) {
      const sameArity = clauses
        .map((clause) => clause.head)
        .filter((head) => head.args.length === literal.args.length)
        .map((head) => head.predicate);
      const lookalike = sameArity.find(
        (predicate) =>
          predicate !== literal.predicate && editDistance(predicate, literal.predicate) <= 1
      );
      if (lookalike !== undefined) {
        throw new Error(
          `unknown negated predicate ${key} resembles ${lookalike}/${literal.args.length}; correct the predicate name`
        );
      }
      const predicateWords = words(literal.predicate);
      if (
        predicateWords.length === 0 ||
        !predicateWords.every((word) => questionWords.has(word))
      ) {
        throw new Error(
          `unknown negated predicate ${key} must be explicitly named by the question`
        );
      }
      continue;
    }
    if (!known.has(key)) {
      throw new Error(
        `unknown predicate ${key} — available: ${[...known].sort().join(', ') || '(none)'}`
      );
    }
  }
}

const AGGREGATE_INTENT: Record<'count' | 'sum' | 'min' | 'max', RegExp> = {
  count: /\b(?:how many|number of|count)\b/i,
  sum: /\b(?:sum|total)\b/i,
  min: /\b(?:min(?:imum)?|smallest|least|lowest|earliest|youngest)\b/i,
  max: /\b(?:max(?:imum)?|largest|greatest|highest|latest|oldest|most)\b/i,
};

function validateQuerySpec(query: QuerySpec, clauses: Clause[], question: string): void {
  validateQueryPredicates(query.goals, clauses, question);
  const requested = Object.entries(AGGREGATE_INTENT).find(([, pattern]) =>
    pattern.test(question)
  )?.[0];
  if (query.kind === 'relational' && requested !== undefined) {
    throw new Error(
      `question explicitly requests ${requested} aggregation; emit the scalar aggregate query form`
    );
  }
  if (query.kind === 'aggregate' && !AGGREGATE_INTENT[query.op].test(question)) {
    throw new Error(
      `${query.op} aggregation requires the question to explicitly request that aggregate`
    );
  }
}

const UNANSWERABLE_RE = new RegExp(`^(\\?-)?\\s*${UNANSWERABLE}\\s*\\.?$`);

export async function retrieveQuestion(
  deps: PipelineDeps,
  question: string,
  namespaces: string[] | '*' = ['default'],
  options: RecallOptions = {}
): Promise<RetrievalResult> {
  assertLlmNamespacesAllowed(deps, namespaces);
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
  const validateResponse = (response: string): QuerySpec | null => {
    if (UNANSWERABLE_RE.test(response)) return null;
    const parsed = parseQuerySpec(response);
    validateQuerySpec(parsed, clauses, question);
    return parsed;
  };
  const evaluateQuery = (query: QuerySpec, queryText: string): RetrievalResult => {
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
      bindings: evaluateQuerySpec(clauses, query).map((b: Bindings) =>
        Object.fromEntries(
          Object.entries(b).map(([name, term]) => [name, serializeTerm(term)])
        )
      ),
    };
  };

  let query = await completeWithRetry(deps.llm, messages, validateResponse);
  if (query === null) return { query: null, bindings: [] };

  let queryText = serializeQuerySpec(query);
  let retrieval = evaluateQuery(query, queryText);

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
    query = await completeWithRetry(deps.llm, fallbackMessages, validateResponse);
    if (query === null) return { query: null, bindings: [] };
    queryText = serializeQuerySpec(query);
    retrieval = evaluateQuery(query, queryText);
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
