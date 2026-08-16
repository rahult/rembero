import {
  type Bindings,
  type Clause,
  type Goal,
  type QuerySpec,
  evaluateQuerySpec,
  isComparison,
  isIntegrityConstraint,
  isNegation,
  parseProgram,
  parseQuery,
  parseQuerySpec,
  serializeClause,
  serializeGoal,
  serializeQuerySpec,
  serializeTerm,
} from '../engine/index.js';
import type { MemoryStore, ValidTimeMode } from '../store/store.js';
import type { ChatMessage, LlmClient } from './client.js';
import { explainKnowledge, type ExplainKnowledgeResult } from '../knowledge/graph.js';
import type { IntegrityEnforcementOptions } from '../knowledge/enforcement.js';
import { assertSafeForExternalLlm } from '../safety.js';
import {
  NOTHING_SENTINEL,
  PHRASING_SYSTEM_PROMPT,
  UNANSWERABLE,
  buildSchemaSummary,
  extractionSystemPrompt,
  phrasingUserPrompt,
  queryGenSystemPrompt,
  transcriptExtractionSystemPrompt,
  type QueryPromptVariant,
} from './prompts.js';
import {
  type RecallSchemaDiagnostics,
  type RecallSchemaSelection,
  MAX_RECALL_SCHEMA_PREDICATES,
  RecallSchemaBudgetError,
  recallEditDistance,
  recallSchemaDiagnostics,
  recallWords,
  selectRecallSchema,
} from './schema.js';

export interface PipelineDeps {
  store: MemoryStore;
  llm: LlmClient;
  /** When set, natural-language operations may export only these namespaces to the LLM. */
  llmAllowedNamespaces?: ReadonlySet<string>;
  /** Default supersession policy for manual natural-language remember operations. */
  validTimeMode?: ValidTimeMode;
  /** Maximum predicate groups receiving detailed recall schema context. */
  recallSchemaPredicateLimit?: number;
  /** Internal/library override for the hard recall schema byte budget. */
  recallSchemaByteLimit?: number;
  /** Optional default atomic reject-on-write policy for memory mutations. */
  /** `false` explicitly disables an environment-derived server default. */
  integrityEnforcement?: IntegrityEnforcementOptions | false;
}

export interface RememberResult {
  added: string[];
  duplicates: number;
  retracted: number;
  archived?: string[];
  opId?: string;
}

export interface RememberOptions {
  validTimeMode?: ValidTimeMode;
  /** Per-call enforcement override; omission uses the dependency default. */
  integrityEnforcement?: IntegrityEnforcementOptions | false;
  /** Controlled clock injection for library tests and deterministic integrations. */
  at?: Date;
}

export interface RememberTranscriptOptions {
  captureId: string;
  at?: Date;
}

export interface RecallResult {
  status: RecallStatus;
  answer: string;
  query: string | null;
  bindings: Record<string, string>[];
  explanation?: ExplainKnowledgeResult;
  pruning?: RecallPruningReport;
}

export interface RetrievalResult {
  status: RecallStatus;
  query: string | null;
  bindings: Record<string, string>[];
  explanation?: ExplainKnowledgeResult;
  pruning?: RecallPruningReport;
}

export type RecallSchemaAttemptOutcome = 'answered' | 'empty' | 'unanswerable';

export interface RecallSchemaAttempt {
  detailedPredicates: number;
  advertisedPredicates: number;
  catalogComplete: boolean;
  schemaComplete: boolean;
  summaryBytes: number;
  outcome: RecallSchemaAttemptOutcome;
}

export interface RecallPruningReport extends RecallSchemaDiagnostics {
  initialSelectedPredicates: string[];
  attempts: RecallSchemaAttempt[];
}

export type RecallStatus =
  | 'answered'
  | 'no_match'
  | 'unanswerable'
  | 'schema_budget_exhausted';

export interface RecallOptions {
  queryPromptVariant?: QueryPromptVariant;
  explain?: boolean;
  /** Total proof witnesses per returned row, including the primary witness. */
  proofLimit?: number;
  schemaPredicateLimit?: number;
  schemaByteLimit?: number;
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
  namespace = 'default',
  options: RememberOptions = {}
): Promise<RememberResult> {
  const validTimeMode = options.validTimeMode ?? deps.validTimeMode ?? 'delete';
  if (validTimeMode !== 'delete' && validTimeMode !== 'archive_until') {
    throw new Error("valid-time mode must be 'delete' or 'archive_until'");
  }
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
      const retractions = retractionLines.map((p) => parseQuery(p));
      if (
        retractions.some(
          (goals) =>
            goals.length !== 1 || isComparison(goals[0]) || isNegation(goals[0])
        )
      ) {
        throw new Error('each retract line must contain exactly one positive fact pattern');
      }
      const clauses = parseProgram(clauseLines.join('\n'));
      if (clauses.some(isIntegrityConstraint)) {
        throw new Error(
          'natural-language memory extraction may not create integrity constraints'
        );
      }
      return { clauses, retractions };
    }
  );
  if (extraction === null) return { added: [], duplicates: 0, retracted: 0 };

  const opId = deps.store.createOperationId();
  const configuredIntegrity =
    options.integrityEnforcement ?? deps.integrityEnforcement;
  const integrity = configuredIntegrity === false ? undefined : configuredIntegrity;
  const context = {
    opId,
    sourceText: text,
    origin: 'manual' as const,
    at: options.at,
    ...(integrity === undefined ? {} : { integrity }),
  };
  if (extraction.retractions.length > 0) {
    const patterns = extraction.retractions.map((goals) =>
      goals.map(serializeGoal).join(', ')
    );
    const result = validTimeMode === 'archive_until'
      ? deps.store.supersede(namespace, patterns, extraction.clauses, context)
      : deps.store.replace(namespace, patterns, extraction.clauses, context);
    return {
      added: result.added.map(serializeClause),
      duplicates: result.duplicates,
      retracted: result.retracted,
      ...(result.archived.length === 0
        ? {}
        : { archived: result.archived.map(serializeClause) }),
      opId,
    };
  }
  if (extraction.clauses.length === 0) {
    return { added: [], duplicates: 0, retracted: 0 };
  }
  if (integrity === undefined) {
    deps.store.note(namespace, 'remember', { opId, text }, options.at);
  }
  const { added, duplicates } = deps.store.assert(namespace, extraction.clauses, context);
  return { added: added.map(serializeClause), duplicates, retracted: 0, opId };
}

/**
 * Extract only additive, ground facts from an untrusted transcript tail.
 * The raw transcript is never persisted as per-fact provenance.
 */
export async function rememberTranscriptText(
  deps: PipelineDeps,
  transcript: string,
  namespace: string,
  options: RememberTranscriptOptions
): Promise<RememberResult> {
  assertLlmNamespacesAllowed(deps, [namespace]);
  assertSafeForExternalLlm(transcript, 'transcript');
  const schema = buildSchemaSummary(deps.store.load(namespace));
  assertSafeForExternalLlm(schema, 'memory schema');
  const messages: ChatMessage[] = [
    { role: 'system', content: transcriptExtractionSystemPrompt(schema) },
    { role: 'user', content: transcript },
  ];
  const clauses = await completeWithRetry(
    deps.llm,
    messages,
    (response): Clause[] | null => {
      if (response === NOTHING_SENTINEL) return null;
      if (response.split('\n').some((line) => /^\s*retract\b/i.test(line))) {
        throw new Error('auto-capture accepts additive ground facts only; retractions are forbidden');
      }
      const parsed = parseProgram(response);
      if (parsed.some((clause) => clause.body.length > 0)) {
        throw new Error('auto-capture accepts additive ground facts only; rules are forbidden');
      }
      if (parsed.length > 12) {
        throw new Error('auto-capture accepts at most 12 additive ground facts');
      }
      return parsed;
    }
  );
  if (clauses === null || clauses.length === 0) {
    return { added: [], duplicates: 0, retracted: 0 };
  }

  const opId = deps.store.createOperationId();
  const { added, duplicates } = deps.store.assert(namespace, clauses, {
    opId,
    captureId: options.captureId,
    origin: 'claude-stop',
    sourceText: 'Auto-captured from a Claude Code Stop hook',
    at: options.at,
    ...(deps.integrityEnforcement === undefined || deps.integrityEnforcement === false
      ? {}
      : { integrity: deps.integrityEnforcement }),
  });
  return {
    added: added.map(serializeClause),
    duplicates,
    retracted: 0,
    opId,
  };
}

function visiblePredicateList(known: ReadonlySet<string>): string {
  const ordered = [...known].sort();
  const visible = ordered.slice(0, 64);
  return `${visible.join(', ') || '(none)'}${
    ordered.length > visible.length ? `, ... (${ordered.length - visible.length} more shown in schema)` : ''
  }`;
}

function validateQueryPredicates(
  goals: Goal[],
  known: ReadonlySet<string>,
  question: string
): void {
  const questionWords = new Set(recallWords(question));
  for (const goal of goals) {
    if (isComparison(goal)) continue;
    const literal = isNegation(goal) ? goal.not : goal;
    const key = `${literal.predicate}/${literal.args.length}`;
    if (known.has(key)) continue;
    if (isNegation(goal)) {
      const sameArity = [...known]
        .map((candidate) => candidate.match(/^(.*)\/(\d+)$/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .filter((match) => Number(match[2]) === literal.args.length)
        .map((match) => match[1]);
      const lookalike = sameArity.find(
        (predicate) =>
          predicate !== literal.predicate &&
          recallEditDistance(predicate, literal.predicate) <= 1
      );
      if (lookalike !== undefined) {
        throw new Error(
          `unknown negated predicate ${key} resembles ${lookalike}/${literal.args.length}; correct the predicate name`
        );
      }
      const predicateWords = recallWords(literal.predicate);
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
        `unknown predicate ${key} — available in this schema: ${visiblePredicateList(known)}`
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

function validateQuerySpec(
  query: QuerySpec,
  known: ReadonlySet<string>,
  question: string
): void {
  validateQueryPredicates(query.goals, known, question);
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
    return { status: 'unanswerable', query: null, bindings: [] };
  }
  const schemaPredicateLimit =
    options.schemaPredicateLimit ?? deps.recallSchemaPredicateLimit;
  const schemaByteLimit = options.schemaByteLimit ?? deps.recallSchemaByteLimit;
  let initialSelection: RecallSchemaSelection;
  try {
    initialSelection = selectRecallSchema(clauses, question, {
      ...(schemaPredicateLimit === undefined
        ? {}
        : { predicateLimit: schemaPredicateLimit }),
      ...(schemaByteLimit === undefined ? {} : { byteLimit: schemaByteLimit }),
    });
  } catch (error) {
    if (!(error instanceof RecallSchemaBudgetError)) throw error;
    try {
      initialSelection = selectRecallSchema(clauses, question, {
        predicateLimit: MAX_RECALL_SCHEMA_PREDICATES,
        ...(schemaByteLimit === undefined ? {} : { byteLimit: schemaByteLimit }),
      });
    } catch (widenError) {
      if (widenError instanceof RecallSchemaBudgetError) {
        return { status: 'schema_budget_exhausted', query: null, bindings: [] };
      }
      throw widenError;
    }
  }

  interface PassResult {
    outcome: RecallSchemaAttemptOutcome;
    query: string | null;
    bindings: Record<string, string>[];
    explanation?: ExplainKnowledgeResult;
  }

  const runPass = async (selection: RecallSchemaSelection): Promise<PassResult> => {
    assertSafeForExternalLlm(selection.summary, 'memory schema');
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: queryGenSystemPrompt(selection.summary, options.queryPromptVariant),
      },
      { role: 'user', content: question },
    ];
    const validateResponse = (response: string): QuerySpec | null => {
      if (UNANSWERABLE_RE.test(response)) return null;
      const parsed = parseQuerySpec(response);
      validateQuerySpec(parsed, selection.availablePredicates, question);
      return parsed;
    };
    const evaluate = (query: QuerySpec, queryText: string): PassResult => {
      if (options.explain) {
        const explanation = explainKnowledge(
          clauses,
          queryText,
          deps.store.sourcesFor(namespaces),
          options.proofLimit === undefined
            ? {}
            : { maxProofsPerRow: options.proofLimit }
        );
        const bindings = explanation.rows.map((row) => row.bindings);
        return {
          outcome: bindings.length > 0 ? 'answered' : 'empty',
          query: queryText,
          bindings,
          explanation,
        };
      }
      const bindings = evaluateQuerySpec(clauses, query).map((binding: Bindings) =>
        Object.fromEntries(
          Object.entries(binding).map(([name, term]) => [name, serializeTerm(term)])
        )
      );
      return {
        outcome: bindings.length > 0 ? 'answered' : 'empty',
        query: queryText,
        bindings,
      };
    };

    let query = await completeWithRetry(deps.llm, messages, validateResponse);
    if (query === null) {
      return { outcome: 'unanswerable', query: null, bindings: [] };
    }
    let queryText = serializeQuerySpec(query);
    let result = evaluate(query, queryText);
    if (result.outcome === 'answered') return result;

    const fallbackMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: `?- ${queryText}.` },
      {
        role: 'user',
        content: `The query ${queryText} returned no results. If it correctly expresses the question, repeat it unchanged: an empty result is valid evidence that no stored fact matches. Try ONE alternative only if the first query mistranslated the question. Output exactly ?- ${UNANSWERABLE}. only when the schema cannot express the question at all, never merely because the result was empty.`,
      },
    ];
    query = await completeWithRetry(deps.llm, fallbackMessages, validateResponse);
    if (query === null) {
      return { outcome: 'unanswerable', query: null, bindings: [] };
    }
    queryText = serializeQuerySpec(query);
    result = evaluate(query, queryText);
    return result;
  };

  const attempts: RecallSchemaAttempt[] = [];
  let finalSelection = initialSelection;
  let pass = await runPass(finalSelection);
  const recordAttempt = () => {
    attempts.push({
      detailedPredicates: finalSelection.selectedPredicates.length,
      advertisedPredicates: finalSelection.advertisedPredicates,
      catalogComplete: finalSelection.catalogComplete,
      schemaComplete: finalSelection.schemaComplete,
      summaryBytes: finalSelection.summaryBytes,
      outcome: pass.outcome,
    });
  };
  recordAttempt();

  if (
    pass.outcome !== 'answered' &&
    !finalSelection.schemaComplete &&
    finalSelection.totalPredicates <= MAX_RECALL_SCHEMA_PREDICATES &&
    finalSelection.selectedPredicates.length < finalSelection.totalPredicates
  ) {
    try {
      finalSelection = selectRecallSchema(clauses, question, {
        predicateLimit: finalSelection.totalPredicates,
        ...(schemaByteLimit === undefined ? {} : { byteLimit: schemaByteLimit }),
      });
      pass = await runPass(finalSelection);
      recordAttempt();
    } catch (error) {
      if (!(error instanceof RecallSchemaBudgetError)) {
        throw error;
      }
      finalSelection = initialSelection;
    }
  }

  const includePruning =
    initialSelection.pruned || !initialSelection.schemaComplete || attempts.length > 1;
  const pruning = includePruning
    ? {
        pruning: {
          ...recallSchemaDiagnostics(finalSelection),
          initialSelectedPredicates: [...initialSelection.selectedPredicates],
          attempts,
        },
      }
    : {};
  const { outcome, ...retrieval } = pass;
  if (pass.outcome === 'answered') {
    return { status: 'answered', ...retrieval, ...pruning };
  }
  if (!finalSelection.schemaComplete) {
    return { status: 'schema_budget_exhausted', ...retrieval, ...pruning };
  }
  return {
    status: outcome === 'empty' ? 'no_match' : 'unanswerable',
    ...retrieval,
    ...pruning,
  };
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
      answer:
        retrieval.status === 'schema_budget_exhausted'
          ? 'Recall reached its schema budget before it could rule out relevant memories.'
          : 'I have no relevant memories to answer that.',
      ...retrieval,
    };
  }

  if (retrieval.status === 'schema_budget_exhausted') {
    return {
      answer: 'Recall reached its schema budget before it could rule out relevant memories.',
      ...retrieval,
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
