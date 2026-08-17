import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalKey,
  evaluate,
  parseProgram,
  parseQuery,
  serializeClause,
} from '../src/engine/index.js';
import {
  simulateKnowledge,
  type RuleChangeProposal,
} from '../src/knowledge/counterfactual.js';
import { IntegrityViolationError } from '../src/knowledge/enforcement.js';
import { diffRecordedKnowledge } from '../src/knowledge/recorded-diff.js';
import {
  applyRuleChangeProposal,
  parseRuleChangeProposal,
  RuleChangeCheckError,
} from '../src/knowledge/rule-change.js';
import {
  MemoryStore,
  OperationConflictError,
  RuleChangeStaleError,
} from '../src/store/store.js';

function ruleStore(label: string): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), `rembero-rule-change-${label}-`)));
}

function proposalFor(
  store: MemoryStore,
  query: string,
  options: Parameters<typeof simulateKnowledge>[2]
): RuleChangeProposal {
  const result = simulateKnowledge(store, query, options);
  if (result.ruleProposal === undefined) throw new Error('expected rule proposal');
  return result.ruleProposal;
}

describe('digest-bound reviewed rule changes', () => {
  it('atomically applies a checked proposal with durable provenance and replay', () => {
    const store = ruleStore('apply');
    store.assert('default', 'base(a).', { opId: 'baseline' });
    const proposal = proposalFor(store, 'derived(X)', {
      assumeRules: 'derived(X) :- base(X).',
      checkSuite: {
        version: 1,
        coverage: { minimumPercent: 100 },
        checks: [
          {
            name: 'derived a',
            query: 'derived(a)',
            expect: { kind: 'nonempty' },
          },
        ],
      },
    });

    const applied = applyRuleChangeProposal(store, proposal, {
      opId: 'reviewed-rule-1',
      at: new Date('2026-08-17T07:00:00.000Z'),
    });

    expect(applied).toMatchObject({
      namespace: 'default',
      namespaces: ['default'],
      added: [expect.any(Object)],
      removed: [],
      proposalDigest: proposal.proposalDigest,
      baselineDigest: proposal.baselineDigest,
      opId: 'reviewed-rule-1',
      sequence: 2,
      audit: { status: 'clean', topology: { ruleCount: 1 } },
      checks: { status: 'passed', coverage: { percent: 100 } },
    });
    expect(applied.added.map(serializeClause)).toEqual([
      'derived(X) :- base(X).',
    ]);
    expect(evaluate(store.load('default'), parseQuery('derived(X)'))).toMatchObject([
      { X: { value: 'a' } },
    ]);
    const rule = store.load('default').find((clause) => clause.body.length > 0)!;
    expect(store.sourcesFor(['default']).get(canonicalKey(rule))).toEqual([
      expect.objectContaining({
        opId: 'reviewed-rule-1',
        text: `Applied reviewed rule change proposal ${proposal.proposalDigest}`,
      }),
    ]);
    expect(store.recordedSnapshot(['default'], 1).clauses.map(serializeClause)).toEqual([
      'base(a).',
    ]);
    expect(store.recordedSnapshot(['default'], 2).clauses.map(serializeClause)).toEqual([
      'base(a).',
      'derived(X) :- base(X).',
    ]);

    const replay = applyRuleChangeProposal(store, proposal, {
      opId: 'reviewed-rule-1',
      at: new Date('2026-08-17T07:00:00.000Z'),
    });
    expect(replay).toEqual(applied);
    expect(store.recordedSnapshot(['default'], 2).journalEntries).toBe(2);
    expect(diffRecordedKnowledge(store, 1, 2).clauses.added).toMatchObject([
      { kind: 'rule', clause: 'derived(X) :- base(X).' },
    ]);
    const checkpoint = store.compactJournal({ opId: 'rule-change-checkpoint' });
    expect(checkpoint.sequence).toBe(2);
    expect(store.recordedSnapshot(['default'], 2).clauses.map(serializeClause)).toEqual([
      'base(a).',
      'derived(X) :- base(X).',
    ]);
  });

  it('atomically replaces an exact alpha-equivalent rule', () => {
    const store = ruleStore('replace');
    store.assert(
      'default',
      `employee(alice). badge(alice).
       eligible(X) :- employee(X).`,
      { opId: 'baseline' }
    );
    const proposal = proposalFor(store, 'eligible(X)', {
      withoutRules: 'eligible(Person) :- employee(Person).',
      assumeRules: 'eligible(Person) :- employee(Person), badge(Person).',
    });

    const applied = applyRuleChangeProposal(store, proposal, {
      opId: 'replace-rule',
    });

    expect(applied.removed.map(serializeClause)).toEqual([
      'eligible(X) :- employee(X).',
    ]);
    expect(applied.added.map(serializeClause)).toEqual([
      'eligible(Person) :- employee(Person), badge(Person).',
    ]);
    expect(store.load('default').map(serializeClause)).toEqual([
      'employee(alice).',
      'badge(alice).',
      'eligible(Person) :- employee(Person), badge(Person).',
    ]);
  });

  it('rejects a stale baseline before any mutation', () => {
    const store = ruleStore('stale');
    store.assert('default', 'base(a).', { opId: 'baseline' });
    const proposal = proposalFor(store, 'derived(X)', {
      assumeRules: 'derived(X) :- base(X).',
    });
    store.assert('default', 'base(b).', { opId: 'concurrent-change' });

    expect(() =>
      applyRuleChangeProposal(store, proposal, { opId: 'stale-rule' })
    ).toThrow(RuleChangeStaleError);
    expect(store.load('default').map(serializeClause)).not.toContain(
      'derived(X) :- base(X).'
    );
  });

  it('rejects introduced integrity violations and failed attached checks', () => {
    const integrityStore = ruleStore('integrity');
    integrityStore.assert(
      'default',
      'base(a). :- dangerous(X).',
      { opId: 'integrity-baseline' }
    );
    const unsafe = proposalFor(integrityStore, 'dangerous(X)', {
      assumeRules: 'dangerous(X) :- base(X).',
    });
    expect(() =>
      applyRuleChangeProposal(integrityStore, unsafe, { opId: 'unsafe-rule' })
    ).toThrow(IntegrityViolationError);
    expect(integrityStore.load('default')).toHaveLength(2);

    const checkStore = ruleStore('checks');
    checkStore.assert('default', 'base(a).', { opId: 'check-baseline' });
    const failing = proposalFor(checkStore, 'derived(X)', {
      assumeRules: 'derived(X) :- base(X).',
      checkSuite: {
        version: 1,
        checks: [
          {
            name: 'must stay absent',
            query: 'derived(a)',
            expect: { kind: 'empty' },
          },
        ],
      },
    });
    expect(() =>
      applyRuleChangeProposal(checkStore, failing, { opId: 'failed-checks' })
    ).toThrow(RuleChangeCheckError);
    expect(checkStore.load('default')).toHaveLength(1);
  });

  it('rejects tampering, recorded proposals, and operation-id reuse conflicts', () => {
    const store = ruleStore('validation');
    store.assert('default', 'base(a).', { opId: 'baseline' });
    const proposal = proposalFor(store, 'derived(X)', {
      assumeRules: 'derived(X) :- base(X).',
    });
    expect(() =>
      parseRuleChangeProposal({ ...proposal, query: 'other(X)' })
    ).toThrow(/digest does not match/i);

    const recorded = proposalFor(store, 'derived(X)', {
      recordedSequence: 1,
      assumeRules: 'derived(X) :- base(X).',
    });
    expect(() =>
      applyRuleChangeProposal(store, recorded, { opId: 'recorded-rule' })
    ).toThrow(/recorded history cannot be applied/i);

    applyRuleChangeProposal(store, proposal, { opId: 'same-operation' });
    const secondStorePlan = simulateKnowledge(store, 'other(X)', {
      assumeRules: 'other(X) :- base(X).',
    }).ruleProposal!;
    expect(() =>
      applyRuleChangeProposal(store, secondStorePlan, { opId: 'same-operation' })
    ).toThrow(OperationConflictError);
  });

  it('serializes competing reviewed proposals so only one baseline digest can commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-rule-change-concurrent-'));
    const store = new MemoryStore(root);
    store.assert('default', 'base(a).', { opId: 'concurrent-base' });
    const first = proposalFor(store, 'first(X)', {
      assumeRules: 'first(X) :- base(X).',
    });
    const second = proposalFor(store, 'second(X)', {
      assumeRules: 'second(X) :- base(X).',
    });
    const modulePath = resolve('dist/index.js');
    const run = (proposal: RuleChangeProposal, opId: string) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
        const child = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { MemoryStore, applyRuleChangeProposal } from ${JSON.stringify(modulePath)};
             const store = new MemoryStore(process.env.TEST_MEMORY_ROOT);
             try {
               applyRuleChangeProposal(store, JSON.parse(process.env.TEST_PROPOSAL), {
                 opId: process.env.TEST_OPERATION_ID
               });
               console.log('committed');
             } catch (error) {
               if (error?.code === 'rule_change_stale') console.log('stale');
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
      run(first, 'concurrent-first'),
      run(second, 'concurrent-second'),
    ]);
    expect(outcomes.map(({ code }) => code)).toEqual([0, 0]);
    expect(outcomes.map(({ stdout }) => stdout.trim()).sort()).toEqual([
      'committed',
      'stale',
    ]);
    expect(outcomes.map(({ stderr }) => stderr).join('')).toBe('');
    expect(
      new MemoryStore(root).load('default').filter((clause) => clause.body.length > 0)
    ).toHaveLength(1);
    const journal = readFileSync(join(root, 'journal.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(journal.filter(({ op }) => op === 'rule_change')).toHaveLength(1);
  });
});
