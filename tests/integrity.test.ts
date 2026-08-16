import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EngineLimitError, parseProgram } from '../src/engine/index.js';
import {
  checkIntegrity,
  MAX_INTEGRITY_CONSTRAINTS,
} from '../src/knowledge/integrity.js';
import { MemoryStore } from '../src/store/store.js';

describe('explicit integrity constraints', () => {
  it('distinguishes unconstrained, consistent, and violating knowledge', () => {
    expect(checkIntegrity(parseProgram('person(mira).'))).toMatchObject({
      status: 'unconstrained',
      constraintCount: 0,
      violationCount: 0,
      checks: [],
    });

    const consistent = checkIntegrity(
      parseProgram('active(mira). :- active(X), suspended(X).')
    );
    expect(consistent).toMatchObject({
      status: 'consistent',
      constraintCount: 1,
      violationCount: 0,
    });

    const violating = checkIntegrity(
      parseProgram('active(mira). suspended(mira). :- active(X), suspended(X).')
    );
    expect(violating).toMatchObject({
      status: 'violations',
      constraintCount: 1,
      violationCount: 1,
      checks: [
        {
          clause: ':- active(X), suspended(X).',
          query: 'active(X), suspended(X)',
          rows: [{ bindings: { X: 'mira' } }],
        },
      ],
    });
  });

  it('returns deterministic fact provenance and a query-scoped conflict graph', () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-integrity-')));
    store.assert('personal', 'works_at(mira, acme).', {
      opId: 'fact-left',
      sourceText: 'Mira works at Acme.',
    });
    store.assert('personal', 'works_at(mira, initech).', {
      opId: 'fact-right',
      sourceText: 'Mira works at Initech.',
    });
    store.assert(
      'personal',
      ':- works_at(Person, Left), works_at(Person, Right), Left < Right.',
      { opId: 'policy-single-employer' }
    );

    const run = () =>
      checkIntegrity(
        store.clausesFor(['personal']),
        store.sourcesFor(['personal'])
      );
    const first = run();
    expect(run()).toEqual(first);
    expect(first).toMatchObject({
      status: 'violations',
      constraintCount: 1,
      violationCount: 1,
      checks: [
        {
          sources: [{ opId: 'policy-single-employer', namespace: 'personal' }],
          rows: [
            {
              bindings: { Person: 'mira', Left: 'acme', Right: 'initech' },
              proofs: [
                { predicate: 'works_at', sources: [{ opId: 'fact-left' }] },
                { predicate: 'works_at', sources: [{ opId: 'fact-right' }] },
              ],
            },
          ],
        },
      ],
    });
    expect(first.checks[0].graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'claim', predicate: 'works_at' }),
        expect.objectContaining({ kind: 'result' }),
      ])
    );
  });

  it('checks the selected namespace union and deduplicates the same policy declaration', () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-integrity-ns-')));
    const policy = ':- status(Person, active), status(Person, terminated).';
    store.assert('policy', policy, { opId: 'policy-a' });
    store.assert('work', policy, { opId: 'policy-b' });
    store.assert('work', 'status(mira, active).', { opId: 'active' });
    store.assert('personal', 'status(mira, terminated).', { opId: 'terminated' });

    expect(
      checkIntegrity(
        store.clausesFor(['work', 'personal']),
        store.sourcesFor(['work', 'personal'])
      ).status
    ).toBe('violations');
    const combined = checkIntegrity(
      store.clausesFor(['policy', 'work', 'personal']),
      store.sourcesFor(['policy', 'work', 'personal'])
    );
    expect(combined.constraintCount).toBe(1);
    expect(combined.violationCount).toBe(1);
    expect(combined.checks[0].sources?.map((source) => source.opId)).toEqual([
      'policy-a',
      'policy-b',
    ]);
    expect(
      checkIntegrity(
        store.clausesFor(['personal']),
        store.sourcesFor(['personal'])
      ).status
    ).toBe('unconstrained');
  });

  it('does not treat archived facts as current unless a constraint names them', () => {
    const currentOnly = parseProgram(`
      works_at(mira, initech).
      works_at_until(mira, acme, '2026-08-16T00:00:00.000Z').
      :- works_at(Person, Left), works_at(Person, Right), Left < Right.
    `);
    expect(checkIntegrity(currentOnly).status).toBe('consistent');

    const historicalPolicy = parseProgram(`
      works_at(mira, initech).
      works_at_until(mira, acme, '2026-08-16T00:00:00.000Z').
      :- works_at(Person, Current), works_at_until(Person, Previous, Until), Current != Previous.
    `);
    expect(checkIntegrity(historicalPolicy)).toMatchObject({
      status: 'violations',
      violationCount: 1,
    });
  });

  it('supports bounded alternative evidence for a violation', () => {
    const program = parseProgram(`
      left(a).
      right(a).
      answer(X) :- left(X).
      answer(X) :- right(X).
      :- answer(X).
    `);
    const result = checkIntegrity(program, new Map(), {
      maxProofsPerRow: 2,
    });
    expect(result.checks[0].rows[0]).toMatchObject({
      proofs: [expect.objectContaining({ rule: 1 })],
      alternativeProofs: [[expect.objectContaining({ rule: 2 })]],
    });
    expect(result.checks[0].graph.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'proof' })])
    );
  });

  it('reports closed-world absence evidence inside required-relationship violations', () => {
    const result = checkIntegrity(
      parseProgram(`
        employee(alice).
        employee(bob).
        manager(alice, mira).
        :- employee(Person), \\+ manager(Person, _).
      `)
    );

    expect(result).toMatchObject({
      status: 'violations',
      violationCount: 1,
      checks: [
        {
          rows: [
            {
              bindings: { Person: 'bob' },
              proofs: [
                { predicate: 'employee' },
                { negated: true, predicate: 'manager' },
              ],
            },
          ],
        },
      ],
    });
    expect(result.checks[0].graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'absence', predicate: 'manager' }),
      ])
    );
  });

  it('fails closed on violation and constraint count limits', () => {
    expect(() =>
      checkIntegrity(
        parseProgram('item(a). item(b). :- item(X).'),
        new Map(),
        { maxViolations: 1 }
      )
    ).toThrow(/exceeded maxViolations 1/);

    const constraints = Array.from(
      { length: MAX_INTEGRITY_CONSTRAINTS + 1 },
      (_, index) => `:- marker_${index}.`
    ).join('\n');
    expect(() => checkIntegrity(parseProgram(constraints))).toThrow(EngineLimitError);
  });
});
