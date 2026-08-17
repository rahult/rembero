import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, LlmClient } from '../src/llm/client.js';
import {
  computeMemoryProposalDigest,
  proposeRememberText,
} from '../src/knowledge/memory-proposal.js';
import { MemoryStore } from '../src/store/store.js';
import { serializeClause } from '../src/engine/index.js';

class ScriptedLlm implements LlmClient {
  calls: ChatMessage[][] = [];
  constructor(private responses: string[]) {}
  async complete(messages: ChatMessage[]): Promise<string> {
    this.calls.push(messages);
    const response = this.responses.shift();
    if (response === undefined) throw new Error('out of proposal responses');
    return response;
  }
}

function proposalStore(label: string): { root: string; store: MemoryStore } {
  const root = mkdtempSync(join(tmpdir(), `rembero-memory-proposal-${label}-`));
  return { root, store: new MemoryStore(root) };
}

describe('proposal-first natural-language memory', () => {
  it('returns a digest-bound accepted fact proposal without writing', async () => {
    const { root, store } = proposalStore('facts');
    const llm = new ScriptedLlm([
      'works_at(rahul, acme).\nlives_in(rahul, melbourne).',
    ]);

    const result = await proposeRememberText(
      { store, llm },
      'Rahul works at Acme and lives in Melbourne.'
    );

    expect(result).toMatchObject({
      changed: true,
      extractedClauses: [
        'works_at(rahul, acme).',
        'lives_in(rahul, melbourne).',
      ],
      extractedRetractions: [],
      application: {
        assumed: [
          'works_at(rahul, acme).',
          'lives_in(rahul, melbourne).',
        ],
        retracted: [],
      },
      integrityDelta: {
        baseline: { status: 'unconstrained' },
        candidate: { status: 'unconstrained' },
        introduced: [],
      },
      proposal: {
        version: 1,
        proposalDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        baselineDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        namespace: 'default',
        namespaces: ['default'],
        sourceText: 'Rahul works at Acme and lives in Melbourne.',
        validTimeMode: 'delete',
        addClauses: [
          'works_at(rahul, acme).',
          'lives_in(rahul, melbourne).',
        ],
        removeClauses: [],
      },
    });
    const { proposalDigest, ...payload } = result.proposal!;
    expect(computeMemoryProposalDigest(payload)).toBe(proposalDigest);
    expect(store.load('default')).toEqual([]);
    expect(existsSync(join(root, 'journal.log'))).toBe(false);
  });

  it('binds exact correction removals and preserves archive-until semantics', async () => {
    const { root, store } = proposalStore('archive');
    store.assert('default', 'works_at(mira, acme).', { opId: 'baseline' });
    const journalBefore = readFileSync(join(root, 'journal.log'), 'utf8');
    const llm = new ScriptedLlm([
      'retract works_at(mira, _).\nworks_at(mira, initech).',
    ]);

    const result = await proposeRememberText(
      { store, llm },
      'Mira now works at Initech.',
      'default',
      {
        validTimeMode: 'archive_until',
        at: new Date('2026-08-17T07:30:00.000Z'),
      }
    );

    expect(result.proposal).toMatchObject({
      validTimeMode: 'archive_until',
      at: '2026-08-17T07:30:00.000Z',
      removeClauses: ['works_at(mira, acme).'],
      addClauses: [
        'works_at(mira, initech).',
        "works_at_until(mira, acme, '2026-08-17T07:30:00.000Z').",
      ],
    });
    expect(store.load('default').map(serializeClause)).toEqual([
      'works_at(mira, acme).',
    ]);
    expect(readFileSync(join(root, 'journal.log'), 'utf8')).toBe(journalBefore);
  });

  it('includes proposed rules and deterministic rule-health impact', async () => {
    const { store } = proposalStore('rules');
    store.assert(
      'default',
      'works_at(mira, acme). works_at(rahul, acme).',
      { opId: 'facts' }
    );
    const llm = new ScriptedLlm([
      'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.',
    ]);

    const result = await proposeRememberText(
      { store, llm },
      'People at the same company are colleagues, except themselves.'
    );

    expect(result.proposal?.addClauses).toEqual([
      'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.',
    ]);
    expect(result.application.assumedRules).toEqual([
      'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.',
    ]);
    expect(result.ruleAuditDelta).toMatchObject({
      baseline: { topology: { ruleCount: 0 } },
      candidate: { status: 'clean', topology: { ruleCount: 1 } },
    });
    expect(store.load('default')).toHaveLength(2);
  });

  it('makes duplicates and non-factual extraction explicit proposal no-ops', async () => {
    const { store } = proposalStore('noop');
    store.assert('default', 'pet(rahul, luna).', { opId: 'pet' });
    const duplicate = await proposeRememberText(
      { store, llm: new ScriptedLlm(['pet(rahul, luna).']) },
      'Rahul has a pet named Luna.'
    );
    expect(duplicate).toMatchObject({
      changed: false,
      application: { duplicateAssumptions: ['pet(rahul, luna).'] },
    });
    expect(duplicate.proposal).toBeUndefined();

    const empty = await proposeRememberText(
      { store, llm: new ScriptedLlm(['% nothing']) },
      'Thanks!'
    );
    expect(empty.changed).toBe(false);
    expect(empty.proposal).toBeUndefined();
  });

  it('surfaces introduced policy violations without granting mutation authority', async () => {
    const { store } = proposalStore('integrity');
    store.assert(
      'default',
      'status(mira, active). :- status(Person, active), status(Person, suspended).',
      { opId: 'policy' }
    );
    const result = await proposeRememberText(
      { store, llm: new ScriptedLlm(['status(mira, suspended).']) },
      'Mira is suspended.'
    );

    expect(result.integrityDelta).toMatchObject({
      baseline: { status: 'consistent' },
      candidate: { status: 'violations', violationCount: 1 },
      introduced: [{ bindings: { Person: 'mira' } }],
    });
    expect(result.proposal).toBeDefined();
    expect(store.load('default')).toHaveLength(2);
  });

  it('retains local secret rejection before proposal generation', async () => {
    const { store } = proposalStore('secret');
    const llm = new ScriptedLlm(['token(rahul, leaked).']);
    await expect(
      proposeRememberText(
        { store, llm },
        'Rahul token is ghp_supersecretvalue.'
      )
    ).rejects.toThrow(/sensitive memory text/i);
    expect(llm.calls).toHaveLength(0);
    expect(store.load('default')).toEqual([]);
  });
});
