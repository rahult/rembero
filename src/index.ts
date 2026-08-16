export * from './engine/index.js';
export { MemoryStore, defaultRoot, type AssertResult } from './store/store.js';
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
  type RetrievalResult,
  recallQuestion,
  rememberText,
  retrieveQuestion,
} from './llm/pipeline.js';
export { type QueryPromptVariant } from './llm/prompts.js';
export { createServer, serveStdio } from './mcp/server.js';
