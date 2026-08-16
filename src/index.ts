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
  type RecallResult,
  type RememberResult,
  recallQuestion,
  rememberText,
} from './llm/pipeline.js';
export { createServer, serveStdio } from './mcp/server.js';
