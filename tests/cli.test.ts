import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_INPUT_BYTES,
  assertBoundedOutput,
  stringifyBoundedResult,
} from '../src/safety.js';
import { MemoryStore } from '../src/store/store.js';
import { serializeClause } from '../src/engine/index.js';

describe('CLI ingress limits', () => {
  it('fails closed before returning an oversized JSON result', () => {
    expect(() => stringifyBoundedResult({ value: 'oversized' }, 'test result', 8)).toThrow(
      /test result exceeds 8 bytes/i
    );
  });

  it('rejects non-finite numbers instead of silently serializing them as null', () => {
    expect(() => stringifyBoundedResult({ value: Number.NaN }, 'test result')).toThrow(
      /non-finite/i
    );
    expect(() =>
      stringifyBoundedResult({ value: Number.POSITIVE_INFINITY }, 'test result')
    ).toThrow(/non-finite/i);
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

  it('validates the recall schema limit before any external request', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-schema-limit-'));
    const result = spawnSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'recall',
        'What is remembered?',
        '--schema-predicate-limit',
        '0',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          REMBERO_HOME: join(root, 'home'),
          LLM_API_KEY: 'test-only-key',
          REMBERO_RECALL_SCHEMA_PREDICATE_LIMIT: '32',
        },
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/schema predicate limit must be from 1 to 256/i);
  });

  it('prints the explicit recall status when memory is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-recall-status-'));
    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'recall', 'What is remembered?'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          REMBERO_HOME: join(root, 'home'),
          LLM_API_KEY: 'test-only-key',
          REMBERO_RECALL_SCHEMA_PREDICATE_LIMIT: '32',
        },
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status: unanswerable');
  });
});

describe('auto-capture CLI', () => {
  it('fails closed when a settings option is missing its path', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-hooks-missing-'));
    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'init-hooks', '--settings'],
      {
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_CONFIG_DIR: root },
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--settings requires a value');
    expect(existsSync(join(root, 'settings.json'))).toBe(false);
  });

  it('installs and removes only its managed Claude hook', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-hooks-'));
    const settingsPath = join(root, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing' }] }] } }),
      'utf8'
    );

    const install = spawnSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'init-hooks',
        '--settings',
        settingsPath,
        '--namespace',
        'personal',
        '--daily-cap',
        '3',
        '--tail-bytes',
        '8192',
      ],
      { encoding: 'utf8', env: { ...process.env } }
    );
    expect(install.status).toBe(0);
    expect(install.stdout).toContain('installed Rembero Claude hook');
    const installed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const handlers = installed.hooks.Stop.flatMap(
      (group: { hooks: Record<string, unknown>[] }) => group.hooks
    );
    expect(handlers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: 'existing' }),
        expect.objectContaining({
          type: 'command',
          async: true,
          args: expect.arrayContaining(['remember', '--batch', 'personal']),
        }),
      ])
    );

    const remove = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'init-hooks', '--remove', '--settings', settingsPath],
      { encoding: 'utf8', env: { ...process.env } }
    );
    expect(remove.status).toBe(0);
    const removed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(removed.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'existing' }] },
    ]);
  });

  it('lists and prunes numbered auto-captured facts end to end', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-review-'));
    const home = join(root, 'home');
    const store = new MemoryStore(join(home, 'memory'));
    const captureId = 'capture-review-cli';
    const opId = 'operation-review-cli';
    const now = new Date();
    store.note('personal', 'auto_capture', {
      captureId,
      status: 'started',
      source: 'claude-stop',
      sessionId: 'session-review-cli',
    }, now);
    store.assert('personal', 'prefers_theme(user, dark).', {
      captureId,
      opId,
      origin: 'claude-stop',
      sourceText: 'Auto-captured from a Claude Code Stop hook',
      at: now,
    });
    store.finishAutoCapture('personal', captureId, 'captured', { added: 1 }, now);

    const review = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'review', '--namespace', 'personal', '--json'],
      {
        encoding: 'utf8',
        env: { ...process.env, REMBERO_HOME: home },
      }
    );
    expect(review.status).toBe(0);
    expect(JSON.parse(review.stdout).facts).toEqual([
      expect.objectContaining({
        clause: 'prefers_theme(user, dark).',
        current: true,
      }),
    ]);

    const prune = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'review', '--namespace', 'personal', '--forget', '1'],
      {
        encoding: 'utf8',
        env: { ...process.env, REMBERO_HOME: home },
      }
    );
    expect(prune.status).toBe(0);
    expect(prune.stdout).toContain('removed 1 auto-captured fact');
    expect(store.load('personal').map(serializeClause)).toEqual([]);
  });

  it('prints temporal history as JSON with deterministic event ordering', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-history-'));
    const home = join(root, 'home');
    const store = new MemoryStore(join(home, 'memory')) as MemoryStore & {
      supersede: (
        namespace: string,
        patterns: string[],
        replacements: string,
        context?: Record<string, unknown>
      ) => unknown;
    };

    store.assert('personal', 'works_at(mira, acme).', {
      opId: 'source-1',
      sourceText: 'Mira works at Acme.',
      at: new Date('2026-08-10T09:00:00.000Z'),
    });
    store.supersede('personal', ['works_at(mira, _)'], 'works_at(mira, initech).', {
      opId: 'source-2',
      sourceText: 'Mira now works at Initech.',
      at: new Date('2026-08-16T16:59:00.000Z'),
    });

    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'history', 'works_at(mira, _)', '--namespace', 'personal', '--json'],
      {
        encoding: 'utf8',
        env: { ...process.env, REMBERO_HOME: home },
      }
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      pattern: 'works_at(mira, _)',
      namespaces: ['personal'],
      events: [
        expect.objectContaining({
          sequence: 1,
          position: 0,
          action: 'asserted',
          clause: 'works_at(mira, acme).',
        }),
        expect.objectContaining({
          sequence: 2,
          position: 0,
          action: 'superseded',
          clause: 'works_at(mira, acme).',
          archivedAs: "works_at_until(mira, acme, '2026-08-16T16:59:00.000Z').",
          validUntil: '2026-08-16T16:59:00.000Z',
        }),
        expect.objectContaining({
          sequence: 2,
          position: 2,
          action: 'asserted',
          clause: 'works_at(mira, initech).',
          current: true,
        }),
      ],
    });
  });
});
