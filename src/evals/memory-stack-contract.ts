import { createHash } from 'node:crypto';

export const MEMORY_STACK_PROTOCOL_VERSION = 'rembero.memory-stack.v1' as const;

export type MemoryCell =
  | { type: 'atom'; value: string }
  | { type: 'number'; value: number };

export type MemoryRow = MemoryCell[];

export interface MemoryStackEvent {
  id: string;
  at: string;
  text: string;
  clauses: string;
  trust: 'accepted' | 'tentative';
}

export interface MemoryStackQuestion {
  id: string;
  text: string;
  query: string;
  answerColumns: string[];
  includeTentative?: boolean;
  topK?: number;
}

export interface MemoryStackCase {
  id: string;
  tags: string[];
  events: MemoryStackEvent[];
  questions: MemoryStackQuestion[];
}

export interface MemoryStackLabel {
  caseId: string;
  questionId: string;
  expectedStatus: 'answered' | 'no_match';
  expectedRows: MemoryRow[];
  relevantEventIds: string[];
  staleEventIds?: string[];
}

export interface MemoryStackCapabilities {
  answerRows: boolean;
  rankedRetrieval: boolean;
  citations: boolean;
  rules: boolean;
  temporalUpdates: boolean;
  trustViews: boolean;
}

export interface MemoryStackAdapterDescriptor {
  id: string;
  version: string;
  capabilities: MemoryStackCapabilities;
}

export interface RankedMemory {
  eventId: string;
  rank: number;
}

export interface MemoryStackQuestionObservation {
  questionId: string;
  status: 'answered' | 'no_match' | 'unsupported' | 'error';
  answerRows: MemoryRow[];
  retrieved: RankedMemory[];
  citations: string[];
  wallMs: number;
  error?: string;
}

export interface MemoryStackCaseObservation {
  caseId: string;
  questions: MemoryStackQuestionObservation[];
}

export interface MemoryStackAdapter {
  describe(): MemoryStackAdapterDescriptor;
  runCase(testCase: MemoryStackCase): Promise<MemoryStackCaseObservation>;
}

export interface MemoryStackQuestionScore {
  questionId: string;
  answerExact: boolean | null;
  answerPrecision: number | null;
  answerRecall: number | null;
  answerability: boolean | null;
  retrievalRecallAtK: number | null;
  reciprocalRank: number | null;
  citationPrecision: number | null;
  citationRecall: number | null;
  staleLeakage: number;
}

export interface MemoryStackSummary {
  questions: number;
  operationalErrors: number;
  answerCoverage: number;
  answerAccuracy: number | null;
  answerPrecision: number | null;
  answerRecall: number | null;
  answerabilityAccuracy: number | null;
  retrievalCoverage: number;
  retrievalRecallAtK: number | null;
  meanReciprocalRank: number | null;
  citationCoverage: number;
  citationPrecision: number | null;
  citationRecall: number | null;
  staleLeakageRate: number;
  medianWallMs: number;
  p95WallMs: number;
}

export interface MemoryStackRun {
  schemaVersion: typeof MEMORY_STACK_PROTOCOL_VERSION;
  generatedAt: string;
  suite: { id: string; version: string; digest: string };
  adapter: MemoryStackAdapterDescriptor;
  cases: Array<{
    observation: MemoryStackCaseObservation;
    scores: MemoryStackQuestionScore[];
  }>;
  summary: MemoryStackSummary;
  semanticDigest: string;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)])
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('benchmark values must be finite');
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function benchmarkDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function publicCase(testCase: MemoryStackCase): MemoryStackCase {
  return {
    id: testCase.id,
    tags: [...testCase.tags],
    events: testCase.events.map(({ id, at, text, clauses, trust }) => ({
      id,
      at,
      text,
      clauses,
      trust,
    })),
    questions: testCase.questions.map(
      ({ id, text, query, answerColumns, includeTentative, topK }) => ({
        id,
        text,
        query,
        answerColumns: [...answerColumns],
        ...(includeTentative === undefined ? {} : { includeTentative }),
        ...(topK === undefined ? {} : { topK }),
      })
    ),
  };
}
