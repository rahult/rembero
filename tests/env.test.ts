import { describe, expect, it } from 'vitest';
import {
  recallSchemaPredicateLimitFromEnv,
  validTimeModeFromEnv,
} from '../src/env.js';
import {
  DEFAULT_RECALL_SCHEMA_PREDICATES,
  MAX_RECALL_SCHEMA_PREDICATES,
} from '../src/llm/schema.js';

describe('validTimeModeFromEnv', () => {
  it('defaults to deletion and accepts only the two documented modes', () => {
    expect(validTimeModeFromEnv({})).toBe('delete');
    expect(validTimeModeFromEnv({ REMBERO_VALID_TIME_MODE: 'delete' })).toBe('delete');
    expect(validTimeModeFromEnv({ REMBERO_VALID_TIME_MODE: 'archive_until' })).toBe(
      'archive_until'
    );
  });

  it('fails closed on an unknown mode', () => {
    expect(() => validTimeModeFromEnv({ REMBERO_VALID_TIME_MODE: 'archive' })).toThrow(
      /must be 'delete' or 'archive_until'/i
    );
  });
});

describe('recallSchemaPredicateLimitFromEnv', () => {
  it('uses the bounded default and accepts an explicit limit', () => {
    expect(recallSchemaPredicateLimitFromEnv({})).toBe(
      DEFAULT_RECALL_SCHEMA_PREDICATES
    );
    expect(
      recallSchemaPredicateLimitFromEnv({
        REMBERO_RECALL_SCHEMA_PREDICATE_LIMIT: '48',
      })
    ).toBe(48);
  });

  it('fails closed on malformed and out-of-range values', () => {
    for (const value of ['0', '-1', '1.5', 'many', String(MAX_RECALL_SCHEMA_PREDICATES + 1)]) {
      expect(() =>
        recallSchemaPredicateLimitFromEnv({
          REMBERO_RECALL_SCHEMA_PREDICATE_LIMIT: value,
        })
      ).toThrow(/REMBERO_RECALL_SCHEMA_PREDICATE_LIMIT/);
    }
  });
});
