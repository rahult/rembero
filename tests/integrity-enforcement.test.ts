import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  enforceIntegrityCandidate,
  IntegrityViolationError,
  type IntegrityEnforcementOptions,
} from '../src/knowledge/enforcement.js';
import { rememberText } from '../src/llm/pipeline.js';
import type { LlmClient } from '../src/llm/client.js';
import { MemoryStore } from '../src/store/store.js';
import { parseProgram, serializeClause } from '../src/engine/index.js';

const strict = (namespaces?: string[] | '*'): IntegrityEnforcementOptions => ({
  mode: 'strict',
  ...(namespaces === undefined ? {} : { namespaces }),
});

function journal(root: string): string {
  return readFileSync(join(root, 'journal.log'), 'utf8');
}

describe('atomic integrity enforcement', () => {
  it('atomically rejects a write that violates aggregate-derived policy', () => {
    const store = new MemoryStore(
      mkdtempSync(join(tmpdir(), 'rembero-enforcement-aggregate-'))
    );
    store.assert(
      'default',
      `member(red, alice).
       team_size(Team, Count) :- count(*) as Count where member(Team, Person).
       :- team_size(Team, Count), Count > 1.`
    );
    const before = store.load('default');

    expect(() =>
      store.assert('default', 'member(red, bob).', { integrity: strict() })
    ).toThrow(IntegrityViolationError);
    expect(store.load('default')).toEqual(before);
  });

  it('atomically enforces identity-aware policy only when explicitly configured', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-enforce-identity-'));
    const store = new MemoryStore(root);
    store.assert(
      'default',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(status, 2, 0).
       status('Mira Patel', active).
       :- status(Person, active), status(Person, terminated).`
    );
    const before = journal(root);

    expect(() =>
      store.assert('default', 'status(mira, terminated).', {
        integrity: { mode: 'strict', entityIdentity: 'canonical' },
      })
    ).toThrow(IntegrityViolationError);
    expect(journal(root)).toBe(before);
    expect(store.load('default').map(serializeClause)).not.toContain(
      'status(mira, terminated).'
    );
  });

  it('preserves legacy violation identity across alpha-equivalent policy renames', () => {
    const baseline = parseProgram('pair(1, 2). :- pair(A, Z), A < Z.');
    const candidate = parseProgram(
      'pair(1, 2). :- pair(Zed, Alpha), Zed < Alpha.'
    );

    expect(() =>
      enforceIntegrityCandidate(
        baseline,
        candidate,
        new Map(),
        new Map(),
        { mode: 'no_new_violations' }
      )
    ).not.toThrow();
  });

  it('rejects a violating assertion with deterministic evidence and no durable mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-enforce-'));
    const store = new MemoryStore(root);
    store.assert(
      'default',
      'status(mira, active). :- status(Person, active), status(Person, terminated).',
      { opId: 'baseline' }
    );
    const beforeFile = readFileSync(join(root, 'default.dl'), 'utf8');
    const beforeJournal = journal(root);

    let rejection: IntegrityViolationError | undefined;
    try {
      store.assert('default', 'status(mira, terminated).', {
        opId: 'candidate',
        integrity: strict(),
      });
    } catch (error) {
      if (error instanceof IntegrityViolationError) rejection = error;
      else throw error;
    }

    expect(rejection?.toJSON()).toMatchObject({
      error: 'integrity_violation',
      mode: 'strict',
      baselineViolationCount: 0,
      introducedViolationCount: 1,
      candidate: {
        status: 'violations',
        violationCount: 1,
        checks: [{ rows: [{ bindings: { Person: 'mira' } }] }],
      },
    });
    expect(rejection?.result.checks[0].rows[0].proofs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: 'status',
          sources: [expect.objectContaining({ opId: 'candidate' })],
        }),
      ])
    );
    expect(readFileSync(join(root, 'default.dl'), 'utf8')).toBe(beforeFile);
    expect(journal(root)).toBe(beforeJournal);
    expect(store.load('default').map(serializeClause)).toEqual([
      'status(mira, active).',
      ':- status(Person, active), status(Person, terminated).',
    ]);
  });

  it('lets no_new_violations preserve or heal legacy findings but rejects a new row', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-enforce-migrate-'));
    const store = new MemoryStore(root);
    store.assert(
      'default',
      `status(mira, active).
       status(mira, terminated).
       :- status(Person, active), status(Person, terminated).`
    );
    const migration = { mode: 'no_new_violations' as const };

    expect(
      store.assert('default', 'project(atlas).', { integrity: migration }).added
    ).toHaveLength(1);
    store.assert('default', 'status(alex, active).', { integrity: migration });
    expect(() =>
      store.assert('default', 'status(alex, terminated).', { integrity: migration })
    ).toThrow(IntegrityViolationError);
    expect(
      store.retract('default', 'status(mira, terminated)', { integrity: migration }).removed
    ).toBe(1);
    expect(store.load('default').map(serializeClause)).not.toContain(
      'status(mira, terminated).'
    );
  });

  it('guards retractions whose closed-world absence would create a violation', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-enforce-negation-'));
    const store = new MemoryStore(root);
    store.assert(
      'default',
      `employee(alice).
       manager(alice, mira).
       :- employee(Person), \\+ manager(Person, _).`
    );
    const before = journal(root);

    expect(() =>
      store.retract('default', 'manager(alice, _)', { integrity: strict() })
    ).toThrow(IntegrityViolationError);
    expect(store.load('default').map(serializeClause)).toContain(
      'manager(alice, mira).'
    );
    expect(journal(root)).toBe(before);
  });

  it('rejects a rule whose derived facts would violate policy', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-enforce-rule-'));
    const store = new MemoryStore(root);
    store.assert('default', 'source(a). :- blocked(X).');

    expect(() =>
      store.assert('default', 'blocked(X) :- source(X).', {
        integrity: strict(),
      })
    ).toThrow(IntegrityViolationError);
    expect(store.load('default').map(serializeClause)).toEqual([
      'source(a).',
      ':- blocked(X).',
    ]);
  });

  it('rejects enabling already-broken policy when the declaration write is strict', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-enforce-policy-'));
    const store = new MemoryStore(root);
    store.assert('default', 'active(mira). suspended(mira).');

    expect(() =>
      store.assert('default', ':- active(X), suspended(X).', {
        integrity: strict(),
      })
    ).toThrow(IntegrityViolationError);
    expect(store.load('default').map(serializeClause)).toEqual([
      'active(mira).',
      'suspended(mira).',
    ]);
  });

  it('fails closed without committing when complete rejection evidence exceeds its cap', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-enforce-cap-'));
    const store = new MemoryStore(root);
    store.assert(
      'default',
      'active(a). active(b). :- active(X), suspended(X).'
    );

    expect(() =>
      store.assert('default', 'suspended(a). suspended(b).', {
        integrity: { mode: 'strict', maxViolations: 1 },
      })
    ).toThrow(/exceeded maxViolations 1/i);
    expect(store.load('default').map(serializeClause)).not.toEqual(
      expect.arrayContaining(['suspended(a).', 'suspended(b).'])
    );
  });

  it('evaluates an explicit cross-namespace candidate view atomically', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-enforce-namespaces-'));
    const store = new MemoryStore(root);
    store.assert('policy', ':- active(Person), suspended(Person).');
    store.assert('work', 'active(mira).');
    const scope = strict(['policy', 'work', 'personal']);

    expect(() =>
      store.assert('personal', 'suspended(mira).', { integrity: scope })
    ).toThrow(IntegrityViolationError);
    expect(store.load('personal')).toEqual([]);
    expect(() =>
      store.assert('personal', 'note(mira, durable).', {
        integrity: strict(['policy', 'work']),
      })
    ).toThrow(/must include target 'personal'/i);
  });

  it('rejects a natural-language delete-and-replace plan without partial retraction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-enforce-remember-'));
    const store = new MemoryStore(root);
    store.assert(
      'default',
      `status(mira, active).
       :- status(Person, terminated), blocked(Person).`
    );
    const llm: LlmClient = {
      complete: async () =>
        'retract status(mira, _).\nstatus(mira, terminated).\nblocked(mira).',
    };
    const before = journal(root);

    await expect(
      rememberText(
        { store, llm },
        'Mira is terminated and blocked now.',
        'default',
        { integrityEnforcement: strict() }
      )
    ).rejects.toThrow(IntegrityViolationError);
    expect(store.load('default').map(serializeClause)).toEqual([
      'status(mira, active).',
      ':- status(Person, terminated), blocked(Person).',
    ]);
    expect(journal(root)).toBe(before);
  });

  it('includes temporal lineage in rejected archive-until evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-enforce-temporal-'));
    const store = new MemoryStore(root);
    store.assert(
      'default',
      'works_at(mira, acme). :- works_at_until(mira, Company, Until).',
      { opId: 'baseline' }
    );
    const at = new Date('2026-08-16T16:59:00.000Z');

    let rejection: IntegrityViolationError | undefined;
    try {
      store.supersede(
        'default',
        ['works_at(mira, _)'],
        'works_at(mira, initech).',
        { opId: 'candidate', at, integrity: strict() }
      );
    } catch (error) {
      if (error instanceof IntegrityViolationError) rejection = error;
      else throw error;
    }

    expect(rejection?.result.checks[0].rows[0].proofs[0]).toMatchObject({
      predicate: 'works_at_until',
      sources: [
        expect.objectContaining({
          opId: 'candidate',
          temporal: {
            kind: 'superseded',
            previousClause: 'works_at(mira, acme).',
            validUntil: at.toISOString(),
          },
        }),
      ],
    });
  });

  it('serializes cross-namespace writers so only one conflicting candidate commits', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rembero-enforce-concurrent-'));
    const memoryRoot = join(home, 'memory');
    new MemoryStore(memoryRoot).assert('policy', ':- left(X), right(X).');
    const modulePath = resolve('dist/index.js');
    const run = (namespace: string, clause: string) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
        const child = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { MemoryStore } from ${JSON.stringify(modulePath)};
             const store = new MemoryStore(process.env.TEST_MEMORY_ROOT);
             try {
               store.assert(${JSON.stringify(namespace)}, ${JSON.stringify(clause)}, {
                 integrity: { mode: 'strict', namespaces: ['policy', 'left', 'right'] }
               });
               console.log('committed');
             } catch (error) {
               if (error?.code === 'integrity_violation') console.log('rejected');
               else throw error;
             }`,
          ],
          {
            env: { ...process.env, TEST_MEMORY_ROOT: memoryRoot },
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
      run('left', 'left(a).'),
      run('right', 'right(a).'),
    ]);
    expect(outcomes.map((outcome) => outcome.code)).toEqual([0, 0]);
    expect(outcomes.map((outcome) => outcome.stdout.trim()).sort()).toEqual([
      'committed',
      'rejected',
    ]);
    expect(outcomes.map((outcome) => outcome.stderr)).toEqual(['', '']);

    const store = new MemoryStore(memoryRoot);
    const committedFacts = store
      .clausesFor(['left', 'right'])
      .map(serializeClause);
    expect(committedFacts).toHaveLength(1);
  });
});
