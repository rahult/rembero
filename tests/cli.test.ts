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

  it('rejects an invalid proof limit before evaluating an explanation', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-proof-limit-'));
    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'explain', 'answer(a)', '--proof-limit', '17'],
      {
        encoding: 'utf8',
        env: { ...process.env, REMBERO_HOME: join(root, 'home') },
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/proof limit must be from 1 to 16/i);
  });

  it('prints alternative proof witnesses through the explain command', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-proofs-'));
    const home = join(root, 'home');
    const store = new MemoryStore(join(home, 'memory'));
    store.assert(
      'default',
      'left(a). right(a). answer(X) :- left(X). answer(X) :- right(X).'
    );

    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'explain', 'answer(a)', '--proof-limit', '2'],
      { encoding: 'utf8', env: { ...process.env, REMBERO_HOME: home } }
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.rows[0]).toMatchObject({
      proofs: [expect.objectContaining({ rule: 1 })],
      alternativeProofs: [[expect.objectContaining({ rule: 2 })]],
    });
  });

  it('replays explicit write operation ids and reports deterministic conflicts', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-op-id-'));
    const home = join(root, 'home');
    const runAssert = (clause: string) =>
      spawnSync(
        process.execPath,
        [resolve('dist/cli.js'), 'assert', clause, '--op-id', 'cli-assert-retry'],
        { encoding: 'utf8', env: { ...process.env, REMBERO_HOME: home } }
      );

    const first = runAssert('retry_fact(alpha).');
    const replay = runAssert('retry_fact(alpha).');
    const conflict = runAssert('retry_fact(beta).');

    expect(first.status).toBe(0);
    expect(replay.status).toBe(0);
    expect(JSON.parse(replay.stdout)).toEqual(JSON.parse(first.stdout));
    expect(conflict.status).toBe(4);
    expect(JSON.parse(conflict.stderr)).toEqual({
      error: 'operation_conflict',
      message: "assert operation 'cli-assert-retry' was already used for another mutation",
      operation: 'assert',
      namespace: 'default',
      opId: 'cli-assert-retry',
    });

    const firstForget = spawnSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'forget',
        'retry_fact(_)',
        '--op-id',
        'cli-forget-retry',
      ],
      { encoding: 'utf8', env: { ...process.env, REMBERO_HOME: home } }
    );
    const replayForget = spawnSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'forget',
        'retry_fact( _ )',
        '--op-id',
        'cli-forget-retry',
      ],
      { encoding: 'utf8', env: { ...process.env, REMBERO_HOME: home } }
    );
    expect(firstForget.status).toBe(0);
    expect(replayForget.status).toBe(0);
    expect(firstForget.stdout).toBe('removed 1 clause(s)\n');
    expect(replayForget.stdout).toBe(firstForget.stdout);
  });

  it('supersedes multiple fact patterns with exact valid-time archives and safe retries', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-supersede-'));
    const home = join(root, 'home');
    const store = new MemoryStore(join(home, 'memory'));
    store.assert('personal', 'works_at(mira, acme). title(mira, engineer).', {
      opId: 'prior-employment',
    });
    const run = (replacement: string, at = '2026-08-16T16:59:00.000Z') =>
      spawnSync(
        process.execPath,
        [
          resolve('dist/cli.js'),
          'supersede',
          replacement,
          '--namespace',
          'personal',
          '--pattern',
          'works_at(mira, _)',
          '--pattern',
          'title(mira, _)',
          '--at',
          at,
          '--op-id',
          'cli-employment-correction',
        ],
        { encoding: 'utf8', env: { ...process.env, REMBERO_HOME: home } }
      );

    const first = run('works_at(mira, initech). title(mira, lead).');
    const replay = run('works_at(mira, initech). title(mira, lead).');
    const conflict = run('works_at(mira, other). title(mira, lead).');

    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({
      added: ['works_at(mira, initech).', 'title(mira, lead).'],
      duplicates: 0,
      retracted: 2,
      archived: [
        "works_at_until(mira, acme, '2026-08-16T16:59:00.000Z').",
        "title_until(mira, engineer, '2026-08-16T16:59:00.000Z').",
      ],
      opId: 'cli-employment-correction',
    });
    expect(replay.status).toBe(0);
    expect(replay.stdout).toBe(first.stdout);
    expect(conflict.status).toBe(4);
    expect(JSON.parse(conflict.stderr)).toMatchObject({
      error: 'operation_conflict',
      operation: 'supersede',
      namespace: 'personal',
      opId: 'cli-employment-correction',
    });
    expect(new MemoryStore(join(home, 'memory')).load('personal').map(serializeClause).sort())
      .toEqual([
        'title(mira, lead).',
        "title_until(mira, engineer, '2026-08-16T16:59:00.000Z').",
        'works_at(mira, initech).',
        "works_at_until(mira, acme, '2026-08-16T16:59:00.000Z').",
      ].sort());

    new MemoryStore(join(home, 'memory')).assert(
      'personal',
      'temporary_assignment(mira, atlas).'
    );
    const ended = spawnSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'supersede',
        '--namespace',
        'personal',
        '--pattern',
        'temporary_assignment(mira, _)',
        '--at',
        '2026-08-17T00:00:00.000Z',
        '--op-id',
        'cli-assignment-ended',
      ],
      { encoding: 'utf8', env: { ...process.env, REMBERO_HOME: home } }
    );
    expect(ended.status).toBe(0);
    expect(JSON.parse(ended.stdout)).toEqual({
      added: [],
      duplicates: 0,
      retracted: 1,
      archived: [
        "temporary_assignment_until(mira, atlas, '2026-08-17T00:00:00.000Z').",
      ],
      opId: 'cli-assignment-ended',
    });
  });

  it('requires supersede patterns and a canonical UTC timestamp', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-supersede-invalid-'));
    const home = join(root, 'home');
    new MemoryStore(join(home, 'memory')).assert('default', 'status(mira, active).');
    const run = (extra: string[]) =>
      spawnSync(
        process.execPath,
        [resolve('dist/cli.js'), 'supersede', 'status(mira, paused).', ...extra],
        { encoding: 'utf8', env: { ...process.env, REMBERO_HOME: home } }
      );

    const noPattern = run([]);
    expect(noPattern.status).toBe(1);
    expect(noPattern.stderr).toMatch(/requires at least one fact pattern/i);
    const invalidAt = run([
      '--pattern',
      'status(mira, _)',
      '--at',
      '2026-08-16 16:59:00',
    ]);
    expect(invalidAt.status).toBe(1);
    expect(invalidAt.stderr).toMatch(/canonical UTC timestamp/i);
    const destructiveMode = run([
      '--pattern',
      'status(mira, _)',
      '--valid-time-mode',
      'delete',
    ]);
    expect(destructiveMode.status).toBe(1);
    expect(destructiveMode.stderr).toMatch(/always preserves _until history/i);
    expect(new MemoryStore(join(home, 'memory')).load('default').map(serializeClause)).toEqual([
      'status(mira, active).',
    ]);
  });

  it('rejects operation ids on commands without idempotent write semantics', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-op-id-command-'));
    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'query', 'f(X)', '--op-id', 'unsupported'],
      {
        encoding: 'utf8',
        env: { ...process.env, REMBERO_HOME: join(root, 'home') },
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /--op-id is available for assert, supersede, forget, and import/i
    );
  });

  it('queries an exact recorded snapshot without changing current knowledge', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-recorded-'));
    const home = join(root, 'home');
    const store = new MemoryStore(join(home, 'memory'));
    store.assert('default', 'status(mira, active).', { opId: 'before' });
    store.replace('default', ['status(mira, _)'], 'status(mira, paused).', {
      opId: 'after',
    });

    const result = spawnSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'query',
        'status(mira, State)',
        '--as-of-sequence',
        '1',
      ],
      { encoding: 'utf8', env: { ...process.env, REMBERO_HOME: home } }
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      bindings: [{ State: 'active' }],
      recordedSnapshot: {
        sequence: 1,
        journalEntries: 2,
        namespaces: ['default'],
      },
    });
    expect(store.load('default').map(serializeClause)).toEqual(['status(mira, paused).']);
  });

  it('exports one complete result support graph without changing query rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-graph-select-'));
    const home = join(root, 'home');
    const store = new MemoryStore(join(home, 'memory'));
    store.assert(
      'default',
      `parent(alice, bob). parent(bob, carol). parent(carol, dan).
       ancestor(X, Y) :- parent(X, Y).
       ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).`
    );

    const result = spawnSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'explain',
        'ancestor(alice, Descendant)',
        '--graph-result',
        '2',
      ],
      { encoding: 'utf8', env: { ...process.env, REMBERO_HOME: home } }
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.rows.map((row: { bindings: Record<string, string> }) => row.bindings)).toEqual([
      { Descendant: 'bob' },
      { Descendant: 'carol' },
      { Descendant: 'dan' },
    ]);
    expect(payload.graphSelection).toMatchObject({
      selector: { kind: 'result', row: 2 },
    });
    expect(payload.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'claim', predicate: 'parent', values: ['bob', 'carol'] }),
      ])
    );
    expect(payload.graph.nodes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'claim', predicate: 'parent', values: ['carol', 'dan'] }),
      ])
    );
  });

  it('rejects ambiguous graph selectors before evaluating a query', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-graph-invalid-'));
    const result = spawnSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'explain',
        'answer(a)',
        '--graph-result',
        '1',
        '--graph-support',
        'claim:answer',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, REMBERO_HOME: join(root, 'home') },
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/mutually exclusive/i);
  });

  it('keeps literal queries unchanged and enables explicit canonical identity reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-identity-'));
    const home = join(root, 'home');
    const store = new MemoryStore(join(home, 'memory'));
    store.assert(
      'default',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(works_at, 2, 0).
       works_at('Mira Patel', acme).`
    );

    const literal = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'query', 'works_at(mira, Company)'],
      { encoding: 'utf8', env: { ...process.env, REMBERO_HOME: home } }
    );
    const canonical = spawnSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'query',
        'works_at(mira, Company)',
        '--entity-identity',
        'canonical',
      ],
      { encoding: 'utf8', env: { ...process.env, REMBERO_HOME: home } }
    );

    expect(literal.status).toBe(0);
    expect(JSON.parse(literal.stdout)).toEqual([]);
    expect(canonical.status).toBe(0);
    expect(JSON.parse(canonical.stdout)).toEqual([{ Company: 'acme' }]);
  });

  it('checks explicit integrity constraints and exits 2 when violations exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-integrity-'));
    const home = join(root, 'home');
    const asserted = spawnSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'assert',
        'status(mira, active). status(mira, terminated). :- status(Person, active), status(Person, terminated).',
      ],
      { encoding: 'utf8', env: { ...process.env, REMBERO_HOME: home } }
    );
    expect(asserted.status).toBe(0);
    expect(JSON.parse(asserted.stdout).added).toHaveLength(3);

    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'check', '--max-violations', '10'],
      { encoding: 'utf8', env: { ...process.env, REMBERO_HOME: home } }
    );

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'violations',
      constraintCount: 1,
      violationCount: 1,
      checks: [{ rows: [{ bindings: { Person: 'mira' } }] }],
    });
  });

  it('returns zero for a consistent constrained knowledge base', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-integrity-clean-'));
    const home = join(root, 'home');
    const store = new MemoryStore(join(home, 'memory'));
    store.assert(
      'default',
      'status(mira, active). :- status(Person, active), status(Person, terminated).'
    );

    const result = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'check'],
      { encoding: 'utf8', env: { ...process.env, REMBERO_HOME: home } }
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'consistent',
      violationCount: 0,
    });
  });

  it('rejects a violating write atomically with structured evidence and exit 3', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-enforcement-'));
    const home = join(root, 'home');
    const store = new MemoryStore(join(home, 'memory'));
    store.assert(
      'default',
      'active(mira). :- active(Person), suspended(Person).'
    );
    const before = readFileSync(join(home, 'memory', 'default.dl'), 'utf8');

    const result = spawnSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'assert',
        'suspended(mira).',
        '--integrity-mode',
        'strict',
      ],
      { encoding: 'utf8', env: { ...process.env, REMBERO_HOME: home } }
    );

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: 'integrity_violation',
      mode: 'strict',
      introducedViolationCount: 1,
      candidate: {
        checks: [{ rows: [{ bindings: { Person: 'mira' } }] }],
      },
    });
    expect(readFileSync(join(home, 'memory', 'default.dl'), 'utf8')).toBe(before);
  });

  it('supports migration-friendly no-new-violations enforcement from the environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-cli-enforcement-migrate-'));
    const home = join(root, 'home');
    const store = new MemoryStore(join(home, 'memory'));
    store.assert(
      'default',
      `active(mira). suspended(mira).
       :- active(Person), suspended(Person).`
    );
    const env = {
      ...process.env,
      REMBERO_HOME: home,
      REMBERO_INTEGRITY_MODE: 'no_new_violations',
    };

    const unrelated = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'assert', 'project(atlas).'],
      { encoding: 'utf8', env }
    );
    expect(unrelated.status).toBe(0);

    const newViolation = spawnSync(
      process.execPath,
      [resolve('dist/cli.js'), 'assert', 'active(alex). suspended(alex).'],
      { encoding: 'utf8', env }
    );
    expect(newViolation.status).toBe(3);
    expect(JSON.parse(newViolation.stderr)).toMatchObject({
      mode: 'no_new_violations',
      baselineViolationCount: 1,
      introducedViolationCount: 1,
    });
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
