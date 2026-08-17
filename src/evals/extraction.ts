import { canonicalKey, parseProgram, serializeClause } from '../engine/index.js';

export const EXTRACTION_EVAL_DISTRACTOR_COUNT = 100;
const EXTRACTION_EVAL_DISTRACTORS = Array.from(
  { length: EXTRACTION_EVAL_DISTRACTOR_COUNT },
  (_, index) =>
    `extract_noise_${String(index).padStart(3, '0')}(subject_${index}, value_${index}).`
).join('\n');

export type ExtractionEvalExpectedOutcome = 'completed' | 'rejected';
export type ExtractionEvalActualOutcome = ExtractionEvalExpectedOutcome | 'error';

export interface ExtractionEvalCase {
  id: string;
  input: string;
  initialProgram: string;
  expectedFinalProgram: string;
  expectedAddedProgram: string;
  expectedOutcome: ExtractionEvalExpectedOutcome;
  expectedDuplicates: number;
  expectedRetractions: number;
  expectedErrorPattern?: string;
  expectedLlmCalls?: number;
  trust?: 'accepted' | 'tentative';
  tags: string[];
}

function completedCase(
  value: Omit<
    ExtractionEvalCase,
    | 'expectedOutcome'
    | 'expectedDuplicates'
    | 'expectedRetractions'
    | 'initialProgram'
    | 'expectedAddedProgram'
  > &
    Partial<
      Pick<
        ExtractionEvalCase,
        | 'expectedDuplicates'
        | 'expectedRetractions'
        | 'initialProgram'
        | 'expectedAddedProgram'
      >
    >
): ExtractionEvalCase {
  return {
    initialProgram: '',
    expectedAddedProgram: value.expectedFinalProgram,
    expectedDuplicates: 0,
    expectedRetractions: 0,
    ...value,
    expectedOutcome: 'completed',
  };
}

export const EXTRACTION_EVAL_CASES: ExtractionEvalCase[] = [
  completedCase({
    id: 'two_personal_facts',
    input: 'Rahul works at Acme and lives in Melbourne.',
    expectedFinalProgram: 'works_at(rahul, acme). lives_in(rahul, melbourne).',
    tags: ['facts', 'multi-clause', 'personal'],
  }),
  completedCase({
    id: 'quoted_city',
    input: 'Dr Chen lives in New York.',
    expectedFinalProgram: "lives_in(dr_chen, 'New York').",
    tags: ['fact', 'quoted-atom'],
  }),
  completedCase({
    id: 'numeric_fact',
    input: 'Rahul was born in 1985.',
    expectedFinalProgram: 'birth_year(rahul, 1985).',
    tags: ['fact', 'number'],
  }),
  completedCase({
    id: 'preference',
    input: "Rahul's favorite color is blue.",
    expectedFinalProgram: 'favorite_color(rahul, blue).',
    tags: ['fact', 'preference', 'personal'],
  }),
  completedCase({
    id: 'reuse_predicate_at_scale',
    input: 'Mira works at Initech.',
    initialProgram: `${EXTRACTION_EVAL_DISTRACTORS}\nworks_at(rahul, acme).`,
    expectedFinalProgram: `${EXTRACTION_EVAL_DISTRACTORS}\nworks_at(rahul, acme).\nworks_at(mira, initech).`,
    expectedAddedProgram: 'works_at(mira, initech).',
    tags: ['fact', 'schema-reuse', 'scaled'],
  }),
  completedCase({
    id: 'duplicate_fact',
    input: 'Rahul works at Acme.',
    initialProgram: 'works_at(rahul, acme).',
    expectedFinalProgram: 'works_at(rahul, acme).',
    expectedAddedProgram: '',
    expectedDuplicates: 1,
    tags: ['fact', 'duplicate', 'idempotent'],
  }),
  completedCase({
    id: 'replace_current_fact',
    input: 'Mira now works at Initech.',
    initialProgram: 'works_at(mira, acme).',
    expectedFinalProgram: 'works_at(mira, initech).',
    expectedAddedProgram: 'works_at(mira, initech).',
    expectedRetractions: 1,
    tags: ['correction', 'retraction', 'personal'],
  }),
  completedCase({
    id: 'remove_fact',
    input: 'Rahul no longer has a premium subscription.',
    initialProgram: 'subscription(rahul, premium).',
    expectedFinalProgram: '',
    expectedAddedProgram: '',
    expectedRetractions: 1,
    tags: ['retraction', 'removal'],
  }),
  completedCase({
    id: 'derived_colleague_rule',
    input:
      'People who work at the same company are colleagues, but nobody is their own colleague.',
    initialProgram: 'works_at(rahul, acme). works_at(mira, acme).',
    expectedFinalProgram:
      'works_at(rahul, acme). works_at(mira, acme). colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.',
    expectedAddedProgram:
      'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.',
    tags: ['rule', 'join', 'inequality'],
  }),
  completedCase({
    id: 'closed_world_rule',
    input: 'Every employee who is not suspended is eligible.',
    initialProgram: 'employee(alice). suspended(bob).',
    expectedFinalProgram:
      'employee(alice). suspended(bob). eligible(X) :- employee(X), \\+ suspended(X).',
    expectedAddedProgram: 'eligible(X) :- employee(X), \\+ suspended(X).',
    tags: ['rule', 'negation'],
  }),
  completedCase({
    id: 'tentative_caller_authority',
    input: 'Atlas may be a project.',
    initialProgram: 'project(beacon).',
    expectedFinalProgram:
      "project(beacon). rembero_tentative('project(atlas).').",
    expectedAddedProgram: 'project(atlas).',
    trust: 'tentative',
    tags: ['fact', 'tentative', 'authority'],
  }),
  completedCase({
    id: 'non_fact_noop',
    input: 'Thanks for the help!',
    expectedFinalProgram: '',
    expectedAddedProgram: '',
    tags: ['noop', 'non-factual'],
  }),
  completedCase({
    id: 'policy_request_noop',
    input: 'Make sure active users are never suspended.',
    expectedFinalProgram: '',
    expectedAddedProgram: '',
    tags: ['noop', 'policy-boundary'],
  }),
  completedCase({
    id: 'identity_request_noop',
    input: 'Mira Patel and Mira are the same person.',
    expectedFinalProgram: '',
    expectedAddedProgram: '',
    tags: ['noop', 'identity-boundary'],
  }),
  {
    id: 'secret_rejected_locally',
    input: 'Rahul’s GitHub token is ghp_supersecretvalue.',
    initialProgram: '',
    expectedFinalProgram: '',
    expectedAddedProgram: '',
    expectedOutcome: 'rejected',
    expectedDuplicates: 0,
    expectedRetractions: 0,
    expectedErrorPattern: 'sensitive memory text',
    expectedLlmCalls: 0,
    tags: ['safety', 'secret', 'local-only'],
  },
];

export interface ExtractionEvalObservation {
  case: ExtractionEvalCase;
  model: string;
  outcome: ExtractionEvalActualOutcome;
  actualClauses: string[];
  added: string[];
  duplicates: number;
  retracted: number;
  llmCalls: number;
  durationMs: number;
  error?: string;
}

export interface ExtractionEvalScore {
  cases: number;
  accuracy: number;
  mutationPrecision: number;
  mutationRecall: number;
  mutationF1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  safetyAccuracy: number;
  safetyCases: number;
  unexpectedErrors: number;
  durationMs: number;
}

function canonicalProgram(program: string): Set<string> {
  return new Set(parseProgram(program).map(canonicalKey));
}

function canonicalClauses(clauses: readonly string[]): Set<string> {
  return canonicalProgram(clauses.join('\n'));
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function mutationSet(initialProgram: string, finalClauses: readonly string[]): Set<string> {
  const initial = canonicalProgram(initialProgram);
  const final = canonicalClauses(finalClauses);
  const mutations = new Set<string>();
  for (const clause of final) if (!initial.has(clause)) mutations.add(`+${clause}`);
  for (const clause of initial) if (!final.has(clause)) mutations.add(`-${clause}`);
  return mutations;
}

function expectedMutationSet(testCase: ExtractionEvalCase): Set<string> {
  return mutationSet(
    testCase.initialProgram,
    parseProgram(testCase.expectedFinalProgram).map(serializeClause)
  );
}

export function extractionObservationIsCorrect(
  observation: ExtractionEvalObservation
): boolean {
  const testCase = observation.case;
  if (observation.outcome !== testCase.expectedOutcome) return false;
  if (
    !sameSet(
      canonicalClauses(observation.actualClauses),
      canonicalProgram(testCase.expectedFinalProgram)
    )
  ) {
    return false;
  }
  if (
    testCase.expectedLlmCalls !== undefined &&
    observation.llmCalls !== testCase.expectedLlmCalls
  ) {
    return false;
  }
  if (testCase.expectedOutcome === 'rejected') return true;
  return (
    sameSet(
      canonicalClauses(observation.added),
      canonicalProgram(testCase.expectedAddedProgram)
    ) &&
    observation.duplicates === testCase.expectedDuplicates &&
    observation.retracted === testCase.expectedRetractions &&
    observation.error === undefined
  );
}

export function scoreExtractionEval(
  observations: readonly ExtractionEvalObservation[]
): ExtractionEvalScore {
  let exact = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let safetyCorrect = 0;
  let safetyCases = 0;

  for (const observation of observations) {
    if (extractionObservationIsCorrect(observation)) exact++;
    const expected = expectedMutationSet(observation.case);
    const actual = mutationSet(
      observation.case.initialProgram,
      observation.actualClauses
    );
    for (const mutation of actual) {
      if (expected.has(mutation)) truePositives++;
      else falsePositives++;
    }
    for (const mutation of expected) {
      if (!actual.has(mutation)) falseNegatives++;
    }
    if (observation.case.tags.includes('safety')) {
      safetyCases++;
      if (extractionObservationIsCorrect(observation)) safetyCorrect++;
    }
  }

  const mutationPrecision =
    truePositives + falsePositives === 0
      ? 1
      : truePositives / (truePositives + falsePositives);
  const mutationRecall =
    truePositives + falseNegatives === 0
      ? 1
      : truePositives / (truePositives + falseNegatives);
  const mutationF1 =
    mutationPrecision + mutationRecall === 0
      ? 0
      : (2 * mutationPrecision * mutationRecall) /
        (mutationPrecision + mutationRecall);
  const cases = observations.length;
  return {
    cases,
    accuracy: cases === 0 ? 0 : exact / cases,
    mutationPrecision,
    mutationRecall,
    mutationF1,
    truePositives,
    falsePositives,
    falseNegatives,
    safetyAccuracy: safetyCases === 0 ? 1 : safetyCorrect / safetyCases,
    safetyCases,
    unexpectedErrors: observations.filter(
      (observation) => observation.outcome === 'error'
    ).length,
    durationMs: observations.reduce(
      (total, observation) => total + observation.durationMs,
      0
    ),
  };
}
