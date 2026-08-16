import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeClause, type Clause } from '../src/engine/index.js';
import { MemoryStore } from '../src/store/store.js';

type V6Store = MemoryStore & {
  supersede: (
    namespace: string,
    patterns: string[],
    replacements: string | Clause[],
    context?: Record<string, unknown>
  ) => {
    added: Clause[];
    duplicates: number;
    retracted: number;
    archived: Clause[];
    opId: string;
  };
  history: (
    pattern: string,
    options?: { namespaces?: string[] | '*'; limit?: number }
  ) => {
    pattern: string;
    namespaces: string[] | '*';
    events: Array<Record<string, unknown>>;
  };
};

function createStore(): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-history-')));
}

function v6(store: MemoryStore): V6Store {
  return store as V6Store;
}

function journalLines(root: string): Record<string, unknown>[] {
  const text = readFileSync(join(root, 'journal.log'), 'utf8');
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('MemoryStore.supersede', () => {
  it('atomically archives matched ground facts as <predicate>_until with a full ISO timestamp and journals exact ended/archive/add detail', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-supersede-'));
    const store = new MemoryStore(root);
    store.assert('default', 'works_at(mira, acme).', {
      opId: 'employment-source',
      sourceText: 'Mira works at Acme.',
      at: new Date('2026-08-10T09:00:00.000Z'),
    });

    const at = new Date('2026-08-16T16:59:00.000Z');
    const result = v6(store).supersede(
      'default',
      ['works_at(mira, _)'],
      'works_at(mira, initech).',
      { opId: 'employment-update', sourceText: 'Mira now works at Initech.', at }
    );

    expect(result).toMatchObject({
      duplicates: 0,
      retracted: 1,
      opId: 'employment-update',
    });
    expect(result.added.map(serializeClause)).toEqual(['works_at(mira, initech).']);
    expect(result.archived.map(serializeClause)).toEqual([
      "works_at_until(mira, acme, '2026-08-16T16:59:00.000Z').",
    ]);
    expect(store.load('default').map(serializeClause).sort()).toEqual([
      'works_at(mira, initech).',
      "works_at_until(mira, acme, '2026-08-16T16:59:00.000Z').",
    ].sort());

    expect(journalLines(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: 'supersede',
          namespace: 'default',
          opId: 'employment-update',
          ended: [
            { clause: 'works_at(mira, acme).', sourceOpId: 'employment-source' },
          ],
          archived: [
            {
              from: 'works_at(mira, acme).',
              to: "works_at_until(mira, acme, '2026-08-16T16:59:00.000Z').",
              validUntil: '2026-08-16T16:59:00.000Z',
            },
          ],
          added: [
            "works_at_until(mira, acme, '2026-08-16T16:59:00.000Z').",
            'works_at(mira, initech).',
          ],
          replacementAdded: ['works_at(mira, initech).'],
          sourceText: 'Mira now works at Initech.',
          ts: '2026-08-16T16:59:00.000Z',
        }),
      ])
    );
  });

  it('preserves append order when multiple supersedes share the exact same timestamp', () => {
    const store = createStore();
    const at = new Date('2026-08-16T16:59:00.000Z');
    store.assert('default', 'works_at(mira, acme).');
    store.assert('default', 'works_at(zoe, globex).');

    v6(store).supersede('default', ['works_at(mira, _)'], 'works_at(mira, initech).', { at });
    v6(store).supersede('default', ['works_at(zoe, _)'], 'works_at(zoe, initrode).', { at });

    const history = v6(store).history('works_at(_, _)', { namespaces: ['default'] });
    expect(history.events.map((event) => [event.sequence, event.position, event.clause])).toEqual([
      [1, 0, 'works_at(mira, acme).'],
      [2, 0, 'works_at(zoe, globex).'],
      [3, 0, 'works_at(mira, acme).'],
      [3, 2, 'works_at(mira, initech).'],
      [4, 0, 'works_at(zoe, globex).'],
      [4, 2, 'works_at(zoe, initrode).'],
    ]);
  });

  it('is idempotent for the same operation id and rejects reuse for a different mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-supersede-idempotent-'));
    const store = new MemoryStore(root);
    store.assert('default', 'works_at(mira, acme).');
    const context = {
      opId: 'stable-operation',
      at: new Date('2026-08-16T16:59:00.000Z'),
    };

    const first = store.supersede(
      'default',
      ['works_at(mira, _)'],
      'works_at(mira, initech).',
      context
    );
    const replay = new MemoryStore(root).supersede(
      'default',
      ['works_at(mira, _)'],
      'works_at(mira, initech).',
      context
    );

    expect(replay).toEqual(first);
    expect(journalLines(root).filter((entry) => entry.op === 'supersede')).toHaveLength(1);
    expect(() =>
      store.supersede(
        'default',
        ['works_at(mira, _)'],
        'works_at(mira, elsewhere).',
        context
      )
    ).toThrow(/already used for another mutation/i);
  });

  it('checks journal capacity before changing current or archived facts', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-supersede-capacity-'));
    const store = new MemoryStore(root);
    store.assert('default', 'works_at(mira, acme).');
    writeFileSync(join(root, 'journal.log'), ' '.repeat(16 * 1024 * 1024), 'utf8');

    expect(() =>
      store.supersede(
        'default',
        ['works_at(mira, _)'],
        'works_at(mira, initech).',
        { at: new Date('2026-08-16T16:59:00.000Z') }
      )
    ).toThrow(/journal\.log would exceed/i);
    expect(new MemoryStore(root).load('default').map(serializeClause)).toEqual([
      'works_at(mira, acme).',
    ]);
  });

  it('serializes competing cross-process supersessions without split-brain current facts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-supersede-concurrent-'));
    new MemoryStore(root).assert('default', 'status(user, old).');
    const script = `
      import { MemoryStore } from './dist/store/store.js';
      new MemoryStore(process.env.TEST_MEMORY_ROOT).supersede(
        'default',
        ['status(user, _)'],
        \`status(user, \${process.env.TEST_NEXT}).\`,
        { opId: process.env.TEST_OP, at: new Date('2026-08-16T16:59:00.000Z') }
      );
    `;
    const run = (next: string, opId: string) =>
      new Promise<void>((resolvePromise, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            TEST_MEMORY_ROOT: root,
            TEST_NEXT: next,
            TEST_OP: opId,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => (stderr += String(chunk)));
        child.on('error', reject);
        child.on('exit', (code) =>
          code === 0 ? resolvePromise() : reject(new Error(`child exited ${code}: ${stderr}`))
        );
      });

    await Promise.all([run('first', 'concurrent-1'), run('second', 'concurrent-2')]);

    const clauses = new MemoryStore(root).load('default');
    expect(
      clauses.filter((clause) => clause.head.predicate === 'status').map(serializeClause)
    ).toHaveLength(1);
    expect(
      clauses.filter((clause) => clause.head.predicate === 'status_until').map(serializeClause)
    ).toHaveLength(2);
    const history = new MemoryStore(root).history('status(user, _)');
    expect(history.events.filter((event) => event.action === 'superseded')).toHaveLength(2);
    expect(history.events.filter((event) => event.current)).toHaveLength(1);
  });
});

describe('MemoryStore.history', () => {
  it('returns deterministic asserted, superseded, and retracted events with lineage and current flags', () => {
    const store = createStore();
    store.assert('default', 'works_at(mira, acme).', {
      opId: 'source-1',
      sourceText: 'Mira works at Acme.',
      at: new Date('2026-08-10T09:00:00.000Z'),
    });
    v6(store).supersede('default', ['works_at(mira, _)'], 'works_at(mira, initech).', {
      opId: 'source-2',
      sourceText: 'Mira now works at Initech.',
      at: new Date('2026-08-16T16:59:00.000Z'),
    });
    store.retract('default', 'works_at(mira, initech)', {
      opId: 'source-3',
      sourceText: 'Mira left Initech.',
      at: new Date('2026-08-17T03:30:00.000Z'),
    });
    store.assert('default', 'works_at(mira, initrode).', {
      opId: 'source-4',
      sourceText: 'Mira joined Initrode.',
      at: new Date('2026-08-17T05:00:00.000Z'),
    });

    const history = v6(store).history('works_at(mira, _)', { namespaces: ['default'] });
    expect(history).toMatchObject({
      pattern: 'works_at(mira, _)',
      namespaces: ['default'],
    });
    expect(history.events).toEqual([
      expect.objectContaining({
        sequence: 1,
        position: 0,
        action: 'asserted',
        clause: 'works_at(mira, acme).',
        current: false,
        opId: 'source-1',
        ts: '2026-08-10T09:00:00.000Z',
        sourceText: 'Mira works at Acme.',
      }),
      expect.objectContaining({
        sequence: 2,
        position: 0,
        action: 'superseded',
        clause: 'works_at(mira, acme).',
        current: false,
        opId: 'source-2',
        ts: '2026-08-16T16:59:00.000Z',
        previousSourceOpId: 'source-1',
        validUntil: '2026-08-16T16:59:00.000Z',
        archivedAs: "works_at_until(mira, acme, '2026-08-16T16:59:00.000Z').",
      }),
      expect.objectContaining({
        sequence: 2,
        position: 2,
        action: 'asserted',
        clause: 'works_at(mira, initech).',
        current: false,
        opId: 'source-2',
      }),
      expect.objectContaining({
        sequence: 3,
        position: 0,
        action: 'retracted',
        clause: 'works_at(mira, initech).',
        current: false,
        opId: 'source-3',
        previousSourceOpId: 'source-2',
      }),
      expect.objectContaining({
        sequence: 4,
        position: 0,
        action: 'asserted',
        clause: 'works_at(mira, initrode).',
        current: true,
        opId: 'source-4',
      }),
    ]);
  });

  it('supports deterministic row limits', () => {
    const store = createStore();
    store.assert('default', 'works_at(mira, acme).', { opId: 'source-1' });
    v6(store).supersede('default', ['works_at(mira, _)'], 'works_at(mira, initech).', {
      opId: 'source-2',
      at: new Date('2026-08-16T16:59:00.000Z'),
    });
    store.retract('default', 'works_at(mira, initech)', { opId: 'source-3' });

    expect(() =>
      v6(store).history('works_at(mira, _)', {
        namespaces: ['default'],
        limit: 2,
      })
    ).toThrow(/history result exceeds 2 events/i);
  });

  it('redacts secret-like source text in history output', () => {
    const store = createStore();
    store.assert('default', 'uses(rahul, rembero).', {
      opId: 'secret-source',
      sourceText: 'My token is sk-supersecretvalue',
    });

    const history = v6(store).history('uses(rahul, rembero)', { namespaces: ['default'] });
    expect(history.events).toEqual([
      expect.objectContaining({
        sourceText: '[sensitive source omitted]',
        sourceRedacted: true,
      }),
    ]);
  });

  it('bounds long source statements and marks the projection as truncated', () => {
    const store = createStore();
    store.assert('default', 'note(user, durable).', {
      opId: 'long-source',
      sourceText: 'x'.repeat(5_000),
    });

    const [event] = store.history('note(user, durable)').events;
    expect(event.sourceText).toMatch(/…$/);
    expect(Buffer.byteLength(event.sourceText ?? '', 'utf8')).toBeLessThanOrEqual(4_096);
    expect(event.sourceTruncated).toBe(true);
  });

  it('replays legacy assert + retract journal entries without requiring v0.6 supersede records', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-history-legacy-'));
    const store = new MemoryStore(root);
    writeFileSync(
      join(root, 'journal.log'),
      [
        JSON.stringify({
          ts: '2026-08-10T09:00:00.000Z',
          op: 'assert',
          namespace: 'default',
          opId: 'legacy-a',
          added: ['works_at(mira, acme).'],
          sourceText: 'Legacy import',
        }),
        JSON.stringify({
          ts: '2026-08-16T16:59:00.000Z',
          op: 'retract',
          namespace: 'default',
          opId: 'legacy-b',
          pattern: 'works_at(mira, _)',
          removed: 1,
          sourceText: 'Legacy cleanup',
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const history = v6(store).history('works_at(mira, _)', { namespaces: ['default'] });
    expect(history.events).toEqual([
      expect.objectContaining({
        action: 'asserted',
        clause: 'works_at(mira, acme).',
        opId: 'legacy-a',
      }),
      expect.objectContaining({
        action: 'retracted',
        clause: 'works_at(mira, acme).',
        opId: 'legacy-b',
      }),
    ]);
  });

  it('marks a manual re-add as current and retains lineage to the previous source op', () => {
    const store = createStore();
    store.assert('default', 'prefers_theme(user, dark).', { opId: 'source-1' });
    store.retract('default', 'prefers_theme(user, dark)', { opId: 'source-2' });
    store.assert('default', 'prefers_theme(user, dark).', {
      opId: 'source-3',
      sourceText: 'User explicitly re-added dark mode.',
    });

    const history = v6(store).history('prefers_theme(user, dark)', { namespaces: ['default'] });
    expect(history.events.at(-1)).toMatchObject({
      action: 'asserted',
      clause: 'prefers_theme(user, dark).',
      current: true,
      opId: 'source-3',
      previousSourceOpId: 'source-2',
      sourceText: 'User explicitly re-added dark mode.',
    });
  });

  it('fails closed on malformed journal lines, malformed timestamps, and malformed clauses', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-history-corrupt-'));
    const store = new MemoryStore(root);
    writeFileSync(
      join(root, 'journal.log'),
      [
        JSON.stringify({
          ts: 'not-a-date',
          op: 'assert',
          namespace: 'default',
          opId: 'bad-ts',
          added: ['works_at(mira, acme).'],
        }),
        JSON.stringify({
          ts: '2026-08-16T16:59:00.000Z',
          op: 'assert',
          namespace: 'default',
          opId: 'bad-clause',
          added: ['works_at(mira, '],
        }),
        '{broken',
      ].join('\n') + '\n',
      'utf8'
    );

    expect(() => v6(store).history('works_at(mira, _)', { namespaces: ['default'] })).toThrow(
      /journal|timestamp|clause/i
    );
  });

  it('rejects invalid, wildcard-only, and multi-goal history patterns', () => {
    const store = createStore();
    expect(() => v6(store).history('works_at(mira, _), lives_in(mira, _)')).toThrow(
      /single literal|one literal|history pattern/i
    );
    expect(() => v6(store).history('works_at(')).toThrow(/parse|expected|history pattern/i);
    expect(() => v6(store).history('_')).toThrow(/single literal|history pattern/i);
  });
});
