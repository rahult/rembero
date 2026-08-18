import { describe, expect, it } from 'vitest';
import {
  createDirectFactAdapter,
  createExternalCommandAdapter,
  createLexicalAdapter,
  createRemberoMemoryAdapter,
} from '../src/evals/memory-stack-adapters.js';
import {
  benchmarkDigest,
  canonicalJson,
  publicCase,
  type MemoryStackAdapterDescriptor,
} from '../src/evals/memory-stack-contract.js';
import {
  MEMORY_STACK_CASES,
  MEMORY_STACK_LABELS,
  MEMORY_STACK_SUITE,
} from '../src/evals/memory-stack-fixtures.js';
import { runMemoryStackBenchmark } from '../src/evals/memory-stack-score.js';

describe('memory-stack benchmark contract', () => {
  it('keeps fixture and label IDs unique and complete', () => {
    expect(new Set(MEMORY_STACK_CASES.map(({ id }) => id)).size).toBe(
      MEMORY_STACK_CASES.length
    );
    const questions = MEMORY_STACK_CASES.flatMap((testCase) =>
      testCase.questions.map((question) => `${testCase.id}/${question.id}`)
    );
    const labels = MEMORY_STACK_LABELS.map(
      (label) => `${label.caseId}/${label.questionId}`
    );
    expect(new Set(questions).size).toBe(questions.length);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(labels)).toEqual(new Set(questions));
    for (const testCase of MEMORY_STACK_CASES) {
      expect(new Set(testCase.events.map(({ id }) => id)).size).toBe(
        testCase.events.length
      );
    }
  });

  it('canonicalizes object keys without reordering arrays or typed cells', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(benchmarkDigest({ rows: [['a', 'b']] })).not.toBe(
      benchmarkDigest({ rows: [['b', 'a']] })
    );
    expect(() => canonicalJson({ invalid: Number.NaN })).toThrow(/finite/);
  });

  it('never includes private labels in an adapter request', () => {
    const serialized = JSON.stringify(
      publicCase({
        ...MEMORY_STACK_CASES[0],
        expectedRows: [['private-label']],
      } as never)
    );
    expect(serialized).not.toContain('expectedRows');
    expect(serialized).not.toContain('relevantEventIds');
    expect(serialized).not.toContain('expectedStatus');
  });
});

describe('memory-stack benchmark adapters and scoring', () => {
  it('gates the Remembero engine on exact answers and proof citations', async () => {
    const first = await runMemoryStackBenchmark({
      suite: MEMORY_STACK_SUITE,
      cases: MEMORY_STACK_CASES,
      labels: MEMORY_STACK_LABELS,
      adapter: createRemberoMemoryAdapter(),
      generatedAt: '2026-08-18T00:00:00.000Z',
    });
    const second = await runMemoryStackBenchmark({
      suite: MEMORY_STACK_SUITE,
      cases: MEMORY_STACK_CASES,
      labels: MEMORY_STACK_LABELS,
      adapter: createRemberoMemoryAdapter(),
      generatedAt: '2026-08-19T00:00:00.000Z',
    });
    const third = await runMemoryStackBenchmark({
      suite: MEMORY_STACK_SUITE,
      cases: MEMORY_STACK_CASES,
      labels: MEMORY_STACK_LABELS,
      adapter: createRemberoMemoryAdapter(),
      generatedAt: '2026-08-20T00:00:00.000Z',
    });
    expect(first.summary).toMatchObject({
      operationalErrors: 0,
      answerCoverage: 1,
      answerAccuracy: 1,
      answerabilityAccuracy: 1,
      citationRecall: 1,
      staleLeakageRate: 0,
    });
    expect(first.semanticDigest).toBe(second.semanticDigest);
    expect(first.semanticDigest).toBe(third.semanticDigest);
  });

  it('reports incomplete baselines without inflating unsupported answer scores', async () => {
    const direct = await runMemoryStackBenchmark({
      suite: MEMORY_STACK_SUITE,
      cases: MEMORY_STACK_CASES,
      labels: MEMORY_STACK_LABELS,
      adapter: createDirectFactAdapter(),
    });
    const lexical = await runMemoryStackBenchmark({
      suite: MEMORY_STACK_SUITE,
      cases: MEMORY_STACK_CASES,
      labels: MEMORY_STACK_LABELS,
      adapter: createLexicalAdapter(),
    });
    expect(direct.summary.answerCoverage).toBe(1);
    expect(direct.summary.answerAccuracy).toBeLessThan(1);
    expect(lexical.summary.answerCoverage).toBe(0);
    expect(lexical.summary.answerAccuracy).toBeNull();
    expect(lexical.summary.retrievalCoverage).toBeGreaterThan(0);
  });

  it('rejects omitted, duplicate, and unknown observation identifiers', async () => {
    const testCase = MEMORY_STACK_CASES[0];
    const descriptor = createLexicalAdapter().describe();
    const run = (questions: never[]) =>
      runMemoryStackBenchmark({
        suite: MEMORY_STACK_SUITE,
        cases: [testCase],
        labels: MEMORY_STACK_LABELS.filter(({ caseId }) => caseId === testCase.id),
        adapter: {
          describe: () => descriptor,
          async runCase() {
            return { caseId: testCase.id, questions };
          },
        },
      });
    await expect(run([])).rejects.toThrow(/incomplete or duplicate/);
    const valid = await createLexicalAdapter().runCase(testCase);
    const duplicated = [valid.questions[0], valid.questions[0]] as never[];
    await expect(run(duplicated)).rejects.toThrow(/incomplete or duplicate/);
    const unknown = [
      {
        ...valid.questions[0],
        retrieved: [{ eventId: 'not-a-fixture-event', rank: 1 }],
      },
    ] as never[];
    await expect(run(unknown)).rejects.toThrow(/unknown event/);
  });

  it('preserves cell order and atom/number identity in answer scoring', async () => {
    const testCase = {
      id: 'typed-order',
      tags: ['contract'],
      events: [],
      questions: [
        {
          id: 'q',
          text: 'q',
          query: 'pair(X, Y)',
          answerColumns: ['X', 'Y'],
        },
      ],
    };
    const descriptor: MemoryStackAdapterDescriptor = {
      id: 'bad-order',
      version: '1',
      capabilities: {
        answerRows: true,
        rankedRetrieval: false,
        citations: false,
        rules: false,
        temporalUpdates: false,
        trustViews: false,
      },
    };
    const run = await runMemoryStackBenchmark({
      suite: { id: 'typed', version: '1' },
      cases: [testCase],
      labels: [
        {
          caseId: 'typed-order',
          questionId: 'q',
          expectedStatus: 'answered',
          expectedRows: [
            [
              { type: 'atom', value: 'alice' },
              { type: 'number', value: 1 },
            ],
          ],
          relevantEventIds: [],
        },
      ],
      adapter: {
        describe: () => descriptor,
        async runCase() {
          return {
            caseId: 'typed-order',
            questions: [
              {
                questionId: 'q',
                status: 'answered',
                answerRows: [
                  [
                    { type: 'number', value: 1 },
                    { type: 'atom', value: 'alice' },
                  ],
                ],
                retrieved: [],
                citations: [],
                wallMs: 0,
              },
            ],
          };
        },
      },
    });
    expect(run.summary.answerAccuracy).toBe(0);
    expect(run.summary.answerPrecision).toBe(0);
    expect(run.summary.answerRecall).toBe(0);
  });
});

describe('external memory-stack adapter', () => {
  const descriptor: MemoryStackAdapterDescriptor = {
    id: 'external-test',
    version: '1',
    capabilities: {
      answerRows: false,
      rankedRetrieval: false,
      citations: false,
      rules: false,
      temporalUpdates: false,
      trustViews: false,
    },
  };

  it('uses an isolated JSON stdin/stdout process without a shell', async () => {
    const script = `
      let input = '';
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        const request = JSON.parse(input);
        process.stdout.write(JSON.stringify({
          caseId: request.case.id,
          questions: request.case.questions.map(q => ({
            questionId: q.id, status: 'unsupported', answerRows: [],
            retrieved: [], citations: [], wallMs: 0
          }))
        }));
      });
    `;
    const adapter = createExternalCommandAdapter(descriptor, {
      executable: process.execPath,
      args: ['-e', script],
      timeoutMs: 2_000,
    });
    await expect(adapter.runCase(MEMORY_STACK_CASES[0])).resolves.toMatchObject({
      caseId: MEMORY_STACK_CASES[0].id,
    });
  });

  it('rejects malformed and oversized adapter output', async () => {
    const malformed = createExternalCommandAdapter(descriptor, {
      executable: process.execPath,
      args: ['-e', "process.stdout.write('not-json')"],
    });
    await expect(malformed.runCase(MEMORY_STACK_CASES[0])).rejects.toThrow();

    const oversized = createExternalCommandAdapter(descriptor, {
      executable: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(100))"],
      maxOutputBytes: 10,
    });
    await expect(oversized.runCase(MEMORY_STACK_CASES[0])).rejects.toThrow(/exceeded/);
  });

  it('suppresses adapter stderr content from thrown errors', async () => {
    const secret = 'do-not-copy-this-secret';
    const failed = createExternalCommandAdapter(descriptor, {
      executable: process.execPath,
      args: [
        '-e',
        `process.stderr.write('${secret}'.repeat(10000)); process.exit(2)`,
      ],
    });
    try {
      await failed.runCase(MEMORY_STACK_CASES[0]);
      throw new Error('expected adapter failure');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('stderr suppressed');
      expect(message).not.toContain(secret);
    }
  });
});
