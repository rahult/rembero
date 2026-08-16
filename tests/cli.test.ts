import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_INPUT_BYTES,
  assertBoundedOutput,
  stringifyBoundedResult,
} from '../src/safety.js';

describe('CLI ingress limits', () => {
  it('fails closed before returning an oversized JSON result', () => {
    expect(() => stringifyBoundedResult({ value: 'oversized' }, 'test result', 8)).toThrow(
      /test result exceeds 8 bytes/i
    );
  });

  it('fails closed before printing an oversized plain-text recall answer', () => {
    expect(() => assertBoundedOutput('oversized', 'CLI recall answer', 8)).toThrow(
      /CLI recall answer exceeds 8 bytes/i
    );
  });
  it('rejects an oversized import before reading or mutating the store', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-limit-'));
    const file = join(root, 'oversized.dl');
    const home = join(root, 'home');
    writeFileSync(file, 'x'.repeat(MAX_INPUT_BYTES + 1));

    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'import', 'default', file],
      {
        encoding: 'utf8',
        env: { ...process.env, REMBERO_HOME: home },
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/import file exceeds 65536 bytes/i);
    expect(existsSync(join(home, 'memory', 'default.dl'))).toBe(false);
  });
});
