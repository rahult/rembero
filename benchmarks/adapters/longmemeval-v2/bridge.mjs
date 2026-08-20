#!/usr/bin/env node
import readline from 'node:readline';
import { canonicalKey, parseProgram } from '../../../dist/engine/index.js';
import { searchKnowledge } from '../../../dist/knowledge/search.js';
import { recallWords } from '../../../dist/llm/schema.js';
import { embeddingClientFromEnv } from '../../../dist/llm/embeddings.js';
import { redactSensitiveText } from '../../../dist/safety.js';

const MAX_TRAJECTORIES = 500;
const MAX_STATES = 20_000;
const DEFAULT_TOP_K = 6;
const DEFAULT_SOURCE_CHARACTERS = 16_384;
const DEFAULT_CONTEXT_CHARACTERS = 12_000;
const STATE_CHUNK_CHARACTERS = 4_096;
const STATE_CHUNK_OVERLAP = 512;
// Long browser-agent accessibility trees can place the useful field well after
// the first screenful. Keep a bounded but materially deeper state window so
// retrieval does not silently discard the tail of a long form.
const MAX_STATE_CHUNKS = 24;
const CANDIDATE_LIMIT = 100;
const CHUNKS_PER_RETURNED_STATE = 3;
const MAX_STATES_PER_TRAJECTORY = 2;
const DEFAULT_SEMANTIC_SUMMARY_CHARACTERS = 6_000;
const DEFAULT_SEMANTIC_TOP_TRAJECTORIES = 32;
const SEMANTIC_SELECTION_WEIGHT = 4_000;
const SEMANTIC_STATES_PER_TRAJECTORY = 8;
const SEMANTIC_BATCH_SIZE = 50;

const documents = [];
const wordPostings = new Map();
const documentIdByOpId = new Map();
const states = [];
const trajectories = [];
const trajectoryById = new Map();
const stateWordPostings = new Map();
let trajectoryCount = 0;
let stateCount = 0;
let totalDocumentWords = 0;
let totalStateWords = 0;
let semanticConfig = {
  enabled: false,
  level: 'trajectory',
  summaryCharacters: DEFAULT_SEMANTIC_SUMMARY_CHARACTERS,
  topResults: DEFAULT_SEMANTIC_TOP_TRAJECTORIES,
  prepareAfterInserts: 0,
};
let semanticIndexPromise = null;
let semanticEmbeddings = [];
let semanticEntries = [];
let semanticUsage = {
  calls: 0,
  promptTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};
let semanticModel = null;
let semanticMaintenanceMs = 0;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function text(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function semanticSummary(trajectory, summaryCharacters) {
  const statesForSummary = trajectory.states ?? [];
  const sampleCount = Math.min(12, statesForSummary.length);
  const sampled = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const position = sampleCount <= 1
      ? 0
      : Math.round(index * (statesForSummary.length - 1) / (sampleCount - 1));
    const state = statesForSummary[position];
    if (state === undefined) continue;
    sampled.push([
      `State ${text(state.state_index)}`,
      `URL: ${text(state.url)}`,
      `Action: ${text(state.action)}`,
      `Thought: ${text(state.thought)}`,
      `Accessibility: ${text(state.accessibility_tree)}`,
    ].join('\n'));
  }
  return [
    `Trajectory: ${text(trajectory.id)}`,
    `Environment: ${text(trajectory.environment)}`,
    `Goal: ${text(trajectory.goal)}`,
    `Outcome: ${text(trajectory.outcome)}`,
    ...sampled,
  ].join('\n').slice(0, summaryCharacters);
}

function semanticStateSummary(trajectory, state, summaryCharacters) {
  return [
    `Trajectory: ${text(trajectory.id)}`,
    `Goal: ${text(trajectory.goal)}`,
    `State: ${text(state.state_index)}`,
    `URL: ${text(state.url)}`,
    `Action: ${text(state.action)}`,
    `Thought: ${text(state.thought)}`,
    `Accessibility: ${text(state.accessibility_tree)}`,
  ].join('\n').slice(0, summaryCharacters);
}

function safeSemanticText(value) {
  return redactSensitiveText(value).text;
}

function configureSemantic(config = {}) {
  requireValue(trajectories.length === 0, 'semantic configuration must precede inserts');
  const enabled = config.enabled === true;
  const level = config.level ?? 'trajectory';
  const summaryCharacters = config.summaryCharacters ?? DEFAULT_SEMANTIC_SUMMARY_CHARACTERS;
  const topResults = config.topResults ?? DEFAULT_SEMANTIC_TOP_TRAJECTORIES;
  const prepareAfterInserts = config.prepareAfterInserts ?? 0;
  requireValue(level === 'trajectory' || level === 'state', 'semantic level must be trajectory or state');
  requireValue(Number.isInteger(summaryCharacters) && summaryCharacters >= 512 && summaryCharacters <= 16_384, 'semantic summaryCharacters is out of bounds');
  requireValue(Number.isInteger(topResults) && topResults >= 1 && topResults <= 100, 'semantic topResults is out of bounds');
  requireValue(Number.isInteger(prepareAfterInserts) && prepareAfterInserts >= 0 && prepareAfterInserts <= MAX_TRAJECTORIES, 'semantic prepareAfterInserts is out of bounds');
  semanticConfig = { enabled, level, summaryCharacters, topResults, prepareAfterInserts };
  return {
    enabled,
    level,
    summaryCharacters,
    topResults,
    prepareAfterInserts,
  };
}

function semanticMetadata() {
  return {
    model: semanticModel,
    calls: semanticUsage.calls,
    promptTokens: semanticUsage.promptTokens,
    totalTokens: semanticUsage.totalTokens,
    costUsd: semanticUsage.costUsd,
    maintenanceMs: semanticMaintenanceMs,
  };
}

async function ensureSemanticIndex() {
  if (!semanticConfig.enabled) return;
  if (semanticIndexPromise !== null) {
    await semanticIndexPromise;
    return;
  }
  semanticIndexPromise = (async () => {
    const started = performance.now();
    const client = embeddingClientFromEnv(process.env);
    semanticEntries = semanticConfig.level === 'state'
      ? states.map((state, stateId) => ({ key: stateId, text: state.semanticText }))
      : trajectories.map((trajectory) => ({ key: trajectory.id, text: trajectory.semanticText }));
    const texts = semanticEntries.map((entry) => entry.text);
    semanticEmbeddings = [];
    for (let start = 0; start < texts.length; start += SEMANTIC_BATCH_SIZE) {
      const embedded = await client.embed(texts.slice(start, start + SEMANTIC_BATCH_SIZE));
      semanticModel = embedded.model;
      semanticUsage.calls += 1;
      semanticUsage.promptTokens += embedded.usage.promptTokens ?? 0;
      semanticUsage.totalTokens += embedded.usage.totalTokens ?? 0;
      semanticUsage.costUsd += embedded.usage.costUsd ?? 0;
      semanticEmbeddings.push(...embedded.vectors);
    }
    semanticMaintenanceMs = performance.now() - started;
  })();
  try {
    await semanticIndexPromise;
  } catch (error) {
    semanticIndexPromise = null;
    throw error;
  }
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

async function semanticResultScores(query) {
  if (!semanticConfig.enabled || trajectories.length === 0) return new Map();
  await ensureSemanticIndex();
  const client = embeddingClientFromEnv(process.env);
  const embedded = await client.embed([query]);
  semanticModel = embedded.model;
  semanticUsage.calls += 1;
  semanticUsage.promptTokens += embedded.usage.promptTokens ?? 0;
  semanticUsage.totalTokens += embedded.usage.totalTokens ?? 0;
  semanticUsage.costUsd += embedded.usage.costUsd ?? 0;
  const queryVector = embedded.vectors[0];
  return new Map(semanticEntries
    .map((entry, index) => [entry.key, cosineSimilarity(queryVector, semanticEmbeddings[index])])
    .sort((left, right) => right[1] - left[1])
    .slice(0, semanticConfig.topResults));
}

function stateSource(trajectory, state) {
  return [
    `Trajectory: ${text(trajectory.id)}`,
    `Environment: ${text(trajectory.environment)}`,
    `Goal: ${text(trajectory.goal)}`,
    `Outcome: ${text(trajectory.outcome)}`,
    `State: ${text(state.state_index)}`,
    `URL: ${text(state.url)}`,
    `Action: ${text(state.action)}`,
    `Thought: ${text(state.thought)}`,
    `Accessibility tree:\n${text(state.accessibility_tree)}`,
  ].join('\n');
}

function chunks(textValue) {
  if (textValue.length <= STATE_CHUNK_CHARACTERS) return [textValue];
  const result = [];
  const step = STATE_CHUNK_CHARACTERS - STATE_CHUNK_OVERLAP;
  for (
    let start = 0;
    start < textValue.length && result.length < MAX_STATE_CHUNKS;
    start += step
  ) {
    result.push(textValue.slice(start, start + STATE_CHUNK_CHARACTERS));
  }
  return result;
}

function indexDocument(documentId, sourceText) {
  const frequencies = frequenciesFor(sourceText);
  documents[documentId].frequencies = frequencies;
  documents[documentId].wordCount = [...frequencies.values()].reduce(
    (sum, value) => sum + value,
    0
  );
  totalDocumentWords += documents[documentId].wordCount;
  for (const word of frequencies.keys()) {
    const posting = wordPostings.get(word) ?? [];
    posting.push(documentId);
    wordPostings.set(word, posting);
  }
}

function frequenciesFor(sourceText) {
  const frequencies = new Map();
  for (const word of recallWords(sourceText).filter((value) => value.length >= 3)) {
    frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  }
  return frequencies;
}

function indexState(stateId, frequencies) {
  for (const word of frequencies.keys()) {
    const posting = stateWordPostings.get(word) ?? [];
    posting.push(stateId);
    stateWordPostings.set(word, posting);
  }
}

function bm25Term(frequency, documentLength, averageLength, inverseDocumentFrequency) {
  const k1 = 1.2;
  const b = 0.75;
  const denominator = frequency + k1 * (
    1 - b + b * documentLength / Math.max(1, averageLength)
  );
  return inverseDocumentFrequency * frequency * (k1 + 1) / denominator;
}

function insertTrajectory(trajectory, sourceCharacters) {
  requireValue(trajectory && typeof trajectory === 'object', 'trajectory must be an object');
  requireValue(typeof trajectory.id === 'string' && trajectory.id, 'trajectory id is required');
  requireValue(Array.isArray(trajectory.states), 'trajectory states must be an array');
  requireValue(trajectoryCount < MAX_TRAJECTORIES, `trajectory count exceeds ${MAX_TRAJECTORIES}`);
  requireValue(stateCount + trajectory.states.length <= MAX_STATES, `state count exceeds ${MAX_STATES}`);
  const trajectoryRecord = {
    id: trajectory.id,
    semanticText: semanticConfig.enabled && semanticConfig.level === 'trajectory'
      ? safeSemanticText(semanticSummary(trajectory, semanticConfig.summaryCharacters))
      : '',
    stateIds: [],
  };
  trajectories.push(trajectoryRecord);
  trajectoryById.set(trajectory.id, trajectoryRecord);
  for (const [position, state] of trajectory.states.entries()) {
    const safe = redactSensitiveText(stateSource(trajectory, state));
    const maximumCoveredCharacters =
      STATE_CHUNK_CHARACTERS +
      (MAX_STATE_CHUNKS - 1) * (STATE_CHUNK_CHARACTERS - STATE_CHUNK_OVERLAP);
    const boundedStateText = safe.text.slice(
      0,
      Math.min(sourceCharacters * MAX_STATE_CHUNKS, maximumCoveredCharacters)
    );
    const selectedChunks = chunks(boundedStateText);
    const stateId = states.length;
    const documentIds = [];
    for (const [chunkIndex, chunk] of selectedChunks.entries()) {
      const documentId = documents.length;
      const clause = parseProgram(`trajectory_state_chunk(chunk_${documentId}).`)[0];
      const source = {
        namespace: 'longmemeval_v2',
        opId: `${trajectory.id}:${position}:${chunkIndex}`,
        ts: new Date(stateCount).toISOString(),
        text: [
          `Trajectory: ${trajectory.id}`,
          `State: ${text(state.state_index)}`,
          `Chunk: ${chunkIndex + 1}/${selectedChunks.length}`,
          chunk,
        ].join('\n'),
        ...(safe.redacted ? { redacted: true } : {}),
      };
      documents.push({ clause, source, stateId });
      documentIdByOpId.set(source.opId, documentId);
      documentIds.push(documentId);
      if (!safe.redacted) indexDocument(documentId, source.text);
    }
    const frequencies = safe.redacted ? new Map() : frequenciesFor(boundedStateText);
    const wordCount = [...frequencies.values()].reduce((sum, value) => sum + value, 0);
    states.push({
      opId: `${trajectory.id}:${position}`,
      trajectoryId: trajectory.id,
      semanticText: semanticConfig.enabled && semanticConfig.level === 'state'
        ? safeSemanticText(semanticStateSummary(trajectory, state, semanticConfig.summaryCharacters))
        : '',
      documentIds,
      frequencies,
      wordCount,
    });
    trajectoryRecord.stateIds.push(stateId);
    totalStateWords += wordCount;
    if (!safe.redacted) indexState(stateId, frequencies);
    stateCount++;
  }
  trajectoryCount++;
  return { trajectoryCount, stateCount };
}

async function queryMemory(query, topK, sourceCharacters, contextCharacters) {
  requireValue(typeof query === 'string' && query.trim(), 'query must be a non-empty string');
  const queryWords = new Set(recallWords(query).filter((value) => value.length >= 3));
  const stateScores = new Map();
  const averageStateLength = totalStateWords / Math.max(1, states.length);
  for (const word of queryWords) {
    const posting = stateWordPostings.get(word) ?? [];
    const inverseDocumentFrequency = Math.log((states.length + 1) / (posting.length + 1)) + 1;
    for (const stateId of posting) {
      const frequency = states[stateId].frequencies.get(word) ?? 1;
      stateScores.set(
        stateId,
        (stateScores.get(stateId) ?? 0) + bm25Term(
          frequency,
          states[stateId].wordCount,
          averageStateLength,
          inverseDocumentFrequency
        )
      );
    }
  }
  const lexicalCandidateStateIds = [...stateScores]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, CANDIDATE_LIMIT)
    .map(([stateId]) => stateId);
  const semanticScores = await semanticResultScores(query);
  const semanticCandidateStateIds = [];
  if (semanticConfig.level === 'state') {
    semanticCandidateStateIds.push(...semanticScores.keys());
  } else {
    for (const trajectoryId of semanticScores.keys()) {
      const trajectory = trajectoryById.get(trajectoryId);
      if (trajectory === undefined) continue;
      semanticCandidateStateIds.push(...trajectory.stateIds
        .slice()
        .sort((left, right) =>
          (stateScores.get(right) ?? 0) - (stateScores.get(left) ?? 0) || left - right
        )
        .slice(0, SEMANTIC_STATES_PER_TRAJECTORY));
    }
  }
  const candidateStateIds = [...new Set([
    ...semanticCandidateStateIds,
    ...lexicalCandidateStateIds,
  ])].slice(0, CANDIDATE_LIMIT);
  const candidateIds = candidateStateIds.flatMap((stateId) => states[stateId].documentIds);
  const candidateIdSet = new Set(candidateIds);
  const chunkScores = new Map();
  const averageDocumentLength = totalDocumentWords / Math.max(1, documents.length);
  for (const word of queryWords) {
    const posting = wordPostings.get(word) ?? [];
    const inverseDocumentFrequency = Math.log((documents.length + 1) / (posting.length + 1)) + 1;
    for (const documentId of posting) {
      if (!candidateIdSet.has(documentId)) continue;
      const frequency = documents[documentId].frequencies.get(word) ?? 1;
      chunkScores.set(
        documentId,
        (chunkScores.get(documentId) ?? 0) + bm25Term(
          frequency,
          documents[documentId].wordCount,
          averageDocumentLength,
          inverseDocumentFrequency
        )
      );
    }
  }
  const candidateClauses = candidateIds.map((documentId) => documents[documentId].clause);
  const candidateSources = new Map(candidateIds.map((documentId) => {
    const document = documents[documentId];
    return [canonicalKey(document.clause), [document.source]];
  }));
  if (candidateClauses.length === 0) {
    return {
      items: [],
      metadata: {
        route: 'remembero-local-source-search',
        indexedStateChunks: documents.length,
        indexedStates: states.length,
        shortlistCandidates: 0,
        totalCandidates: 0,
        returnedCount: 0,
        topScore: 0,
        topSelectionScore: 0,
        modelCalls: 0,
        embeddingCalls: semanticUsage.calls,
        semantic: semanticMetadata(),
      },
    };
  }
  const result = searchKnowledge(candidateClauses, query, candidateSources, {
    limit: Math.min(100, candidateClauses.length),
    minimumScore: 1,
    kinds: ['fact'],
    sourceCharacterLimit: sourceCharacters,
  });
  const localScores = new Map();
  for (const entry of result.results) {
    const source = entry.sources[0];
    if (source === undefined) continue;
    const documentId = documentIdByOpId.get(source.opId);
    if (documentId === undefined) continue;
    localScores.set(documentId, entry.score);
  }
  const rankedStates = candidateStateIds
    .map((stateId) => {
      const state = states[stateId];
      const chunkRanks = state.documentIds
        .map((documentId) => ({
          documentId,
          localScore: localScores.get(documentId) ?? 0,
          chunkScore: chunkScores.get(documentId) ?? 0,
        }))
        .sort((left, right) =>
          right.localScore + 20 * right.chunkScore -
            (left.localScore + 20 * left.chunkScore) ||
          left.documentId - right.documentId
        );
      const bestLocalScore = chunkRanks[0]?.localScore ?? 0;
      const semanticScore = semanticConfig.level === 'state'
        ? semanticScores.get(stateId) ?? 0
        : semanticScores.get(state.trajectoryId) ?? 0;
      const selectionScore = bestLocalScore +
        20 * (stateScores.get(stateId) ?? 0) +
        SEMANTIC_SELECTION_WEIGHT * semanticScore;
      return { stateId, state, chunkRanks, bestLocalScore, selectionScore };
    })
    .sort((left, right) =>
      right.selectionScore - left.selectionScore || left.stateId - right.stateId
    );
  const selectedStates = [];
  const statesPerTrajectory = new Map();
  for (const ranked of rankedStates) {
    const trajectoryId = ranked.state.opId.split(':', 1)[0];
    const count = statesPerTrajectory.get(trajectoryId) ?? 0;
    if (count >= MAX_STATES_PER_TRAJECTORY) continue;
    selectedStates.push(ranked);
    statesPerTrajectory.set(trajectoryId, count + 1);
    if (selectedStates.length >= topK) break;
  }
  const items = selectedStates.map(({ state, chunkRanks, bestLocalScore, selectionScore }) => {
    const selectedText = chunkRanks
      .slice(0, CHUNKS_PER_RETURNED_STATE)
      .map(({ documentId }) => documents[documentId].source.text)
      .join('\n\n')
      .slice(0, contextCharacters);
    return {
      type: 'text',
      value: [
        `Source state: ${state.opId}`,
        `Local score: ${bestLocalScore}`,
        `Selection score: ${selectionScore.toFixed(3)}`,
        selectedText,
      ].join('\n'),
    };
  });
  return {
    items,
    metadata: {
      route: 'remembero-local-source-search',
      indexedStateChunks: documents.length,
      indexedStates: states.length,
      shortlistStates: candidateStateIds.length,
      shortlistCandidates: candidateClauses.length,
      totalCandidates: result.totalCandidates,
      returnedCount: items.length,
      topScore: selectedStates[0]?.bestLocalScore ?? 0,
      topSelectionScore: selectedStates[0]?.selectionScore ?? 0,
      modelCalls: 0,
      embeddingCalls: semanticUsage.calls,
      semantic: semanticMetadata(),
    },
  };
}

async function command(message) {
  requireValue(message && typeof message === 'object', 'command must be an object');
  const sourceCharacters = message.sourceCharacters ?? DEFAULT_SOURCE_CHARACTERS;
  const contextCharacters = message.contextCharacters ?? DEFAULT_CONTEXT_CHARACTERS;
  const topK = message.topK ?? DEFAULT_TOP_K;
  if (message.op === 'configure') return configureSemantic(message.semantic);
  if (message.op === 'insert') {
    const result = insertTrajectory(message.trajectory, sourceCharacters);
    if (
      semanticConfig.enabled &&
      semanticConfig.prepareAfterInserts > 0 &&
      trajectoryCount >= semanticConfig.prepareAfterInserts
    ) {
      await ensureSemanticIndex();
    }
    return result;
  }
  if (message.op === 'query') {
    return queryMemory(message.query, topK, sourceCharacters, contextCharacters);
  }
  if (message.op === 'stats') return { trajectoryCount, stateCount };
  if (message.op === 'close') return { closing: true };
  throw new Error(`unknown operation: ${message.op}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let closing = false;
  try {
    const message = JSON.parse(line);
    const result = await command(message);
    closing = message.op === 'close';
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
  }
  if (closing) break;
}
