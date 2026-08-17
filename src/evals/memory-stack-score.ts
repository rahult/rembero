import {
  benchmarkDigest,
  type MemoryRow,
  type MemoryStackAdapter,
  type MemoryStackCase,
  type MemoryStackLabel,
  type MemoryStackQuestionObservation,
  type MemoryStackQuestionScore,
  type MemoryStackRun,
  type MemoryStackSummary,
} from './memory-stack-contract.js';
import { MEMORY_STACK_PROTOCOL_VERSION } from './memory-stack-contract.js';

function validateObservation(
  testCase: MemoryStackCase,
  observation: Awaited<ReturnType<MemoryStackAdapter['runCase']>>
): void {
  if (observation.caseId !== testCase.id) {
    throw new Error(`adapter returned case ${observation.caseId} for ${testCase.id}`);
  }
  const expectedQuestions = new Set(testCase.questions.map(({ id }) => id));
  const observedQuestions = new Set(
    observation.questions.map(({ questionId }) => questionId)
  );
  if (
    observedQuestions.size !== observation.questions.length ||
    observedQuestions.size !== expectedQuestions.size ||
    [...expectedQuestions].some((id) => !observedQuestions.has(id))
  ) {
    throw new Error(`adapter returned an incomplete or duplicate question set for ${testCase.id}`);
  }
  const eventIds = new Set(testCase.events.map(({ id }) => id));
  for (const question of observation.questions) {
    if (!['answered', 'no_match', 'unsupported', 'error'].includes(question.status)) {
      throw new Error(`adapter returned an invalid status for ${question.questionId}`);
    }
    if (!Number.isFinite(question.wallMs) || question.wallMs < 0) {
      throw new Error(`adapter returned an invalid wallMs for ${question.questionId}`);
    }
    for (const row of question.answerRows) {
      for (const cell of row) {
        if (
          (cell.type === 'atom' && typeof cell.value === 'string') ||
          (cell.type === 'number' &&
            typeof cell.value === 'number' &&
            Number.isFinite(cell.value))
        ) {
          continue;
        }
        throw new Error(`adapter returned an invalid answer cell for ${question.questionId}`);
      }
    }
    const ranks = new Set<number>();
    const retrievedIds = new Set<string>();
    for (const item of question.retrieved) {
      if (!eventIds.has(item.eventId)) {
        throw new Error(`adapter returned unknown event ${item.eventId}`);
      }
      if (!Number.isSafeInteger(item.rank) || item.rank < 1 || ranks.has(item.rank)) {
        throw new Error(`adapter returned invalid or duplicate rank for ${question.questionId}`);
      }
      if (retrievedIds.has(item.eventId)) {
        throw new Error(`adapter returned duplicate event ${item.eventId}`);
      }
      ranks.add(item.rank);
      retrievedIds.add(item.eventId);
    }
    if (new Set(question.citations).size !== question.citations.length) {
      throw new Error(`adapter returned duplicate citations for ${question.questionId}`);
    }
    for (const eventId of question.citations) {
      if (!eventIds.has(eventId)) throw new Error(`adapter cited unknown event ${eventId}`);
    }
  }
}

function rowKey(row: MemoryRow): string {
  return JSON.stringify(row);
}

function uniqueRows(rows: readonly MemoryRow[]): Set<string> {
  return new Set(rows.map(rowKey));
}

function setMetrics(
  expectedValues: readonly string[],
  actualValues: readonly string[]
): { precision: number; recall: number } {
  const expected = new Set(expectedValues);
  const actual = new Set(actualValues);
  const truePositives = [...actual].filter((value) => expected.has(value)).length;
  return {
    precision: actual.size === 0 ? (expected.size === 0 ? 1 : 0) : truePositives / actual.size,
    recall: expected.size === 0 ? 1 : truePositives / expected.size,
  };
}

function questionScore(
  label: MemoryStackLabel,
  observation: MemoryStackQuestionObservation,
  capabilities: ReturnType<MemoryStackAdapter['describe']>['capabilities']
): MemoryStackQuestionScore {
  const expectedRows = uniqueRows(label.expectedRows);
  const actualRows = uniqueRows(observation.answerRows);
  const answer = setMetrics([...expectedRows], [...actualRows]);
  const retrieved = observation.retrieved
    .slice()
    .sort((left, right) => left.rank - right.rank)
    .map(({ eventId }) => eventId);
  const retrieval = setMetrics(label.relevantEventIds, retrieved);
  const citation = setMetrics(label.relevantEventIds, observation.citations);
  const firstRelevant = retrieved.findIndex((eventId) =>
    label.relevantEventIds.includes(eventId)
  );
  const expectedAnswerStatus = label.expectedStatus === observation.status;
  return {
    questionId: label.questionId,
    answerExact:
      capabilities.answerRows && observation.status !== 'unsupported'
        ? expectedRows.size === actualRows.size &&
          [...expectedRows].every((value) => actualRows.has(value)) &&
          expectedAnswerStatus
        : null,
    answerPrecision: capabilities.answerRows ? answer.precision : null,
    answerRecall: capabilities.answerRows ? answer.recall : null,
    answerability: capabilities.answerRows ? expectedAnswerStatus : null,
    retrievalRecallAtK:
      capabilities.rankedRetrieval && label.relevantEventIds.length > 0
        ? retrieval.recall
        : null,
    reciprocalRank:
      capabilities.rankedRetrieval && label.relevantEventIds.length > 0
        ? firstRelevant < 0
          ? 0
          : 1 / (firstRelevant + 1)
        : null,
    citationPrecision: capabilities.citations ? citation.precision : null,
    citationRecall: capabilities.citations ? citation.recall : null,
    staleLeakage: retrieved.filter((eventId) => label.staleEventIds?.includes(eventId)).length,
  };
}

function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((sorted.length - 1) * quantile)];
}

function summarize(
  cases: MemoryStackRun['cases'],
  adapter: ReturnType<MemoryStackAdapter['describe']>
): MemoryStackSummary {
  const scores = cases.flatMap((result) => result.scores);
  const observations = cases.flatMap((result) => result.observation.questions);
  const answerScores = scores.filter((score) => score.answerExact !== null);
  const retrievalScores = scores.filter((score) => score.retrievalRecallAtK !== null);
  const citationScores = scores.filter((score) => score.citationRecall !== null);
  const wallTimes = observations.map(({ wallMs }) => wallMs);
  const staleReturned = scores.reduce((total, score) => total + score.staleLeakage, 0);
  const retrievedCount = observations.reduce(
    (total, observation) => total + observation.retrieved.length,
    0
  );
  return {
    questions: scores.length,
    operationalErrors: observations.filter(({ status }) => status === 'error').length,
    answerCoverage: adapter.capabilities.answerRows ? answerScores.length / scores.length : 0,
    answerAccuracy: mean(
      answerScores.map((score) => (score.answerExact === true ? 1 : 0))
    ),
    answerPrecision: mean(
      answerScores.flatMap((score) =>
        score.answerPrecision === null ? [] : [score.answerPrecision]
      )
    ),
    answerRecall: mean(
      answerScores.flatMap((score) =>
        score.answerRecall === null ? [] : [score.answerRecall]
      )
    ),
    answerabilityAccuracy: mean(
      answerScores.map((score) => (score.answerability === true ? 1 : 0))
    ),
    retrievalCoverage: adapter.capabilities.rankedRetrieval
      ? retrievalScores.length / scores.length
      : 0,
    retrievalRecallAtK: mean(
      retrievalScores.flatMap((score) =>
        score.retrievalRecallAtK === null ? [] : [score.retrievalRecallAtK]
      )
    ),
    meanReciprocalRank: mean(
      retrievalScores.flatMap((score) =>
        score.reciprocalRank === null ? [] : [score.reciprocalRank]
      )
    ),
    citationCoverage: adapter.capabilities.citations
      ? citationScores.length / scores.length
      : 0,
    citationPrecision: mean(
      citationScores.flatMap((score) =>
        score.citationPrecision === null ? [] : [score.citationPrecision]
      )
    ),
    citationRecall: mean(
      citationScores.flatMap((score) =>
        score.citationRecall === null ? [] : [score.citationRecall]
      )
    ),
    staleLeakageRate: retrievedCount === 0 ? 0 : staleReturned / retrievedCount,
    medianWallMs: percentile(wallTimes, 0.5),
    p95WallMs: percentile(wallTimes, 0.95),
  };
}

export async function runMemoryStackBenchmark(input: {
  suite: { id: string; version: string };
  cases: MemoryStackCase[];
  labels: MemoryStackLabel[];
  adapter: MemoryStackAdapter;
  generatedAt?: string;
}): Promise<MemoryStackRun> {
  const labelByQuestion = new Map(
    input.labels.map((label) => [`${label.caseId}/${label.questionId}`, label])
  );
  const adapter = input.adapter.describe();
  const suiteDigest = benchmarkDigest({ cases: input.cases, labels: input.labels });
  const cases: MemoryStackRun['cases'] = [];
  for (const testCase of input.cases) {
    const observation = await input.adapter.runCase(testCase);
    validateObservation(testCase, observation);
    const scores = observation.questions.map((question) => {
      const label = labelByQuestion.get(`${testCase.id}/${question.questionId}`);
      if (label === undefined) {
        throw new Error(`missing label for ${testCase.id}/${question.questionId}`);
      }
      return questionScore(label, question, adapter.capabilities);
    });
    cases.push({ observation, scores });
  }
  const summary = summarize(cases, adapter);
  const semanticDigest = benchmarkDigest({
    suite: { ...input.suite, digest: suiteDigest },
    adapter,
    cases: cases.map(({ observation, scores }) => ({
      caseId: observation.caseId,
      questions: observation.questions.map(({ wallMs: _wallMs, ...question }) => question),
      scores,
    })),
    summary: {
      ...summary,
      medianWallMs: 0,
      p95WallMs: 0,
    },
  });
  return {
    schemaVersion: MEMORY_STACK_PROTOCOL_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    suite: { ...input.suite, digest: suiteDigest },
    adapter,
    cases,
    summary,
    semanticDigest,
  };
}
