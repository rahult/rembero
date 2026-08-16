export * from './engine/index.js';
export {
  MemoryStore,
  defaultRoot,
  type AssertResult,
  type MemorySource,
  type MutationContext,
  type AutoCaptureBatch,
  type AutoCaptureFact,
  type AutoCaptureReview,
  type AutoCaptureReviewOptions,
  type AutoCaptureReservation,
  type AutoCaptureReservationRequest,
  type AutoCaptureStatus,
  type PruneAutoCaptureOptions,
} from './store/store.js';
export {
  DatalogDatabase,
  buildSqliteExtension,
  openDatalogDatabase,
  resolveSqliteExtensionPath,
  type DatalogRow,
  type DatalogExplanation,
  type DatalogProof,
  type OpenDatalogDatabaseOptions,
} from './sqlite/extension.js';
export {
  type ChatMessage,
  type LlmClient,
  type LlmConfig,
  DEFAULT_MODEL,
  OpenRouterClient,
  clientFromEnv,
  lazyClientFromEnv,
} from './llm/client.js';
export {
  type PipelineDeps,
  type RecallOptions,
  type RecallResult,
  type RememberResult,
  type RememberTranscriptOptions,
  type RetrievalResult,
  recallQuestion,
  rememberTranscriptText,
  rememberText,
  retrieveQuestion,
} from './llm/pipeline.js';
export {
  type QueryPromptVariant,
  transcriptExtractionSystemPrompt,
} from './llm/prompts.js';
export {
  autoCaptureClaudeStop,
  type AutoCaptureDeps,
  type AutoCaptureOptions,
  type AutoCaptureResult,
} from './autocapture/capture.js';
export {
  DEFAULT_AUTO_CAPTURE_DAILY_CAP,
  MANAGED_HOOK_MARKER,
  MAX_AUTO_CAPTURE_DAILY_CAP,
  defaultClaudeSettingsPath,
  installClaudeHook,
  removeClaudeHook,
  validateAutoCaptureDailyCap,
  validateAutoCaptureTailBytes,
  type HookChangeResult,
  type InstallClaudeHookOptions,
  type RemoveClaudeHookOptions,
} from './autocapture/hooks.js';
export {
  DEFAULT_TRANSCRIPT_TAIL_BYTES,
  MAX_TRANSCRIPT_TAIL_BYTES,
  defaultClaudeConfigDir,
  parseClaudeStopHookInput,
  readClaudeTranscriptTail,
  type ClaudeStopHookInput,
  type ClaudeTranscriptTail,
  type TranscriptReadOptions,
} from './autocapture/transcript.js';
export { createServer, serveStdio } from './mcp/server.js';
export {
  type AbsenceGraphNode,
  type AggregateGraphNode,
  buildExplanationGraph,
  explainKnowledge,
  type ClaimGraphNode,
  type EntityGraphNode,
  type ExplainKnowledgeResult,
  type ExplainedKnowledgeRow,
  type ExplanationGraph,
  type ExplanationGraphEdge,
  type ExplanationGraphNode,
  type ExplanationRule,
  type ResultGraphNode,
  type SourcedDerivationProof,
  type SourcedAbsenceProof,
  type SourcedAggregateProof,
  type SourcedProofStep,
  type SourcedQueryProof,
} from './knowledge/graph.js';
