import {
  type Clause,
  type Goal,
  type Term,
  isComparison,
  isNegation,
  predKey,
  serializeClause,
} from '../engine/index.js';
import { serializePromptClause } from './prompts.js';

export const DEFAULT_RECALL_SCHEMA_PREDICATES = 32;
export const MAX_RECALL_SCHEMA_PREDICATES = 256;
export const DEFAULT_RECALL_SCHEMA_BYTES = 24 * 1024;
export const MAX_RECALL_SCHEMA_BYTES = 48 * 1024;
export const MAX_RECALL_SCHEMA_CLAUSES = 100_000;
export const MAX_RECALL_SCHEMA_CANDIDATES = 10_000;
export const MAX_RECALL_QUESTION_WORDS = 256;
const MAX_RANKING_WORD_CHARS = 64;
const MAX_RANKING_TERM_CHARS = 256;

export interface RecallSchemaOptions {
  predicateLimit?: number;
  byteLimit?: number;
}

export interface RecallSchemaDiagnostics {
  totalPredicates: number;
  selectedPredicates: string[];
  advertisedPredicates: number;
  catalogComplete: boolean;
  schemaComplete: boolean;
  summaryBytes: number;
  omittedRules: number;
}

export interface RecallSchemaSelection extends RecallSchemaDiagnostics {
  summary: string;
  availablePredicates: ReadonlySet<string>;
  pruned: boolean;
}

export class RecallSchemaBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecallSchemaBudgetError';
  }
}

interface PredicateGroup {
  key: string;
  predicate: string;
  arity: number;
  facts: Clause[];
  rules: Clause[];
}

const TEMPORAL_INTENT = /\b(?:before|former|formerly|historical|history|past|previous|previously|prior|used to)\b/i;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

export function recallWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(canonicalWord);
}

export function recallEditDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function groupsFor(clauses: Clause[]): Map<string, PredicateGroup> {
  const groups = new Map<string, PredicateGroup>();
  for (const clause of clauses) {
    const key = predKey(clause.head);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        key,
        predicate: clause.head.predicate,
        arity: clause.head.args.length,
        facts: [],
        rules: [],
      };
      groups.set(key, group);
    }
    (clause.body.length === 0 ? group.facts : group.rules).push(clause);
  }
  return groups;
}

function termWords(term: Term): string[] {
  if (term.type === 'atom') {
    return term.value.length <= MAX_RANKING_TERM_CHARS ? recallWords(term.value) : [];
  }
  if (term.type === 'num') return [String(term.value)];
  return [];
}

function overlapCount(values: Iterable<string>, questionWords: ReadonlySet<string>): number {
  const matches = new Set<string>();
  for (const value of values) {
    if (questionWords.has(value)) matches.add(value);
  }
  return matches.size;
}

function goalPredicate(goal: Goal): { predicate: string; arity: number } | undefined {
  if (isComparison(goal)) return undefined;
  const literal = isNegation(goal) ? goal.not : goal;
  return { predicate: literal.predicate, arity: literal.args.length };
}

function groupScore(
  group: PredicateGroup,
  question: string,
  questionWords: ReadonlySet<string>
): number {
  const predicateWords = recallWords(group.predicate);
  let score = overlapCount(predicateWords, questionWords) * 100;
  if (question.toLowerCase().includes(group.predicate.toLowerCase())) score += 200;

  for (const predicateWord of predicateWords) {
    if (
      predicateWord.length < 4 ||
      predicateWord.length > MAX_RANKING_WORD_CHARS ||
      questionWords.has(predicateWord)
    ) {
      continue;
    }
    if (
      [...questionWords].some(
        (questionWord) =>
          questionWord.length >= 4 &&
          questionWord.length <= MAX_RANKING_WORD_CHARS &&
          recallEditDistance(predicateWord, questionWord) <= 1
      )
    ) {
      score += 50;
    }
  }

  const factMatches = new Set<string>();
  for (const fact of group.facts) {
    for (const term of fact.head.args) {
      for (const word of termWords(term)) {
        if (questionWords.has(word)) factMatches.add(word);
      }
    }
  }
  score += factMatches.size * 30;

  const ruleWords = new Set<string>();
  for (const rule of group.rules) {
    for (const goal of rule.body) {
      const relation = goalPredicate(goal);
      if (relation !== undefined) {
        for (const word of recallWords(relation.predicate)) ruleWords.add(word);
      }
    }
  }
  score += overlapCount(ruleWords, questionWords) * 10;

  if (TEMPORAL_INTENT.test(question) && group.predicate.endsWith('_until')) score += 80;
  return score;
}

function dependenciesFor(group: PredicateGroup, groups: ReadonlyMap<string, PredicateGroup>): string[] {
  const dependencies = new Set<string>();
  for (const rule of group.rules) {
    for (const goal of rule.body) {
      const relation = goalPredicate(goal);
      if (relation === undefined) continue;
      const key = `${relation.predicate}/${relation.arity}`;
      if (groups.has(key)) dependencies.add(key);
    }
  }
  return [...dependencies].sort(compareText);
}

function temporalCompanion(
  group: PredicateGroup,
  groups: ReadonlyMap<string, PredicateGroup>
): string | undefined {
  if (group.predicate.endsWith('_until') && group.arity > 0) {
    const base = `${group.predicate.slice(0, -'_until'.length)}/${group.arity - 1}`;
    return groups.has(base) ? base : undefined;
  }
  const archive = `${group.predicate}_until/${group.arity + 1}`;
  return groups.has(archive) ? archive : undefined;
}

function selectionClosure(
  root: string,
  groups: ReadonlyMap<string, PredicateGroup>,
  includeTemporal: boolean
): Set<string> {
  const selected = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (selected.has(key)) continue;
    const group = groups.get(key);
    if (group === undefined) continue;
    selected.add(key);
    for (const dependency of dependenciesFor(group, groups)) pending.push(dependency);
    if (includeTemporal || group.predicate.endsWith('_until')) {
      const companion = temporalCompanion(group, groups);
      if (companion !== undefined) pending.push(companion);
    }
  }
  return selected;
}

function factMatchScore(fact: Clause, questionWords: ReadonlySet<string>): number {
  return fact.head.args.reduce(
    (score, term) => score + overlapCount(termWords(term), questionWords),
    0
  );
}

function diagnostics(selection: RecallSchemaSelection): RecallSchemaDiagnostics {
  return {
    totalPredicates: selection.totalPredicates,
    selectedPredicates: [...selection.selectedPredicates],
    advertisedPredicates: selection.advertisedPredicates,
    catalogComplete: selection.catalogComplete,
    schemaComplete: selection.schemaComplete,
    summaryBytes: selection.summaryBytes,
    omittedRules: selection.omittedRules,
  };
}

export function recallSchemaDiagnostics(
  selection: RecallSchemaSelection
): RecallSchemaDiagnostics {
  return diagnostics(selection);
}

export function selectRecallSchema(
  clauses: Clause[],
  question: string,
  options: RecallSchemaOptions = {}
): RecallSchemaSelection {
  if (clauses.length > MAX_RECALL_SCHEMA_CLAUSES) {
    throw new Error(`recall schema exceeds ${MAX_RECALL_SCHEMA_CLAUSES} clauses`);
  }
  const predicateLimit = boundedInteger(
    options.predicateLimit ?? DEFAULT_RECALL_SCHEMA_PREDICATES,
    1,
    MAX_RECALL_SCHEMA_PREDICATES,
    'recall schema predicate limit'
  );
  const byteLimit = boundedInteger(
    options.byteLimit ?? DEFAULT_RECALL_SCHEMA_BYTES,
    512,
    MAX_RECALL_SCHEMA_BYTES,
    'recall schema byte limit'
  );
  const groups = groupsFor(clauses);
  if (groups.size > MAX_RECALL_SCHEMA_CANDIDATES) {
    throw new Error(
      `recall schema exceeds ${MAX_RECALL_SCHEMA_CANDIDATES} predicate candidates`
    );
  }
  if (groups.size === 0) {
    const summary = '% (no memories yet)';
    return {
      summary,
      availablePredicates: new Set(),
      totalPredicates: 0,
      selectedPredicates: [],
      advertisedPredicates: 0,
      catalogComplete: true,
      schemaComplete: true,
      summaryBytes: Buffer.byteLength(summary, 'utf8'),
      omittedRules: 0,
      pruned: false,
    };
  }

  const rawQuestionWords = recallWords(question);
  if (rawQuestionWords.length > MAX_RECALL_QUESTION_WORDS) {
    throw new Error(`recall question exceeds ${MAX_RECALL_QUESTION_WORDS} ranking words`);
  }
  const questionWords = new Set(rawQuestionWords);
  const scores = new Map(
    [...groups.values()].map((group) => [
      group.key,
      groupScore(group, question, questionWords),
    ])
  );
  const ranked = [...groups.values()].sort((left, right) => {
    const scoreDifference = scores.get(right.key)! - scores.get(left.key)!;
    return scoreDifference || compareText(left.key, right.key);
  });
  const includeTemporal = TEMPORAL_INTENT.test(question);
  const selected = new Set<string>();
  for (const candidate of ranked) {
    if (selected.size >= predicateLimit) break;
    const closure = selectionClosure(candidate.key, groups, includeTemporal);
    const additions = [...closure].filter((key) => !selected.has(key));
    if (selected.size + additions.length > predicateLimit) {
      if (selected.size === 0 && scores.get(candidate.key)! > 0) {
        throw new RecallSchemaBudgetError(
          `relevant predicate dependency group exceeds recall schema limit ${predicateLimit}`
        );
      }
      continue;
    }
    for (const key of additions) selected.add(key);
  }
  if (selected.size === 0) {
    throw new RecallSchemaBudgetError(
      `no complete predicate dependency group fits recall schema limit ${predicateLimit}`
    );
  }

  const selectedPredicates = ranked
    .map((group) => group.key)
    .filter((key) => selected.has(key));
  const lines: string[] = [
    `% selected predicates (${selectedPredicates.length} of ${groups.size}; ranked locally for this question)`,
    ...selectedPredicates,
  ];
  const bytes = () => Buffer.byteLength(lines.join('\n'), 'utf8');
  if (bytes() > byteLimit) {
    throw new RecallSchemaBudgetError(
      `selected predicate names exceed recall schema byte limit ${byteLimit}`
    );
  }
  const appendLine = (line: string): boolean => {
    lines.push(line);
    if (bytes() <= byteLimit) return true;
    lines.pop();
    return false;
  };

  let omittedRules = 0;
  const selectedRules = selectedPredicates.flatMap((key) =>
    [...(groups.get(key)?.rules ?? [])].sort((left, right) =>
      compareText(serializeClause(left), serializeClause(right))
    )
  );
  const rulesSectionFits =
    selectedRules.length === 0 || appendLine('% selected rules');
  if (!rulesSectionFits) {
    omittedRules = selectedRules.length;
  } else {
    for (const rule of selectedRules) {
      if (!appendLine(serializePromptClause(rule))) omittedRules += 1;
    }
  }
  if (omittedRules > 0) {
    const notice = `% ${omittedRules} selected rule(s) omitted by byte limit; derived predicates remain queryable`;
    appendLine(notice);
  }

  const samples: string[] = [];
  for (const key of selectedPredicates) {
    const facts = [...(groups.get(key)?.facts ?? [])]
      .sort((left, right) => {
        const relevance =
          factMatchScore(right, questionWords) - factMatchScore(left, questionWords);
        return relevance || compareText(serializeClause(left), serializeClause(right));
      })
      .slice(0, 3);
    for (const fact of facts) samples.push(`% e.g. ${serializePromptClause(fact)}`);
  }
  const samplesSectionFits =
    samples.length === 0 || appendLine('% selected sample facts (syntax evidence only)');
  if (samplesSectionFits) {
    for (const sample of samples) appendLine(sample);
  }

  const availablePredicates = new Set(selectedPredicates);
  const catalogCandidates = ranked
    .map((group) => group.key)
    .filter((key) => !availablePredicates.has(key));
  const catalogSectionFits =
    catalogCandidates.length === 0 ||
    appendLine('% additional predicate catalog (name/arity only)');
  if (catalogSectionFits) {
    for (const key of catalogCandidates) {
      if (!appendLine(key)) break;
      availablePredicates.add(key);
    }
  }
  const catalogComplete = availablePredicates.size === groups.size;
  if (!catalogComplete) {
    const notice = `% catalog bounded: ${availablePredicates.size} of ${groups.size} predicates shown`;
    appendLine(notice);
  }

  const summary = lines.join('\n');
  const summaryBytes = Buffer.byteLength(summary, 'utf8');
  if (summaryBytes > byteLimit) {
    throw new RecallSchemaBudgetError(
      `recall schema summary exceeds byte limit ${byteLimit}`
    );
  }
  return {
    summary,
    availablePredicates,
    totalPredicates: groups.size,
    selectedPredicates,
    advertisedPredicates: availablePredicates.size,
    catalogComplete,
    schemaComplete: selectedPredicates.length === groups.size && omittedRules === 0,
    summaryBytes,
    omittedRules,
    pruned: selectedPredicates.length < groups.size,
  };
}
