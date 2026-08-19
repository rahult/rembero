import { describe, expect, it } from 'vitest';
import {
  LONGMEMEVAL_S_SHA256,
  scoreLongMemEvalInstances,
  type LongMemEvalInstance,
} from '../src/evals/longmemeval.js';

function instance(overrides: Partial<LongMemEvalInstance> = {}): LongMemEvalInstance {
  return {
    question_id: 'q1',
    question_type: 'single-session-user',
    question: 'Where does Maya work?',
    answer: 'Acme',
    question_date: '2026/01/02',
    haystack_session_ids: ['noise', 'evidence'],
    haystack_dates: ['2026/01/01', '2026/01/01'],
    haystack_sessions: [
      [{ role: 'user', content: 'Liam likes tea.' }],
      [{ role: 'user', content: 'Maya works at Acme.' }],
    ],
    answer_session_ids: ['evidence'],
    ...overrides,
  };
}

describe('LongMemEval retrieval benchmark', () => {
  it('scores exact source retrieval and abstention without model calls', () => {
    const run = scoreLongMemEvalInstances([
      instance(),
      instance({
        question_id: 'q2_abs',
        question_type: 'abstention',
        question: 'What gift does Zoe want?',
        answer: 'unknown',
        answer_session_ids: [],
      }),
    ], { topK: 1, generatedAt: '2026-08-20T00:00:00.000Z' });
    expect(run.dataset.sha256).toBe(LONGMEMEVAL_S_SHA256);
    expect(run.adapter).toMatchObject({ modelCalls: 0, embeddingCalls: 0, remoteCalls: 0 });
    expect(run.adapter.sourceCharacterLimit).toBe(16_384);
    expect(run.summary).toMatchObject({
      questions: 2,
      answerableQuestions: 1,
      abstentionQuestions: 1,
      precisionAtK: 1,
      recallAtK: 1,
      meanReciprocalRank: 1,
      strictEvidenceCoverageRate: 1,
      abstentionEmptyRate: 1,
    });
  });

  it('rejects duplicate questions and unknown evidence sessions', () => {
    expect(() => scoreLongMemEvalInstances([instance(), instance()])).toThrow(/duplicate/);
    expect(() => scoreLongMemEvalInstances([
      instance({ answer_session_ids: ['missing'] }),
    ])).toThrow(/unknown evidence/);
  });
});
