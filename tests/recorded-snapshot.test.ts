import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeClause } from '../src/engine/index.js';
import {
  IncompleteHistoryError,
  MemoryStore,
} from '../src/store/store.js';

const createStore = () =>
  new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-recorded-snapshot-')));

describe('MemoryStore.recordedSnapshot', () => {
  it('reconstructs rules and facts at exact global journal positions', () => {
    const store = createStore();
    store.assert('personal', 'works_at(mira, acme). colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.', {
      opId: 'first',
      sourceText: 'Mira worked at Acme.',
    });
    store.assert('personal', 'works_at(rahul, acme).', { opId: 'second' });
    store.replace('personal', ['works_at(mira, _)'], 'works_at(mira, initech).', {
      opId: 'third',
    });

    expect(store.recordedSnapshot(['personal'], 0).clauses).toEqual([]);
    expect(store.recordedSnapshot(['personal'], 1).clauses.map(serializeClause)).toEqual([
      'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.',
      'works_at(mira, acme).',
    ]);
    expect(
      [...store.recordedSnapshot(['personal'], 2).sources.values()]
        .flat()
        .some((source) => source.opId === 'first' && source.text === 'Mira worked at Acme.')
    ).toBe(true);
    expect(store.recordedSnapshot(['personal'], 3).clauses.map(serializeClause)).toEqual([
      'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.',
      'works_at(mira, initech).',
      'works_at(rahul, acme).',
    ]);
  });

  it('retains archived valid-time facts and their provenance after supersession', () => {
    const store = createStore();
    store.assert('default', 'status(mira, active).', {
      opId: 'before',
      sourceText: 'Mira was active.',
      at: new Date('2026-08-01T00:00:00.000Z'),
    });
    store.supersede('default', ['status(mira, _)'], 'status(mira, paused).', {
      opId: 'after',
      at: new Date('2026-08-10T00:00:00.000Z'),
    });

    const snapshot = store.recordedSnapshot(['default'], 2);
    expect(snapshot.clauses.map(serializeClause)).toEqual([
      "status_until(mira, active, '2026-08-10T00:00:00.000Z').",
      'status(mira, paused).',
    ]);
    const archived = [...snapshot.sources.values()].flat().find((source) => source.temporal);
    expect(archived).toMatchObject({
      opId: 'after',
      temporal: {
        kind: 'superseded',
        previousClause: 'status(mira, active).',
        validUntil: '2026-08-10T00:00:00.000Z',
      },
    });
  });

  it('uses global positions consistently across namespaces and fresh processes', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-recorded-snapshot-'));
    const store = new MemoryStore(root);
    store.assert('a', 'seen(a).', { opId: 'a-1' });
    store.note('a', 'remember', {});
    store.assert('b', 'seen(b).', { opId: 'b-1' });

    const snapshot = new MemoryStore(root).recordedSnapshot('*', 2);
    expect(snapshot).toMatchObject({ sequence: 2, journalEntries: 3, namespaces: ['a', 'b'] });
    expect(snapshot.clauses.map(serializeClause)).toEqual(['seen(a).']);
  });

  it('fails closed for out-of-range positions and unjournaled current knowledge', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-recorded-snapshot-'));
    const store = new MemoryStore(root);
    store.assert('default', 'tracked(value).', { opId: 'tracked' });
    expect(() => store.recordedSnapshot(['default'], 2)).toThrow(/exceeds journal length/i);

    writeFileSync(
      join(root, 'default.dl'),
      '% rembero memory — one Datalog clause per line; edit by hand if you like.\ntracked(value).\nuntracked(value).\n'
    );
    expect(() => store.recordedSnapshot(['default'], 1)).toThrow(IncompleteHistoryError);
  });

  it('rejects internally inconsistent mutation records even when files match replay', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-recorded-snapshot-'));
    const store = new MemoryStore(root);
    store.assert('default', 'tracked(value).', { opId: 'tracked' });
    store.retract('default', 'tracked(_)', { opId: 'removed' });
    const path = join(root, 'journal.log');
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    lines[1].removed = 2;
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);

    expect(() => new MemoryStore(root).recordedSnapshot(['default'], 1)).toThrow(
      /removedClauses does not match removed count/i
    );
  });

  it('rejects an unknown in-scope operation instead of assuming it is audit-only', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-recorded-snapshot-'));
    const store = new MemoryStore(root);
    store.assert('default', 'tracked(value).', { opId: 'tracked' });
    store.retract('default', 'tracked(_)', { opId: 'removed' });
    const path = join(root, 'journal.log');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    lines.splice(
      1,
      0,
      JSON.stringify({
        ts: '2026-08-17T00:00:00.000Z',
        op: 'mystery_mutation',
        namespace: 'default',
        added: ['hidden(value).'],
      })
    );
    writeFileSync(path, `${lines.join('\n')}\n`);

    expect(() => new MemoryStore(root).recordedSnapshot(['default'], 2)).toThrow(
      /unsupported operation 'mystery_mutation'/i
    );
  });
});
