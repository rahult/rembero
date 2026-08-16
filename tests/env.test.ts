import { describe, expect, it } from 'vitest';
import {
  entityIdentityFromEnv,
  integrityEnforcementFromEnv,
  recallSchemaPredicateLimitFromEnv,
  validTimeModeFromEnv,
} from '../src/env.js';
import {
  DEFAULT_RECALL_SCHEMA_PREDICATES,
  MAX_RECALL_SCHEMA_PREDICATES,
} from '../src/llm/schema.js';

describe('entityIdentityFromEnv', () => {
  it('is off by default and accepts the explicit canonical projection', () => {
    expect(entityIdentityFromEnv({})).toBeUndefined();
    expect(entityIdentityFromEnv({ REMBERO_ENTITY_IDENTITY: 'off' })).toBeUndefined();
    expect(entityIdentityFromEnv({ REMBERO_ENTITY_IDENTITY: 'canonical' })).toBe(
      'canonical'
    );
  });

  it('fails closed on an unknown identity mode', () => {
    expect(() =>
      entityIdentityFromEnv({ REMBERO_ENTITY_IDENTITY: 'global' })
    ).toThrow(/must be 'off' or 'canonical'/i);
  });
});

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

describe('integrityEnforcementFromEnv', () => {
  it('defaults to audit-only and parses both enforcement modes', () => {
    expect(integrityEnforcementFromEnv({})).toBeUndefined();
    expect(
      integrityEnforcementFromEnv({ REMBERO_INTEGRITY_MODE: 'strict' })
    ).toEqual({ mode: 'strict' });
    expect(
      integrityEnforcementFromEnv({
        REMBERO_INTEGRITY_MODE: 'no_new_violations',
        REMBERO_INTEGRITY_NAMESPACES: 'policy,work',
      })
    ).toEqual({
      mode: 'no_new_violations',
      namespaces: ['policy', 'work'],
    });
    expect(
      integrityEnforcementFromEnv({
        REMBERO_INTEGRITY_MODE: 'strict',
        REMBERO_INTEGRITY_NAMESPACES: '*',
      })
    ).toEqual({ mode: 'strict', namespaces: '*' });
  });

  it('rejects invalid modes and namespace lists', () => {
    expect(() =>
      integrityEnforcementFromEnv({ REMBERO_INTEGRITY_MODE: 'warn' })
    ).toThrow(/must be 'off', 'strict', or 'no_new_violations'/i);
    expect(() =>
      integrityEnforcementFromEnv({
        REMBERO_INTEGRITY_MODE: 'strict',
        REMBERO_INTEGRITY_NAMESPACES: 'policy,,work',
      })
    ).toThrow(/comma-separated namespace list/i);
  });
});
