import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';
import { canonicalKey, parseProgram } from '../engine/index.js';
import {
  DEFAULT_KNOWLEDGE_SEARCH_SOURCE_CHARS,
  searchKnowledge,
} from '../knowledge/search.js';
import type { MemorySource } from '../store/store.js';

export const LONGMEMEVAL_RETRIEVAL_VERSION =
  'remembero.longmemeval-retrieval.v1' as const;
export const LONGMEMEVAL_S_COMMIT =
  '98d7416c24c778c2fee6e6f3006e7a073259d48f' as const;
export const LONGMEMEVAL_S_SHA256 =
  'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442' as const;
export const LONGMEMEVAL_S_URL =
  `https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/${LONGMEMEVAL_S_COMMIT}/longmemeval_s_cleaned.json`;

interface LongMemEvalMessage {
  role: string;
  content: string;
  has_answer?: boolean;
}

export interface LongMemEvalInstance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: LongMemEvalMessage[][];
  answer_session_ids: string[];
}

export interface LongMemEvalQuestionResult {
  questionId: string;
  questionType: string;
  abstention: boolean;
  evidenceSessionIds: string[];
  retrievedSessionIds: string[];
  precisionAtK: number | null;
  recallAtK: number | null;
  reciprocalRank: number | null;
  strictEvidenceCoverage: boolean | null;
  empty: boolean;
  topScore: number;
  wallMs: number;
}

export interface LongMemEvalRetrievalSummary {
  questions: number;
  answerableQuestions: number;
  abstentionQuestions: number;
  precisionAtK: number;
  recallAtK: number;
  meanReciprocalRank: number;
  strictEvidenceCoverageRate: number;
  abstentionEmptyRate: number;
  medianWallMs: number;
  p95WallMs: number;
}

export interface LongMemEvalRetrievalRun {
  schemaVersion: typeof LONGMEMEVAL_RETRIEVAL_VERSION;
  generatedAt: string;
  dataset: {
    id: 'xiaowu0162/longmemeval-cleaned';
    split: 'longmemeval_s_cleaned';
    commit: typeof LONGMEMEVAL_S_COMMIT;
    sha256: string;
  };
  adapter: {
    id: 'remembero-source-search';
    version: '1';
    sourceCharacterLimit: number;
    modelCalls: 0;
    embeddingCalls: 0;
    remoteCalls: 0;
  };
  topK: number;
  minimumScore: number;
  summary: LongMemEvalRetrievalSummary;
  byQuestionType: Record<string, LongMemEvalRetrievalSummary>;
  questions: LongMemEvalQuestionResult[];
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function downloadLongMemEvalS(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.partial`;
  await rm(temporaryPath, { force: true });
  const response = await fetch(LONGMEMEVAL_S_URL, { redirect: 'follow' });
  if (!response.ok || response.body === null) {
    throw new Error(`LongMemEval download failed with HTTP ${response.status}`);
  }
  try {
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(temporaryPath, { flags: 'wx' })
    );
    const digest = await sha256File(temporaryPath);
    if (digest !== LONGMEMEVAL_S_SHA256) {
      throw new Error(
        `LongMemEval SHA-256 ${digest} does not match ${LONGMEMEVAL_S_SHA256}`
      );
    }
    await rm(path, { force: true });
    await rename(temporaryPath, path);
    return digest;
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function loadLongMemEvalS(path: string): Promise<{
  instances: LongMemEvalInstance[];
  sha256: string;
}> {
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== LONGMEMEVAL_S_SHA256) {
    throw new Error(`LongMemEval SHA-256 ${sha256} does not match pinned dataset`);
  }
  const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 500) {
    throw new Error('LongMemEval-S must contain exactly 500 instances');
  }
  return { instances: parsed as LongMemEvalInstance[], sha256 };
}

export function longMemEvalSessionText(messages: readonly LongMemEvalMessage[]): string {
  return messages.map(({ role, content }) => `${role}: ${content}`).join('\n');
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((sorted.length - 1) * quantile)] ?? 0;
}

export function summarizeLongMemEvalResults(
  results: readonly LongMemEvalQuestionResult[]
): LongMemEvalRetrievalSummary {
  const answerable = results.filter(({ abstention }) => !abstention);
  const abstentions = results.filter(({ abstention }) => abstention);
  return {
    questions: results.length,
    answerableQuestions: answerable.length,
    abstentionQuestions: abstentions.length,
    precisionAtK: mean(answerable.flatMap(({ precisionAtK }) =>
      precisionAtK === null ? [] : [precisionAtK]
    )),
    recallAtK: mean(answerable.flatMap(({ recallAtK }) =>
      recallAtK === null ? [] : [recallAtK]
    )),
    meanReciprocalRank: mean(answerable.flatMap(({ reciprocalRank }) =>
      reciprocalRank === null ? [] : [reciprocalRank]
    )),
    strictEvidenceCoverageRate: mean(answerable.map(({ strictEvidenceCoverage }) =>
      strictEvidenceCoverage === true ? 1 : 0
    )),
    abstentionEmptyRate: mean(abstentions.map(({ empty }) => empty ? 1 : 0)),
    medianWallMs: percentile(results.map(({ wallMs }) => wallMs), 0.5),
    p95WallMs: percentile(results.map(({ wallMs }) => wallMs), 0.95),
  };
}

export function scoreLongMemEvalRetrievedSessions(
  instance: LongMemEvalInstance,
  retrievedSessionIds: string[],
  wallMs: number,
  topScore: number
): LongMemEvalQuestionResult {
  const evidence = new Set(instance.answer_session_ids);
  const retrieved = new Set(retrievedSessionIds);
  const matches = [...retrieved].filter((id) => evidence.has(id)).length;
  const abstention = instance.question_id.endsWith('_abs');
  const firstRelevant = retrievedSessionIds.findIndex((id) => evidence.has(id));
  return {
    questionId: instance.question_id,
    questionType: instance.question_type,
    abstention,
    evidenceSessionIds: [...instance.answer_session_ids],
    retrievedSessionIds,
    precisionAtK: abstention ? null : retrieved.size === 0 ? 0 : matches / retrieved.size,
    recallAtK: abstention ? null : evidence.size === 0 ? 0 : matches / evidence.size,
    reciprocalRank: abstention ? null : firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    strictEvidenceCoverage: abstention ? null : matches === evidence.size,
    empty: retrievedSessionIds.length === 0,
    topScore,
    wallMs,
  };
}

function validateInstance(instance: LongMemEvalInstance): void {
  if (
    instance.question_id.trim() === '' ||
    instance.question.trim() === '' ||
    instance.haystack_session_ids.length !== instance.haystack_sessions.length ||
    instance.haystack_dates.length !== instance.haystack_sessions.length
  ) {
    throw new Error(`invalid LongMemEval instance ${instance.question_id}`);
  }
  const ids = new Set(instance.haystack_session_ids);
  if (instance.answer_session_ids.some((id) => !ids.has(id))) {
    throw new Error(`LongMemEval instance ${instance.question_id} has unknown evidence`);
  }
}

export function scoreLongMemEvalInstances(
  instances: readonly LongMemEvalInstance[],
  options: {
    topK?: number;
    minimumScore?: number;
    sourceCharacterLimit?: number;
    generatedAt?: string;
    sha256?: string;
  } = {}
): LongMemEvalRetrievalRun {
  const topK = options.topK ?? 5;
  const minimumScore = options.minimumScore ?? 1;
  const sourceCharacterLimit =
    options.sourceCharacterLimit ?? DEFAULT_KNOWLEDGE_SEARCH_SOURCE_CHARS;
  if (!Number.isInteger(topK) || topK < 1 || topK > 100) {
    throw new Error('LongMemEval topK must be an integer between 1 and 100');
  }
  const seen = new Set<string>();
  const questions = instances.map((instance) => {
    validateInstance(instance);
    if (seen.has(instance.question_id)) {
      throw new Error(`duplicate LongMemEval question ${instance.question_id}`);
    }
    seen.add(instance.question_id);
    const program = instance.haystack_session_ids
      .map((_, index) => `longmem_session(session_${index}).`)
      .join('\n');
    const clauses = parseProgram(program);
    const sources = new Map<string, MemorySource[]>();
    for (const [index, clause] of clauses.entries()) {
      sources.set(canonicalKey(clause), [
        {
          namespace: 'longmemeval',
          opId: instance.haystack_session_ids[index]!,
          ts: instance.haystack_dates[index]!,
          text: longMemEvalSessionText(instance.haystack_sessions[index]!),
        },
      ]);
    }
    const started = performance.now();
    const search = searchKnowledge(clauses, instance.question, sources, {
      limit: topK,
      kinds: ['fact'],
      sourceCharacterLimit,
      minimumScore,
    });
    const wallMs = performance.now() - started;
    const retrievedSessionIds = search.results.flatMap((result) =>
      result.sources[0]?.opId === undefined ? [] : [result.sources[0].opId]
    );
    return scoreLongMemEvalRetrievedSessions(
      instance,
      retrievedSessionIds,
      wallMs,
      search.results[0]?.score ?? 0
    );
  });
  const byQuestionType = Object.fromEntries(
    [...new Set(questions.map(({ questionType }) => questionType))]
      .sort()
      .map((questionType) => [
        questionType,
        summarizeLongMemEvalResults(
          questions.filter((question) => question.questionType === questionType)
        ),
      ])
  );
  return {
    schemaVersion: LONGMEMEVAL_RETRIEVAL_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    dataset: {
      id: 'xiaowu0162/longmemeval-cleaned',
      split: 'longmemeval_s_cleaned',
      commit: LONGMEMEVAL_S_COMMIT,
      sha256: options.sha256 ?? LONGMEMEVAL_S_SHA256,
    },
    adapter: {
      id: 'remembero-source-search',
      version: '1',
      sourceCharacterLimit,
      modelCalls: 0,
      embeddingCalls: 0,
      remoteCalls: 0,
    },
    topK,
    minimumScore,
    summary: summarizeLongMemEvalResults(questions),
    byQuestionType,
    questions,
  };
}
