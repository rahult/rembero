import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, LlmClient } from '../src/llm/client.js';
import {
  proposeRememberText,
  type MemoryChangeProposal,
} from '../src/knowledge/memory-proposal.js';
import {
  applyMemoryProposal,
  parseMemoryProposal,
} from '../src/knowledge/memory-application.js';
import { IntegrityViolationError } from '../src/knowledge/enforcement.js';
import { diffRecordedKnowledge } from '../src/knowledge/recorded-diff.js';
import {
  MemoryChangeStaleError,
  MemoryStore,
  OperationConflictError,
} from '../src/store/store.js';
import {
  canonicalKey,
  parseProgram,
  serializeClause,
} from '../src/engine/index.js';

class ScriptedLlm implements LlmClient {
  constructor(private responses: string[]) {}
  async complete(_messages: ChatMessage[]): Promise<string> {
    const response = this.responses.shift();
    if (response === undefined) throw new Error('out of memory application responses');
    return response;
  }
}

function rootFor(label: string): string {
  return mkdtempSync(join(tmpdir(), `rembero-memory-application-${label}-`));
}

async function proposalFor(
  store: MemoryStore,
  response: string,
  text: string,
  options: Parameters<typeof proposeRememberText>[3] = {}
): Promise<MemoryChangeProposal> {
  const result = await proposeRememberText(
    { store, llm: new ScriptedLlm([response]) },
    text,
    'default',
    options
  );
  if (result.proposal === undefined) throw new Error('expected memory proposal');
  return result.proposal;
}

describe('digest-bound reviewed personal memory application', () => {
  it('atomically applies an accepted fact with provenance, history, and replay', async () => {
    const root = rootFor('fact');
    const store = new MemoryStore(root);
    const proposal = await proposalFor(
      store,
      'pet(rahul, luna).',
      'Rahul has a pet named Luna.'
    );

    const applied = applyMemoryProposal(store, proposal, {
      opId: 'reviewed-memory-1',
      at: new Date('2026-08-17T08:00:00.000Z'),
    });

    expect(applied).toMatchObject({
      added: [expect.any(Object)],
      removed: [],
      archived: [],
      proposalDigest: proposal.proposalDigest,
      baselineDigest: proposal.baselineDigest,
      opId: 'reviewed-memory-1',
      sequence: 1,
      audit: { topology: { factCount: 1, ruleCount: 0 } },
    });
    expect(store.load('default').map(serializeClause)).toEqual([
      'pet(rahul, luna).',
    ]);
    expect(store.sourcesFor(['default']).values().next().value).toEqual([
      expect.objectContaining({
        opId: 'reviewed-memory-1',
        text: 'Rahul has a pet named Luna.',
      }),
    ]);
    expect(store.history('pet(rahul, _)').events).toMatchObject([
      {
        action: 'asserted',
        opId: 'reviewed-memory-1',
        clause: 'pet(rahul, luna).',
        current: true,
      },
    ]);

    const replay = applyMemoryProposal(store, proposal, {
      opId: 'reviewed-memory-1',
      at: new Date('2026-08-17T08:00:00.000Z'),
    });
    expect(replay).toEqual(applied);
    expect(store.recordedSnapshot(['default'], 1).journalEntries).toBe(1);
  });

  it('applies an exact correction and records retraction lineage', async () => {
    const store = new MemoryStore(rootFor('correction'));
    store.assert('default', 'works_at(mira, acme).', { opId: 'old-work' });
    const proposal = await proposalFor(
      store,
      'retract works_at(mira, _).\nworks_at(mira, initech).',
      'Mira now works at Initech.'
    );

    const applied = applyMemoryProposal(store, proposal, {
      opId: 'reviewed-correction',
    });

    expect(applied.removed.map(serializeClause)).toEqual([
      'works_at(mira, acme).',
    ]);
    expect(applied.added.map(serializeClause)).toEqual([
      'works_at(mira, initech).',
    ]);
    expect(store.history('works_at(mira, _)').events).toMatchObject([
      { action: 'asserted', clause: 'works_at(mira, acme).', current: false },
      {
        action: 'retracted',
        clause: 'works_at(mira, acme).',
        previousSourceOpId: 'old-work',
        current: false,
      },
      { action: 'asserted', clause: 'works_at(mira, initech).', current: true },
    ]);
  });

  it('preserves reviewed valid-time archives and temporal source evidence', async () => {
    const store = new MemoryStore(rootFor('temporal'));
    store.assert('default', 'works_at(mira, acme).', { opId: 'old-work' });
    const proposal = await proposalFor(
      store,
      'retract works_at(mira, _).\nworks_at(mira, initech).',
      'Mira now works at Initech.',
      {
        validTimeMode: 'archive_until',
        at: new Date('2026-08-17T08:30:00.000Z'),
      }
    );

    const applied = applyMemoryProposal(store, proposal, {
      opId: 'reviewed-temporal',
    });

    expect(applied.archived.map(serializeClause)).toEqual([
      "works_at_until(mira, acme, '2026-08-17T08:30:00.000Z').",
    ]);
    const archived = store.sourcesFor(['default']).get(
      canonicalKeyOf(
        "works_at_until(mira, acme, '2026-08-17T08:30:00.000Z')."
      )
    );
    expect(archived).toEqual([
      expect.objectContaining({
        temporal: {
          kind: 'superseded',
          previousClause: 'works_at(mira, acme).',
          validUntil: '2026-08-17T08:30:00.000Z',
        },
      }),
    ]);
    expect(store.history('works_at(mira, _)').events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'superseded',
          archivedAs:
            "works_at_until(mira, acme, '2026-08-17T08:30:00.000Z').",
          validUntil: '2026-08-17T08:30:00.000Z',
        }),
      ])
    );
  });

  it('commits mixed extracted facts and rules as one recorded change', async () => {
    const store = new MemoryStore(rootFor('mixed'));
    store.assert('default', 'works_at(mira, acme).', { opId: 'base' });
    const proposal = await proposalFor(
      store,
      `works_at(rahul, acme).
       colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.`,
      'Rahul works at Acme and people at the same company are colleagues.'
    );
    const applied = applyMemoryProposal(store, proposal, {
      opId: 'reviewed-mixed',
    });

    expect(applied.audit).toMatchObject({
      status: 'clean',
      topology: { factCount: 2, ruleCount: 1 },
    });
    expect(applied.sequence).toBe(2);
    expect(diffRecordedKnowledge(store, 1, 2).clauses.added).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'fact', clause: 'works_at(rahul, acme).' }),
        expect.objectContaining({ kind: 'rule', clause: expect.stringContaining('colleague') }),
      ])
    );
    expect(store.compactJournal({ opId: 'memory-change-checkpoint' }).sequence).toBe(2);
    expect(store.recordedSnapshot(['default'], 2).clauses).toHaveLength(3);
  });

  it('rejects stale, tampered, and policy-violating proposals before mutation', async () => {
    const staleStore = new MemoryStore(rootFor('stale'));
    const stale = await proposalFor(staleStore, 'item(a).', 'Remember item A.');
    staleStore.assert('default', 'other(b).', { opId: 'concurrent' });
    expect(() =>
      applyMemoryProposal(staleStore, stale, { opId: 'stale-memory' })
    ).toThrow(MemoryChangeStaleError);

    expect(() =>
      parseMemoryProposal({ ...stale, sourceText: 'tampered' })
    ).toThrow(/digest does not match/i);

    const policyStore = new MemoryStore(rootFor('policy'));
    policyStore.assert('default', 'active(mira). :- active(X), suspended(X).', {
      opId: 'policy',
    });
    const unsafe = await proposalFor(
      policyStore,
      'suspended(mira).',
      'Mira is suspended.'
    );
    expect(() =>
      applyMemoryProposal(policyStore, unsafe, { opId: 'unsafe-memory' })
    ).toThrow(IntegrityViolationError);
    expect(policyStore.load('default')).toHaveLength(2);
  });

  it('serializes competing memory proposals and conflicts on operation-id reuse', async () => {
    const root = rootFor('concurrent');
    const store = new MemoryStore(root);
    const first = await proposalFor(store, 'first(a).', 'Remember first A.');
    const second = await proposalFor(store, 'second(a).', 'Remember second A.');
    const modulePath = resolve('dist/index.js');
    const run = (proposal: MemoryChangeProposal, opId: string) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
        const child = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { MemoryStore, applyMemoryProposal } from ${JSON.stringify(modulePath)};
             const store = new MemoryStore(process.env.TEST_MEMORY_ROOT);
             try {
               applyMemoryProposal(store, JSON.parse(process.env.TEST_PROPOSAL), {
                 opId: process.env.TEST_OPERATION_ID
               });
               console.log('committed');
             } catch (error) {
               if (error?.code === 'memory_change_stale') console.log('stale');
               else throw error;
             }`,
          ],
          {
            env: {
              ...process.env,
              TEST_MEMORY_ROOT: root,
              TEST_PROPOSAL: JSON.stringify(proposal),
              TEST_OPERATION_ID: opId,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += String(chunk)));
        child.stderr.on('data', (chunk) => (stderr += String(chunk)));
        child.on('close', (code) => resolveRun({ code, stdout, stderr }));
      });
    const outcomes = await Promise.all([
      run(first, 'memory-first'),
      run(second, 'memory-second'),
    ]);
    expect(outcomes.map(({ stdout }) => stdout.trim()).sort()).toEqual([
      'committed',
      'stale',
    ]);
    expect(outcomes.map(({ stderr }) => stderr).join('')).toBe('');
    expect(
      readFileSync(join(root, 'journal.log'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter(({ op }) => op === 'memory_change')
    ).toHaveLength(1);

    const committed = new MemoryStore(root);
    const winningProposal = committed.load('default')[0].head.predicate === 'first'
      ? first
      : second;
    expect(() =>
      applyMemoryProposal(committed, winningProposal, { opId: 'conflict-id' })
    ).toThrow(MemoryChangeStaleError);

    const fresh = new MemoryStore(rootFor('operation-conflict'));
    const plan = await proposalFor(fresh, 'item(a).', 'Remember item A.');
    applyMemoryProposal(fresh, plan, { opId: 'same-memory-op' });
    expect(() =>
      fresh.applyMemoryChange(
        'default',
        {
          namespaces: ['default'],
          expectedBaselineDigest: plan.baselineDigest,
          proposalDigest: '0'.repeat(64),
          add: 'other(a).',
          remove: '',
        },
        {
          opId: 'same-memory-op',
          integrity: { mode: 'no_new_violations', namespaces: ['default'] },
        }
      )
    ).toThrow(OperationConflictError);
  });
});

function canonicalKeyOf(serialized: string): string {
  return canonicalKey(parseProgram(serialized)[0]);
}
