import { describe, expect, it } from 'vitest';
import { validTimeModeFromEnv } from '../src/env.js';

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
