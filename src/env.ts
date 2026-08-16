import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import {
  DEFAULT_RECALL_SCHEMA_PREDICATES,
  MAX_RECALL_SCHEMA_PREDICATES,
} from './llm/schema.js';
import type { ValidTimeMode } from './store/store.js';
import type { IntegrityEnforcementOptions } from './knowledge/enforcement.js';
import type { EntityIdentityMode } from './knowledge/identity.js';

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

export function integrityEnforcementFromEnv(
  env: NodeJS.ProcessEnv = process.env
): IntegrityEnforcementOptions | undefined {
  const mode = env.REMBERO_INTEGRITY_MODE ?? 'off';
  if (mode === 'off') return undefined;
  if (mode !== 'strict' && mode !== 'no_new_violations') {
    throw new Error(
      "REMBERO_INTEGRITY_MODE must be 'off', 'strict', or 'no_new_violations'"
    );
  }
  const configuredNamespaces = env.REMBERO_INTEGRITY_NAMESPACES;
  if (configuredNamespaces === undefined) return { mode };
  if (configuredNamespaces === '*') return { mode, namespaces: '*' };
  const namespaces = configuredNamespaces.split(',').map((value) => value.trim());
  if (namespaces.some((value) => value.length === 0)) {
    throw new Error(
      "REMBERO_INTEGRITY_NAMESPACES must be '*' or a comma-separated namespace list"
    );
  }
  return { mode, namespaces };
}

export function entityIdentityFromEnv(
  env: NodeJS.ProcessEnv = process.env
): EntityIdentityMode | undefined {
  const configured = env.REMBERO_ENTITY_IDENTITY ?? 'off';
  if (configured === 'off') return undefined;
  if (configured === 'canonical') return configured;
  throw new Error("REMBERO_ENTITY_IDENTITY must be 'off' or 'canonical'");
}
