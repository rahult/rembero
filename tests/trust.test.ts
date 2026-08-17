import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalKey, parseProgram, serializeClause } from '../src/engine/index.js';
import { explainKnowledge } from '../src/knowledge/graph.js';
import { IntegrityViolationError } from '../src/knowledge/enforcement.js';
import {
  canonicalizeKnowledge,
  literalKnowledge,
} from '../src/knowledge/identity.js';
import {
  TrustMetadataError,
  decodeTentativeDeclaration,
  listTentativeClaims,
  projectTrustKnowledge,
  tentativeClaimId,
  wrapTentativeFacts,
} from '../src/knowledge/trust.js';
import { MemoryStore, OperationConflictError } from '../src/store/store.js';

describe('reviewable tentative knowledge', () => {
  it('encodes only bounded ordinary ground facts with stable identities', () => {
    const wrapped = wrapTentativeFacts(
      "works_at(mira, acme). prefers(mira, 'Flat White')."
    );
    expect(wrapped.map(serializeClause)).toEqual([
      "rembero_tentative('works_at(mira, acme).').",
      "rembero_tentative('prefers(mira, ''Flat White'').').",
    ]);
    expect(decodeTentativeDeclaration(wrapped[0])).toEqual(
      parseProgram('works_at(mira, acme).')[0]
    );
    expect(tentativeClaimId(wrapped[0])).toMatch(/^tentative:[a-f0-9]{64}$/);
    expect(tentativeClaimId(wrapped[0])).toBe(tentativeClaimId(wrapped[0]));

    for (const invalid of [
      'derived(X) :- base(X).',
      ':- active(X), suspended(X).',
      "rembero_alias('Mira Patel', mira).",
      "rembero_tentative('item(a).').",
    ]) {
      expect(() => wrapTentativeFacts(invalid), invalid).toThrow(TrustMetadataError);
    }
    expect(() =>
      wrapTentativeFacts([
        {
          head: {
            predicate: 'status',
            args: [{ type: 'var', name: 'Person' }],
          },
          body: [],
        },
      ])
    ).toThrow(/ordinary ground fact/i);
  });

  it('excludes tentative claims by default and projects them only on explicit reads', () => {
    const declaration = wrapTentativeFacts('works_at(mira, acme).')[0];
    const clauses = [declaration, ...parseProgram('person(mira).')];

    expect(literalKnowledge(clauses).clauses.map(serializeClause)).toEqual([
      'person(mira).',
    ]);
    const included = literalKnowledge(clauses, new Map(), 'include_tentative');
    expect(included.clauses.map(serializeClause)).toEqual([
      'works_at(mira, acme).',
      'person(mira).',
    ]);
    expect(included.exactClaims).not.toContain('works_at(mira, acme).');
    expect(included.projections.get('works_at(mira, acme).')).toEqual([
      {
        projectedFrom: "rembero_tentative('works_at(mira, acme).').",
        identityRewrites: [],
        trust: 'tentative',
      },
    ]);
    expect(
      projectTrustKnowledge(clauses, new Map(), 'accepted').clauses.map(
        serializeClause
      )
    ).toEqual(['person(mira).']);
  });

  it('carries tentative provenance through proofs, sources, and graph nodes', () => {
    const store = new MemoryStore(
      mkdtempSync(join(tmpdir(), 'rembero-trust-proof-'))
    );
    store.assertTentative('personal', 'works_at(mira, acme).', {
      opId: 'tentative-source',
      sourceText: 'Mira may work at Acme.',
    });
    const clauses = store.clausesFor(['personal']);
    const sources = store.sourcesFor(['personal']);

    expect(explainKnowledge(clauses, 'works_at(mira, Company)', sources).rows).toEqual([]);
    const explanation = explainKnowledge(
      clauses,
      'works_at(mira, Company)',
      sources,
      { trustMode: 'include_tentative' }
    );
    expect(explanation.rows[0]).toMatchObject({
      bindings: { Company: 'acme' },
      proofs: [
        {
          predicate: 'works_at',
          trust: 'tentative',
          projectedFrom: "rembero_tentative('works_at(mira, acme).').",
          sources: [
            {
              opId: 'tentative-source',
              trust: 'tentative',
            },
          ],
        },
      ],
    });
    expect(explanation.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'claim',
          predicate: 'works_at',
          trust: 'tentative',
        }),
      ])
    );
  });

  it('propagates tentative trust through derived and aggregate conclusions', () => {
    const clauses = [
      ...wrapTentativeFacts('member(red, alice).'),
      ...parseProgram(`
        has_member(Team) :- member(Team, Person).
        team_size(Team, Count) :- count(*) as Count where member(Team, Person).
      `),
    ];
    const derived = explainKnowledge(
      clauses,
      'has_member(red), team_size(red, Count)',
      new Map(),
      { trustMode: 'include_tentative' }
    );
    expect(derived.rows[0]).toMatchObject({
      proofs: [
        { predicate: 'has_member', trust: 'tentative' },
        {
          predicate: 'team_size',
          trust: 'tentative',
          aggregate: { trust: 'tentative' },
        },
      ],
    });
    expect(derived.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'claim',
          predicate: 'has_member',
          trust: 'tentative',
        }),
        expect.objectContaining({ kind: 'aggregate', trust: 'tentative' }),
      ])
    );
  });

  it('combines tentative trust and canonical identity without changing durable clauses', () => {
    const clauses = [
      ...parseProgram(`
        rembero_alias('Mira Patel', mira).
        rembero_entity_position(works_at, 2, 0).
      `),
      ...wrapTentativeFacts("works_at('Mira Patel', acme)."),
    ];
    const view = canonicalizeKnowledge(
      clauses,
      new Map(),
      'include_tentative'
    );
    expect(view.clauses.map(serializeClause)).toEqual(['works_at(mira, acme).']);
    expect(view.projections.get('works_at(mira, acme).')).toMatchObject([
      {
        trust: 'tentative',
        identityRewrites: [
          { original: 'Mira Patel', canonical: 'mira', position: 0 },
        ],
      },
    ]);
    expect(clauses.map(serializeClause)).toContain(
      "rembero_tentative('works_at(''Mira Patel'', acme).')."
    );
  });

  it('keeps an accepted duplicate authoritative while retaining tentative alternatives', () => {
    const store = new MemoryStore(
      mkdtempSync(join(tmpdir(), 'rembero-trust-duplicate-'))
    );
    store.assertTentative('personal', 'status(mira, active).', { opId: 'tentative' });
    store.assert('personal', 'status(mira, active).', { opId: 'accepted' });
    const explanation = explainKnowledge(
      store.clausesFor(['personal']),
      'status(mira, active)',
      store.sourcesFor(['personal']),
      { trustMode: 'include_tentative', maxProofsPerRow: 2 }
    );
    expect(explanation.rows[0].proofs[0]).toMatchObject({
      sources: [{ opId: 'accepted' }],
      sourceAlternatives: [
        expect.objectContaining({ opId: 'tentative', trust: 'tentative' }),
      ],
    });
    expect(explanation.rows[0].proofs[0]).not.toHaveProperty('trust');
  });

  it('lists tentative declarations with their exact durable sources', () => {
    const declaration = wrapTentativeFacts('status(mira, active).')[0];
    const sources = new Map([
      [
        canonicalKey(declaration),
        [
          {
            namespace: 'personal',
            opId: 'claim-source',
            ts: '2026-08-17T00:00:00.000Z',
          },
        ],
      ],
    ]);
    expect(listTentativeClaims([declaration], sources)).toEqual([
      {
        id: tentativeClaimId(declaration),
        clause: 'status(mira, active).',
        declaration: "rembero_tentative('status(mira, active).').",
        sources: [expect.objectContaining({ opId: 'claim-source' })],
      },
    ]);
  });

  it('atomically accepts or rejects exact claims with retry-safe operations', () => {
    const store = new MemoryStore(
      mkdtempSync(join(tmpdir(), 'rembero-trust-resolution-'))
    );
    const asserted = store.assertTentative(
      'personal',
      'status(mira, active). prefers(mira, tea).',
      { opId: 'tentative-batch' }
    );
    expect(asserted.added).toHaveLength(2);
    expect(store.load('personal').map(serializeClause)).toEqual([
      "rembero_tentative('status(mira, active).').",
      "rembero_tentative('prefers(mira, tea).').",
    ]);

    const accepted = store.resolveTentative(
      'personal',
      'status(mira, active).',
      'accept',
      { opId: 'accept-status' }
    );
    expect(accepted).toMatchObject({ retracted: 1, duplicates: 0 });
    expect(accepted.added.map(serializeClause)).toEqual(['status(mira, active).']);
    expect(
      store.resolveTentative(
        'personal',
        'status(mira, active).',
        'accept',
        { opId: 'accept-status' }
      )
    ).toEqual(accepted);
    expect(() =>
      store.resolveTentative(
        'personal',
        'status(mira, active).',
        'reject',
        { opId: 'accept-status' }
      )
    ).toThrow(OperationConflictError);

    const rejected = store.resolveTentative(
      'personal',
      'prefers(mira, tea).',
      'reject',
      { opId: 'reject-preference' }
    );
    expect(rejected).toMatchObject({ retracted: 1, added: [] });
    expect(store.load('personal').map(serializeClause)).toEqual([
      'status(mira, active).',
    ]);
    expect(store.sourcesFor(['personal']).get('status(mira, active).')).toMatchObject([
      { opId: 'accept-status', trustAction: 'accept' },
    ]);
    expect(store.history('status(mira, active)', { namespaces: ['personal'] })).toMatchObject({
      events: [expect.objectContaining({ action: 'asserted', trustAction: 'accept' })],
    });
  });

  it('reserves direct trust metadata mutation while preserving portable import', () => {
    const store = new MemoryStore(
      mkdtempSync(join(tmpdir(), 'rembero-trust-authority-'))
    );
    const declaration = "rembero_tentative('status(mira, active).').";
    expect(() => store.assert('personal', declaration)).toThrow(
      /typed tentative/i
    );
    const bodyUse =
      "bad(dummy) :- rembero_tentative('status(mira, active).').";
    expect(() => store.assert('personal', bodyUse)).toThrow(
      /reserved trust metadata.*cannot appear/i
    );
    expect(() => store.importClauses('personal', bodyUse)).toThrow(
      /reserved trust metadata.*cannot appear/i
    );
    expect(() =>
      store.replace(
        'personal',
        ['status(mira, _)'],
        declaration
      )
    ).toThrow(/typed tentative/i);
    expect(() =>
      store.replace('personal', ['status(mira, _)'], bodyUse)
    ).toThrow(/reserved trust metadata.*cannot appear/i);
    expect(store.importClauses('personal', declaration).added).toHaveLength(1);
    expect(store.load('personal').map(serializeClause)).toEqual([declaration]);
    expect(() =>
      store.retract('personal', "rembero_tentative('status(mira, active).')")
    ).toThrow(/use resolveTentative/i);
    expect(() =>
      store.supersede(
        'personal',
        ["rembero_tentative('status(mira, active).')"],
        'status(mira, paused).'
      )
    ).toThrow(/use resolveTentative/i);
    expect(store.load('personal').map(serializeClause)).toEqual([declaration]);
  });

  it('requires every resolved claim to exist and preserves atomic integrity authority', () => {
    const store = new MemoryStore(
      mkdtempSync(join(tmpdir(), 'rembero-trust-enforcement-'))
    );
    store.assert(
      'personal',
      'active(mira). :- active(Person), suspended(Person).'
    );
    store.assertTentative('personal', 'suspended(mira).', {
      opId: 'tentative-suspension',
    });
    const before = store.load('personal');

    expect(() =>
      store.resolveTentative('personal', 'missing(mira).', 'accept')
    ).toThrow(/all 1 requested claims/i);
    expect(store.load('personal')).toEqual(before);
    expect(() =>
      store.resolveTentative(
        'personal',
        'suspended(mira).',
        'accept',
        { integrity: { mode: 'strict' } }
      )
    ).toThrow(IntegrityViolationError);
    expect(store.load('personal')).toEqual(before);
  });
});
