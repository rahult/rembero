import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProgram } from '../src/engine/index.js';
import { profileKnowledge } from '../src/knowledge/profile.js';
import { assertTentativeFacts } from '../src/knowledge/trust-store.js';
import { MemoryStore } from '../src/store/store.js';

describe('deterministic knowledge work profiling', () => {
  it('proves indexed and scan explanations equivalent while reporting selective work', () => {
    const program = parseProgram(
      [
        ...Array.from(
          { length: 1_000 },
          (_, index) => `related(person_${index}, topic_${index % 7}).`
        ),
        'selected(person_999).',
        'relevant(X, Y) :- selected(X), related(X, Y).',
      ].join('\n')
    );
    const result = profileKnowledge(program, 'relevant(X, Y)', new Map(), {
      compareFullScan: true,
    });

    expect(result).toMatchObject({
      equivalent: true,
      explanation: {
        rows: [
          {
            bindings: { X: 'person_999', Y: 'topic_5' },
            proofs: [{ rule: 1 }],
          },
        ],
      },
      indexed: {
        indexedRelationLookups: expect.any(Number),
        indexFactsProcessed: 1_000,
      },
      fullScan: {
        indexedRelationLookups: 0,
        indexFactsProcessed: 0,
      },
      workReduction: {
        candidateFactsAvoided: expect.any(Number),
        candidateVisitRatio: expect.any(Number),
      },
    });
    expect(result.indexed.indexedRelationLookups).toBeGreaterThan(0);
    expect(result.workReduction!.candidateFactsAvoided).toBeGreaterThan(900);
    expect(result.workReduction!.candidateVisitRatio!).toBeGreaterThan(100);
  });

  it('compares recursive and aggregate proofs without timing measurements', () => {
    const recursive = profileKnowledge(
      parseProgram(`
        edge(a, b). edge(b, c). edge(c, d).
        path(X, Y) :- edge(X, Y).
        path(X, Y) :- edge(X, Z), path(Z, Y).
      `),
      'path(a, Y)',
      new Map(),
      { compareFullScan: true }
    );
    expect(recursive.equivalent).toBe(true);
    expect(recursive.explanation.rows.map(({ bindings }) => bindings.Y)).toEqual([
      'b',
      'c',
      'd',
    ]);

    const aggregate = profileKnowledge(
      parseProgram('member(red, alice). member(red, bob).'),
      'count(*) as Count where member(red, Person)',
      new Map(),
      { compareFullScan: true }
    );
    expect(aggregate).toMatchObject({
      equivalent: true,
      explanation: {
        rows: [
          {
            bindings: { Count: '2' },
            proofs: [{ aggregated: true, op: 'count', value: 2 }],
          },
        ],
      },
    });
  });

  it('profiles the same canonical identity and tentative trust evidence view', () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-profile-view-')));
    store.assert(
      'default',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(works_at, 2, 0).
       works_at('Mira Patel', acme).`,
      { opId: 'identity' }
    );
    assertTentativeFacts(store, 'default', 'status(mira, paused).', {
      opId: 'tentative',
    });
    const result = profileKnowledge(
      store.clausesFor(['default']),
      'works_at(mira, Company), status(mira, State)',
      store.sourcesFor(['default']),
      {
        entityIdentity: 'canonical',
        trustMode: 'include_tentative',
      }
    );
    expect(result.explanation.rows[0]).toMatchObject({
      bindings: { Company: 'acme', State: 'paused' },
      proofs: [
        expect.objectContaining({
          projectedFrom: "works_at('Mira Patel', acme).",
        }),
        expect.objectContaining({ trust: 'tentative' }),
      ],
    });
    expect(result.fullScan).toBeUndefined();
    expect(result.equivalent).toBeUndefined();
  });

  it('rejects an untyped comparison flag instead of silently profiling twice', () => {
    expect(() =>
      profileKnowledge([], 'item(X)', new Map(), {
        compareFullScan: 'yes' as never,
      })
    ).toThrow(/must be a boolean/i);
  });
});
