import { describe, expect, it } from 'vitest';
import { parseProgram } from '../src/engine/index.js';
import { buildSchemaSummary } from '../src/llm/prompts.js';
import {
  RECALL_EVAL_CASES,
  RECALL_EVAL_DISTRACTOR_COUNT,
  RECALL_EVAL_PROGRAM,
  bindingRows,
  observationIsCorrect,
  scoreRecallEval,
  type RecallEvalCase,
  type RecallEvalObservation,
} from '../src/evals/recall.js';
import { selectRecallSchema } from '../src/llm/schema.js';

function testCase(
  id: string,
  expectedRows: string[][],
  expectedQuery: RecallEvalCase['expectedQuery'] = 'required'
): RecallEvalCase {
  return { id, question: id, expectedRows, expectedQuery, tags: [] };
}

function observation(
  test: RecallEvalCase,
  query: string | null,
  actualRows: string[][]
): RecallEvalObservation {
  return {
    case: test,
    model: 'test-model',
    variant: 'baseline',
    status:
      query === null ? 'unanswerable' : actualRows.length === 0 ? 'no_match' : 'answered',
    query,
    actualRows,
    durationMs: 10,
  };
}

describe('recall eval corpus', () => {
  it('is valid Datalog with unique, well-formed cases', () => {
    expect(parseProgram(RECALL_EVAL_PROGRAM).length).toBeGreaterThan(0);
    expect(new Set(RECALL_EVAL_CASES.map((test) => test.id)).size).toBe(
      RECALL_EVAL_CASES.length
    );
    for (const test of RECALL_EVAL_CASES) {
      expect(test.question.trim()).not.toBe('');
      expect(test.tags.length).toBeGreaterThan(0);
      if (test.expectedQuery === 'unanswerable') expect(test.expectedRows).toEqual([]);
    }
    const summary = buildSchemaSummary(parseProgram(RECALL_EVAL_PROGRAM));
    const selection = selectRecallSchema(
      parseProgram(RECALL_EVAL_PROGRAM),
      'Where does Rahul work?'
    );
    expect(RECALL_EVAL_DISTRACTOR_COUNT).toBeGreaterThanOrEqual(100);
    expect(
      RECALL_EVAL_CASES.filter((test) =>
        test.tags.includes('confusable-nonempty')
      )
    ).toHaveLength(4);
    expect(selection.pruned).toBe(true);
    expect(selection.selectedPredicates).toContain('works_at/2');
    for (const heldOut of [
      'works_at(rahul, acme).',
      'lives_in(dr_chen, \'New York\').',
      'dentist(rahul, dr_chen).',
      'uses_language(atlas, rust).',
      'project_owner(atlas, rahul).',
      'birth_year(chen, 1978).',
      'birth_year(mira, 1994).',
      'parent(alice, bob).',
    ]) {
      expect(summary).not.toContain(heldOut);
    }
  });

  it('normalizes binding rows independently of variable names and order', () => {
    expect(
      bindingRows(
        [{ City: "'New York'", Dentist: 'dr_chen' }],
        'dentist(rahul, Dentist), lives_in(Dentist, City)'
      )
    ).toEqual([['dr_chen', "'New York'"]]);
    expect(bindingRows([{ Who: 'mira' }], 'colleague(rahul, Who)')).toEqual([['mira']]);
    expect(
      bindingRows(
        [{ Count: '3' }],
        'count(*) as Count where colleague(rahul, Person)'
      )
    ).toEqual([['3']]);
    expect(
      bindingRows(
        [{ Person: 'alice', Score: '20', Base: '10' }],
        'score(Person, Score), baseline(team, Base), Score > Base + 5'
      )
    ).toEqual([['alice', '20', '10']]);
  });
});

describe('recall eval metrics', () => {
  it('separates row precision/recall from exact-case and answerability accuracy', () => {
    const partial = observation(
      testCase('partial', [['a'], ['b']]),
      'value(X)',
      [['a'], ['c']]
    );
    const unanswerable = observation(
      testCase('unanswerable', [], 'unanswerable'),
      null,
      []
    );
    const emptyButExpressible = observation(testCase('empty', []), 'value(missing)', []);

    expect(observationIsCorrect(partial)).toBe(false);
    expect(observationIsCorrect(unanswerable)).toBe(true);
    expect(observationIsCorrect(emptyButExpressible)).toBe(true);

    expect(scoreRecallEval([partial, unanswerable, emptyButExpressible])).toMatchObject({
      cases: 3,
      accuracy: 2 / 3,
      answerabilityAccuracy: 1,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 1,
      errors: 0,
      durationMs: 30,
    });
  });

  it('counts errors as inaccurate even when their empty output resembles the label', () => {
    const failed = {
      ...observation(testCase('failed', [], 'unanswerable'), null, []),
      error: 'model unavailable',
    };
    expect(observationIsCorrect(failed)).toBe(false);
    expect(scoreRecallEval([failed])).toMatchObject({
      accuracy: 0,
      answerabilityAccuracy: 0,
      errors: 1,
    });
  });

  it('counts schema budget exhaustion as an explicit failed outcome', () => {
    const exhausted = {
      ...observation(testCase('exhausted', [], 'unanswerable'), null, []),
      status: 'schema_budget_exhausted' as const,
    };
    expect(observationIsCorrect(exhausted)).toBe(false);
    expect(scoreRecallEval([exhausted])).toMatchObject({
      accuracy: 0,
      answerabilityAccuracy: 0,
      schemaBudgetExhaustions: 1,
      errors: 0,
    });
  });
});
