import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { serializeClause } from '../src/engine/index.js';
import { MemoryStore, OperationConflictError } from '../src/store/store.js';

function snapshotClauses(store: MemoryStore, sequence: number): string[] {
  return store
    .recordedSnapshot(['default'], sequence)
    .clauses.map(serializeClause);
}

describe('immutable journal checkpoints', () => {
  it('rotates immutable segments without changing any global recorded sequence', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-checkpoint-'));
    const store = new MemoryStore(root);
    store.assert('default', 'status(mira, active).', { opId: 'first' });
    store.assert('default', 'project(atlas).', { opId: 'second' });
    const before = [0, 1, 2].map((sequence) => snapshotClauses(store, sequence));

    const first = store.compactJournal({
      opId: 'checkpoint-one',
      at: new Date('2026-08-17T02:00:00.000Z'),
    });
    expect(first).toMatchObject({
      rotated: true,
      sequence: 2,
      activeEntries: 0,
      segmentCount: 1,
      checkpoint: {
        sequence: 2,
        opId: 'checkpoint-one',
        segment: { startSequence: 1, endSequence: 2, entries: 2 },
      },
    });
    expect(existsSync(join(root, 'journal.log'))).toBe(false);
    expect([0, 1, 2].map((sequence) => snapshotClauses(store, sequence))).toEqual(
      before
    );
    expect(store.listJournalCheckpoints()).toEqual([first.checkpoint]);
    const checkpointNamespace = first.checkpoint?.namespaces[0];
    expect(checkpointNamespace).toMatchObject({
      namespace: 'default',
      clauses: ['project(atlas).', 'status(mira, active).'],
    });
    expect(
      checkpointNamespace?.sources.map(({ key, values }) => [key, values[0]?.opId])
    ).toEqual([
      ['project(atlas).', 'second'],
      ['status(mira, active).', 'first'],
    ]);

    const reopened = new MemoryStore(root);
    expect([0, 1, 2].map((sequence) => snapshotClauses(reopened, sequence))).toEqual(
      before
    );
    expect(reopened.listJournalCheckpoints()).toEqual([first.checkpoint]);

    store.assert('default', 'status(zoe, active).', { opId: 'third' });
    expect(snapshotClauses(store, 3)).toEqual([
      'project(atlas).',
      'status(mira, active).',
      'status(zoe, active).',
    ]);
    expect(store.history('status(Person, State)').events.map((event) => event.sequence)).toEqual([
      1,
      3,
    ]);

    const second = store.compactJournal({
      opId: 'checkpoint-two',
      at: new Date('2026-08-17T03:00:00.000Z'),
    });
    expect(second).toMatchObject({
      sequence: 3,
      segmentCount: 2,
      checkpoint: { segment: { startSequence: 3, endSequence: 3 } },
    });
    expect(
      store.compactJournal({
        opId: 'checkpoint-one',
        at: new Date('2026-08-17T02:00:00.000Z'),
      })
    ).toEqual(first);
    expect(() =>
      store.compactJournal({
        opId: 'checkpoint-one',
        at: new Date('2026-08-17T04:00:00.000Z'),
      })
    ).toThrow(OperationConflictError);
  });

  it('previews a checkpoint without changing journal artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-checkpoint-dry-'));
    const store = new MemoryStore(root);
    store.assert('default', 'item(a).', { opId: 'item' });
    const journalBefore = readFileSync(join(root, 'journal.log'), 'utf8');

    const preview = store.compactJournal({
      dryRun: true,
      opId: 'preview',
      at: new Date('2026-08-17T02:00:00.000Z'),
    });
    expect(preview).toMatchObject({
      rotated: true,
      sequence: 1,
      checkpoint: { opId: 'preview' },
    });
    expect(readFileSync(join(root, 'journal.log'), 'utf8')).toBe(journalBefore);
    expect(existsSync(join(root, '.journal-segments'))).toBe(false);
    expect(existsSync(join(root, '.journal-checkpoints'))).toBe(false);
  });

  it('fails closed when an immutable segment or checkpoint is tampered', () => {
    const segmentRoot = mkdtempSync(join(tmpdir(), 'rembero-checkpoint-tamper-segment-'));
    const segmentStore = new MemoryStore(segmentRoot);
    segmentStore.assert('default', 'item(a).', { opId: 'item' });
    segmentStore.compactJournal({ opId: 'segment' });
    const segmentDir = join(segmentRoot, '.journal-segments');
    const segment = join(segmentDir, readdirSync(segmentDir)[0]);
    writeFileSync(segment, `${readFileSync(segment, 'utf8')} `);
    expect(() => segmentStore.recordedSnapshot(['default'], 1)).toThrow(
      /SHA-256 validation/i
    );

    const checkpointRoot = mkdtempSync(join(tmpdir(), 'rembero-checkpoint-tamper-state-'));
    const checkpointStore = new MemoryStore(checkpointRoot);
    checkpointStore.assert('default', 'item(a).', { opId: 'item' });
    checkpointStore.compactJournal({ opId: 'checkpoint' });
    const checkpointDir = join(checkpointRoot, '.journal-checkpoints');
    const checkpoint = join(checkpointDir, readdirSync(checkpointDir)[0]);
    const value = JSON.parse(readFileSync(checkpoint, 'utf8'));
    value.namespaces[0].clauses = ['item(tampered).'];
    value.stateDigest = createHash('sha256')
      .update(JSON.stringify(value.namespaces))
      .digest('hex');
    writeFileSync(checkpoint, `${JSON.stringify(value)}\n`);
    expect(() => checkpointStore.listJournalCheckpoints()).toThrow(
      /does not match replay/i
    );
  });

  it('repairs a crash-safe segment whose checkpoint was not published', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-checkpoint-repair-'));
    const store = new MemoryStore(root);
    store.assert('default', 'item(a).', { opId: 'first' });
    store.compactJournal({ opId: 'first-checkpoint' });
    const checkpointDir = join(root, '.journal-checkpoints');
    unlinkSync(join(checkpointDir, readdirSync(checkpointDir)[0]));
    expect(store.listJournalCheckpoints()).toEqual([]);

    store.compactJournal({ dryRun: true, opId: 'repair-preview' });
    expect(readdirSync(checkpointDir)).toEqual([]);

    store.assert('default', 'item(b).', { opId: 'second' });
    store.compactJournal({ opId: 'second-checkpoint' });
    expect(store.listJournalCheckpoints()).toHaveLength(2);
    expect(snapshotClauses(store, 1)).toEqual(['item(a).']);
    expect(snapshotClauses(store, 2)).toEqual(['item(a).', 'item(b).']);
  });

  it('detects a missing segment in the global sequence chain', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-checkpoint-missing-'));
    const store = new MemoryStore(root);
    store.assert('default', 'item(a).', { opId: 'first' });
    store.compactJournal({ opId: 'first-checkpoint' });
    store.assert('default', 'item(b).', { opId: 'second' });
    store.compactJournal({ opId: 'second-checkpoint' });
    const segmentDir = join(root, '.journal-segments');
    const [first] = readdirSync(segmentDir).sort();
    unlinkSync(join(segmentDir, first));

    expect(() => store.recordedSnapshot(['default'], 2)).toThrow(
      /segment chain is incomplete at sequence 1/i
    );
  });
});
