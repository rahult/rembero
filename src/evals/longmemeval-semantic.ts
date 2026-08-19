import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { canonicalKey, parseProgram } from '../engine/index.js';
import type { EmbeddingClient } from '../llm/embeddings.js';
import { redactSensitiveText } from '../safety.js';
import {
  isRecommendationIntent,
  MemoryEmbeddingCache,
  semanticSearchKnowledge,
} from '../knowledge/semantic-search.js';
import type { MemorySource } from '../store/store.js';
import {
  scoreLongMemEvalInstances,
  scoreLongMemEvalRetrievedSessions,
  summarizeLongMemEvalResults,
  type LongMemEvalInstance,
  type LongMemEvalQuestionResult,
  type LongMemEvalRetrievalSummary,
} from './longmemeval.js';

export type LongMemEvalSplit = 'dev' | 'test';

export interface LongMemEvalSemanticPolicyResult {
  split: LongMemEvalSplit;
  questions: number;
  routedQuestions: number;
  policy: {
    route: 'recommendation-intent-only';
    semanticTopK: 5;
    lexicalCandidateLimit: 100;
    documentSourceCharacters: 16_384;
    abstentionAuthority: 'none';
  };
  model: string;
  baseline: LongMemEvalRetrievalSummary;
  semanticPolicy: LongMemEvalRetrievalSummary;
  baselinePreference: LongMemEvalRetrievalSummary;
  semanticPolicyPreference: LongMemEvalRetrievalSummary;
  providerUsage: {
    calls: number;
    promptTokens: number;
    totalTokens: number;
    costResponses: number;
    costUsd: number;
  };
  routed: LongMemEvalQuestionResult[];
}

export function longMemEvalSplit(questionId: string): LongMemEvalSplit {
  const prefix = createHash('sha256').update(questionId).digest().readUInt32BE(0);
  return prefix % 2 === 0 ? 'dev' : 'test';
}

function sessionText(messages: LongMemEvalInstance['haystack_sessions'][number]): string {
  return messages.map(({ role, content }) => `${role}: ${content}`).join('\n');
}

function semanticCorpus(instance: LongMemEvalInstance): {
  clauses: ReturnType<typeof parseProgram>;
  sources: Map<string, MemorySource[]>;
} {
  const clauses = parseProgram(
    instance.haystack_session_ids
      .map((_, index) => `longmem_session(session_${index}).`)
      .join('\n')
  );
  const sources = new Map<string, MemorySource[]>();
  for (const [index, clause] of clauses.entries()) {
    const safeSource = redactSensitiveText(
      sessionText(instance.haystack_sessions[index]!)
    );
    sources.set(canonicalKey(clause), [{
      namespace: 'longmemeval',
      opId: instance.haystack_session_ids[index]!,
      ts: instance.haystack_dates[index]!,
      text: safeSource.text,
      ...(safeSource.redacted ? { redacted: true } : {}),
    }]);
  }
  return { clauses, sources };
}

export async function runLongMemEvalSemanticPolicy(
  instances: readonly LongMemEvalInstance[],
  embeddings: EmbeddingClient,
  split: LongMemEvalSplit
): Promise<LongMemEvalSemanticPolicyResult> {
  const selected = instances.filter((instance) => longMemEvalSplit(instance.question_id) === split);
  const baselineRun = scoreLongMemEvalInstances(selected, {
    topK: 5,
    sourceCharacterLimit: 16_384,
    minimumScore: 1,
  });
  const byQuestion = new Map(
    baselineRun.questions.map((question) => [question.questionId, question])
  );
  const cache = new MemoryEmbeddingCache();
  const usage = { calls: 0, promptTokens: 0, totalTokens: 0, costResponses: 0, costUsd: 0 };
  const routed: LongMemEvalQuestionResult[] = [];
  for (const instance of selected) {
    if (!isRecommendationIntent(instance.question)) continue;
    const { clauses, sources } = semanticCorpus(instance);
    const started = performance.now();
    const search = await semanticSearchKnowledge(
      clauses,
      instance.question,
      sources,
      embeddings,
      { limit: 5, candidateLimit: 100, kinds: ['fact'], cache }
    );
    const wallMs = performance.now() - started;
    const retrieved = search.results.flatMap((result) =>
      result.sources[0]?.opId === undefined ? [] : [result.sources[0].opId]
    );
    const scored = scoreLongMemEvalRetrievedSessions(
      instance,
      retrieved,
      wallMs,
      search.results[0]?.semanticScore ?? 0
    );
    routed.push(scored);
    byQuestion.set(instance.question_id, scored);
    usage.calls += search.providerCalls;
    usage.promptTokens += search.providerUsage.promptTokens ?? 0;
    usage.totalTokens += search.providerUsage.totalTokens ?? 0;
    if (search.providerUsage.costUsd !== null) {
      usage.costResponses += search.providerCalls;
      usage.costUsd += search.providerUsage.costUsd;
    }
  }
  const questions = selected.map((instance) => byQuestion.get(instance.question_id)!);
  const preference = questions.filter(
    ({ questionType }) => questionType === 'single-session-preference'
  );
  const baselinePreference = baselineRun.questions.filter(
    ({ questionType }) => questionType === 'single-session-preference'
  );
  return {
    split,
    questions: questions.length,
    routedQuestions: routed.length,
    policy: {
      route: 'recommendation-intent-only',
      semanticTopK: 5,
      lexicalCandidateLimit: 100,
      documentSourceCharacters: 16_384,
      abstentionAuthority: 'none',
    },
    model: embeddings.model,
    baseline: baselineRun.summary,
    semanticPolicy: summarizeLongMemEvalResults(questions),
    baselinePreference: summarizeLongMemEvalResults(baselinePreference),
    semanticPolicyPreference: summarizeLongMemEvalResults(preference),
    providerUsage: usage,
    routed,
  };
}
