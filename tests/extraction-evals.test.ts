import { describe, expect, it } from 'vitest';
import { parseProgram, serializeClause } from '../src/engine/index.js';
import {
  EXTRACTION_EVAL_CASES,
  EXTRACTION_EVAL_DISTRACTOR_COUNT,
  extractionObservationIsCorrect,
  scoreExtractionEval,
  type ExtractionEvalObservation,
} from '../src/evals/extraction.js';

function caseById(id: string) {
  const testCase = EXTRACTION_EVAL_CASES.find((candidate) => candidate.id === id);
  if (testCase === undefined) throw new Error(`missing extraction eval case ${id}`);
  return testCase;
}

function observation(
  id: string,
  overrides: Partial<ExtractionEvalObservation> = {}
): ExtractionEvalObservation {
  const testCase = caseById(id);
  return {
    case: testCase,
    model: 'test-model',
    outcome: testCase.expectedOutcome,
    actualClauses: parseProgram(testCase.expectedFinalProgram).map(serializeClause),
    added: parseProgram(testCase.expectedAddedProgram).map(serializeClause),
    duplicates: testCase.expectedDuplicates,
    retracted: testCase.expectedRetractions,
    llmCalls: testCase.expectedLlmCalls ?? 1,
    durationMs: 10,
    ...overrides,
  };
}

describe('extraction eval corpus', () => {
  it('contains unique valid cases across mutation and safety boundaries', () => {
    expect(new Set(EXTRACTION_EVAL_CASES.map((testCase) => testCase.id)).size).toBe(
      EXTRACTION_EVAL_CASES.length
    );
    expect(EXTRACTION_EVAL_DISTRACTOR_COUNT).toBeGreaterThanOrEqual(100);
    for (const testCase of EXTRACTION_EVAL_CASES) {
      expect(testCase.input.trim()).not.toBe('');
      expect(testCase.tags.length).toBeGreaterThan(0);
      expect(() => parseProgram(testCase.initialProgram)).not.toThrow();
      expect(() => parseProgram(testCase.expectedFinalProgram)).not.toThrow();
      expect(() => parseProgram(testCase.expectedAddedProgram)).not.toThrow();
      if (testCase.expectedOutcome === 'rejected') {
        expect(testCase.expectedErrorPattern).toBeTruthy();
      }
    }
    expect(EXTRACTION_EVAL_CASES.some((testCase) => testCase.tags.includes('rule'))).toBe(true);
    expect(EXTRACTION_EVAL_CASES.some((testCase) => testCase.tags.includes('retraction'))).toBe(true);
    expect(EXTRACTION_EVAL_CASES.some((testCase) => testCase.tags.includes('safety'))).toBe(true);
  });

  it('accepts alpha-equivalent extracted rules', () => {
    const result = observation('derived_colleague_rule', {
      actualClauses: [
        'works_at(rahul, acme).',
        'works_at(mira, acme).',
        'colleague(Person, Peer) :- works_at(Person, Company), works_at(Peer, Company), Person != Peer.',
      ],
      added: [
        'colleague(Person, Peer) :- works_at(Person, Company), works_at(Peer, Company), Person != Peer.',
      ],
    });

    expect(extractionObservationIsCorrect(result)).toBe(true);
  });

  it('requires exact final state, operation counts, and local safety calls', () => {
    expect(extractionObservationIsCorrect(observation('replace_current_fact'))).toBe(true);
    expect(
      extractionObservationIsCorrect(
        observation('replace_current_fact', { retracted: 0 })
      )
    ).toBe(false);
    expect(extractionObservationIsCorrect(observation('secret_rejected_locally'))).toBe(true);
    expect(
      extractionObservationIsCorrect(
        observation('secret_rejected_locally', { llmCalls: 1 })
      )
    ).toBe(false);
  });
});

describe('extraction eval metrics', () => {
  it('scores signed additions and removals without inflating from initial state', () => {
    const exact = observation('replace_current_fact');
    const wrong = observation('two_personal_facts', {
      actualClauses: ['works_at(rahul, acme).', 'lives_in(rahul, sydney).'],
      added: ['works_at(rahul, acme).', 'lives_in(rahul, sydney).'],
    });
    const safety = observation('secret_rejected_locally');

    expect(scoreExtractionEval([exact, wrong, safety])).toMatchObject({
      cases: 3,
      accuracy: 2 / 3,
      mutationPrecision: 3 / 4,
      mutationRecall: 3 / 4,
      mutationF1: 3 / 4,
      truePositives: 3,
      falsePositives: 1,
      falseNegatives: 1,
      safetyAccuracy: 1,
      safetyCases: 1,
      unexpectedErrors: 0,
      durationMs: 30,
    });
  });
});
