#!/usr/bin/env node
import { resolve } from 'node:path';
import { embeddingClientFromEnv } from '../llm/embeddings.js';
import { loadLongMemEvalS } from './longmemeval.js';
import { runLongMemEvalSemanticPolicy } from './longmemeval-semantic.js';

const data = resolve(
  process.argv[2] ?? '.cache/longmemeval/longmemeval_s_cleaned.json'
);
const loaded = await loadLongMemEvalS(data);
const embeddings = embeddingClientFromEnv();
const development = await runLongMemEvalSemanticPolicy(
  loaded.instances,
  embeddings,
  'dev'
);
const heldOut = await runLongMemEvalSemanticPolicy(
  loaded.instances,
  embeddings,
  'test'
);
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  datasetSha256: loaded.sha256,
  development,
  heldOut,
}, null, 2));
