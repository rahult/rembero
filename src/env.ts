import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import {
  DEFAULT_RECALL_SCHEMA_PREDICATES,
  MAX_RECALL_SCHEMA_PREDICATES,
} from './llm/schema.js';
import type { ValidTimeMode } from './store/store.js';

/**
 * Load .env from the current directory and from the package root (so the CLI
 * works no matter where it is launched from). Existing env vars win.
 */
export function loadEnv(): void {
  const candidates = [
    join(process.cwd(), '.env'),
    join(dirname(fileURLToPath(import.meta.url)), '..', '.env'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) config({ path, quiet: true });
  }
}

export function validTimeModeFromEnv(env: NodeJS.ProcessEnv = process.env): ValidTimeMode {
  const configured = env.REMBERO_VALID_TIME_MODE ?? 'delete';
  if (configured === 'delete' || configured === 'archive_until') return configured;
  throw new Error("REMBERO_VALID_TIME_MODE must be 'delete' or 'archive_until'");
}

export function recallSchemaPredicateLimitFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number {
  const configured = env.REMBERO_RECALL_SCHEMA_PREDICATE_LIMIT;
  if (configured === undefined) return DEFAULT_RECALL_SCHEMA_PREDICATES;
  if (!/^\d+$/.test(configured)) {
    throw new Error('REMBERO_RECALL_SCHEMA_PREDICATE_LIMIT must be an integer');
  }
  const parsed = Number(configured);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_RECALL_SCHEMA_PREDICATES
  ) {
    throw new Error(
      `REMBERO_RECALL_SCHEMA_PREDICATE_LIMIT must be from 1 to ${MAX_RECALL_SCHEMA_PREDICATES}`
    );
  }
  return parsed;
}
