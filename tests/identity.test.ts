import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalKey,
  parseProgram,
  parseQuerySpec,
  serializeClause,
  serializeQuerySpec,
} from '../src/engine/index.js';
import {
  EntityIdentityError,
  MAX_ENTITY_ALIASES,
  MAX_ENTITY_POSITIONS,
  buildEntityResolver,
  canonicalizeKnowledge,
} from '../src/knowledge/identity.js';
import { MemoryStore } from '../src/store/store.js';
import { explainKnowledge } from '../src/knowledge/graph.js';
import {
  checkIntegrityTool,
  explainQueryTool,
  historyTool,
  listMemoriesTool,
  queryTool,
} from '../src/mcp/tools.js';

describe('explicit entity identity', () => {
  it('canonicalizes only declared entity positions, including temporal companions', () => {
    const program = parseProgram(`
      rembero_alias('Mira Patel', mira_patel).
      rembero_alias(mira_patel, mira).
      rembero_entity_position(works_at, 2, 0).
      works_at('Mira Patel', acme).
      works_at_until(mira_patel, acme, '2026-08-17T00:00:00.000Z').
      status('Mira Patel', active).
      colleague(X, mira_patel) :- works_at(X, acme).
      :- works_at('Mira Patel', acme), suspended(mira_patel).
    `);
    const view = canonicalizeKnowledge(program);

    expect(view.resolver.resolve('Mira Patel')).toBe('mira');
    expect(view.resolver.positions()).toEqual([
      { predicate: 'works_at', arity: 2, position: 0 },
    ]);
    expect(view.clauses.map(serializeClause)).toEqual([
      'works_at(mira, acme).',
      "works_at_until(mira, acme, '2026-08-17T00:00:00.000Z').",
      "status('Mira Patel', active).",
      'colleague(X, mira_patel) :- works_at(X, acme).',
      ':- works_at(mira, acme), suspended(mira_patel).',
    ]);
    const query = view.resolver.canonicalizeQuery(
      parseQuerySpec("works_at('Mira Patel', Company)")
    );
    expect(serializeQuerySpec(query.query)).toBe('works_at(mira, Company)');
    expect(query.rewrites).toMatchObject([
      { predicate: 'works_at', position: 0, original: 'Mira Patel', canonical: 'mira' },
    ]);
  });

  it('preserves aggregate rule semantics through canonical projection', () => {
    const program = parseProgram(`
      rembero_alias('Bob Smith', bob).
      rembero_entity_position(member, 2, 1).
      member(red, 'Bob Smith').
      team_size(Team, Count) :- count(*) as Count where member(Team, Person).
    `);
    const view = canonicalizeKnowledge(program);
    expect(view.clauses.map(serializeClause)).toEqual([
      'member(red, bob).',
      'team_size(Team, Count) :- count(*) as Count where member(Team, Person).',
    ]);
    const explanation = explainKnowledge(
      program,
      'team_size(red, Count)',
      new Map(),
      { entityIdentity: 'canonical' }
    );
    expect(explanation.rows[0]).toMatchObject({
      bindings: { Count: '1' },
      proofs: [
        {
          aggregate: {
            contributors: [
              {
                proofs: [
                  expect.objectContaining({
                    predicate: 'member',
                    projectedFrom: "member(red, 'Bob Smith').",
                  }),
                ],
              },
            ],
          },
        },
      ],
    });
  });

  it('fails closed on conflicts, cycles, malformed metadata, or reserved executable use', () => {
    const invalid = [
      "rembero_alias(mira, person_one). rembero_alias(mira, person_two).",
      'rembero_alias(a, b). rembero_alias(b, a).',
      'rembero_alias(mira, mira).',
      'rembero_alias(X, mira).',
      'rembero_alias(mira).',
      'rembero_entity_position(works_at, 2, 2).',
      'rembero_entity_position(rembero_alias, 2, 0).',
      'known(X) :- rembero_alias(X, mira).',
      ':- person(X), rembero_entity_position(person, 1, 0).',
    ];
    for (const program of invalid) {
      expect(() => buildEntityResolver(parseProgram(program)), program).toThrow();
    }
    expect(() =>
      buildEntityResolver(parseProgram('rembero_alias(a, b). rembero_alias(b, a).'))
    ).toThrow(EntityIdentityError);
  });

  it('counts effective declarations rather than duplicate namespace copies against limits', () => {
    const alias = parseProgram('rembero_alias(mira_patel, mira).')[0];
    const position = parseProgram('rembero_entity_position(works_at, 2, 0).')[0];
    expect(() =>
      buildEntityResolver(Array.from({ length: MAX_ENTITY_ALIASES + 1 }, () => alias))
    ).not.toThrow();
    expect(() =>
      buildEntityResolver(Array.from({ length: MAX_ENTITY_POSITIONS + 1 }, () => position))
    ).not.toThrow();
  });

  it('deduplicates projected claims while preserving literal source evidence', () => {
    const clauses = parseProgram(`
      rembero_alias('Mira Patel', mira).
      rembero_entity_position(likes, 2, 0).
      likes('Mira Patel', tea).
      likes(mira, tea).
    `);
    const first = clauses[2];
    const second = clauses[3];
    const sources = new Map([
      [
        canonicalKey(first),
        [{ namespace: 'personal', opId: 'alias-source', ts: '2026-08-17T00:00:00.000Z' }],
      ],
      [
        canonicalKey(second),
        [{ namespace: 'work', opId: 'canonical-source', ts: '2026-08-17T00:01:00.000Z' }],
      ],
    ]);
    const view = canonicalizeKnowledge(clauses, sources);

    expect(view.clauses.map(serializeClause)).toEqual(['likes(mira, tea).']);
    expect(view.sources.get('likes(mira, tea).')).toMatchObject([
      { opId: 'canonical-source' },
      {
        opId: 'alias-source',
        projectedFrom: "likes('Mira Patel', tea).",
        identityRewrites: [{ position: 0, original: 'Mira Patel', canonical: 'mira' }],
      },
    ]);
  });

  it('exposes projection evidence without durable sources and prefers an exact claim', () => {
    const projectedOnly = parseProgram(`
      rembero_alias('Mira Patel', mira).
      rembero_entity_position(works_at, 2, 0).
      works_at('Mira Patel', acme).
    `);
    const explanation = explainKnowledge(
      projectedOnly,
      'works_at(mira, Company)',
      new Map(),
      { entityIdentity: 'canonical' }
    );
    expect(explanation.rows[0].proofs[0]).toMatchObject({
      projectedFrom: "works_at('Mira Patel', acme).",
      identityRewrites: [
        { predicate: 'works_at', position: 0, original: 'Mira Patel', canonical: 'mira' },
      ],
    });
    expect(explanation.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'claim',
          projectedFrom: "works_at('Mira Patel', acme).",
        }),
      ])
    );

    const ruleExplanation = explainKnowledge(
      [
        ...projectedOnly,
        ...parseProgram("employed(mira) :- works_at('Mira Patel', acme)."),
      ],
      'employed(mira)',
      new Map(),
      { entityIdentity: 'canonical' }
    );
    expect(ruleExplanation.rules[0]).toMatchObject({
      clause: 'employed(mira) :- works_at(mira, acme).',
      projectedFrom: "employed(mira) :- works_at('Mira Patel', acme).",
      identityRewrites: [
        { predicate: 'works_at', position: 0, original: 'Mira Patel', canonical: 'mira' },
      ],
    });

    const withExact = canonicalizeKnowledge([
      ...projectedOnly,
      ...parseProgram('works_at(mira, acme).'),
    ]);
    expect(withExact.exactClaims).toContain('works_at(mira, acme).');
    const exactExplanation = explainKnowledge(
      [...projectedOnly, ...parseProgram('works_at(mira, acme).')],
      'works_at(mira, Company)',
      new Map(),
      { entityIdentity: 'canonical' }
    );
    expect(exactExplanation.rows[0].proofs[0]).not.toHaveProperty('projectedFrom');
  });

  it('keeps literal queries unchanged and makes canonical reads explicit', () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-identity-read-')));
    store.assert(
      'personal',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(works_at, 2, 0).
       works_at('Mira Patel', acme).`,
      { opId: 'identity-and-fact' }
    );

    expect(
      queryTool(
        { store },
        { query: 'works_at(mira, Company)', namespaces: ['personal'] }
      ).bindings
    ).toEqual([]);
    expect(
      queryTool(
        { store },
        {
          query: 'works_at(mira, Company)',
          namespaces: ['personal'],
          entityIdentity: 'canonical',
        }
      ).bindings
    ).toEqual([{ Company: 'acme' }]);
    expect(
      queryTool(
        { store },
        {
          query: "works_at('Mira Patel', Company)",
          namespaces: ['personal'],
          entityIdentity: 'canonical',
        }
      ).bindings
    ).toEqual([{ Company: 'acme' }]);

    const listing = listMemoriesTool({ store }, { namespaces: ['personal'] });
    expect(listing.predicates.map((group) => group.predicate)).toEqual(['works_at/2']);
    expect(listing.aliases).toMatchObject([
      { alias: 'Mira Patel', canonical: 'mira', sources: [{ opId: 'identity-and-fact' }] },
    ]);
    expect(listing.entityPositions).toMatchObject([
      { predicate: 'works_at', arity: 2, position: 0 },
    ]);
  });

  it('keeps literal reads available when canonical metadata is invalid', () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-identity-invalid-')));
    store.assert(
      'personal',
      `rembero_alias(mira, person_one).
       rembero_alias(mira, person_two).
       works_at(mira, acme).`
    );

    expect(
      queryTool({ store }, { query: 'works_at(mira, Company)', namespaces: ['personal'] })
        .bindings
    ).toEqual([{ Company: 'acme' }]);
    expect(() =>
      queryTool(
        { store },
        {
          query: 'works_at(mira, Company)',
          namespaces: ['personal'],
          entityIdentity: 'canonical',
        }
      )
    ).toThrow(EntityIdentityError);
    expect(listMemoriesTool({ store }, { namespaces: ['personal'] })).toMatchObject({
      predicates: [{ predicate: 'works_at/2', facts: ['works_at(mira, acme).'] }],
      identityError: {
        code: 'entity_identity_error',
        message: expect.stringContaining('conflicts'),
      },
    });
  });

  it('carries literal source projection and alias provenance into the canonical graph', () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-identity-graph-')));
    store.assert(
      'personal',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(works_at, 2, 0).`,
      { opId: 'identity-policy' }
    );
    store.assert('personal', "works_at('Mira Patel', acme).", {
      opId: 'employment-source',
      sourceText: 'Mira Patel works at Acme.',
    });
    store.assert('personal', 'label(mira).');

    const result = explainQueryTool(
      { store },
      {
        query: 'works_at(mira, Company), label(mira)',
        namespaces: ['personal'],
        entityIdentity: 'canonical',
      }
    );
    expect(result.rows[0].proofs[0]).toMatchObject({
      predicate: 'works_at',
      values: ['mira', 'acme'],
      sources: [
        {
          opId: 'employment-source',
          projectedFrom: "works_at('Mira Patel', acme).",
          identityRewrites: [
            { position: 0, original: 'Mira Patel', canonical: 'mira' },
          ],
        },
      ],
    });
    expect(result.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'entity',
          value: 'mira',
          aliases: [
            expect.objectContaining({ alias: 'Mira Patel', sources: [expect.objectContaining({ opId: 'identity-policy' })] }),
          ],
        }),
      ])
    );
    expect(
      result.graph.nodes.find((node) => node.kind === 'entity' && node.value === 'acme')
    ).not.toHaveProperty('aliases');
  });

  it('lets opt-in integrity catch a conflict split across explicit aliases', () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-identity-integrity-')));
    store.assert(
      'personal',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(status, 2, 0).
       status('Mira Patel', active).
       status(mira, terminated).
       :- status(Person, active), status(Person, terminated).`
    );

    expect(checkIntegrityTool({ store }, { namespaces: ['personal'] }).status).toBe(
      'consistent'
    );
    expect(
      checkIntegrityTool(
        { store },
        { namespaces: ['personal'], entityIdentity: 'canonical' }
      )
    ).toMatchObject({
      status: 'violations',
      violationCount: 1,
      checks: [{ rows: [{ bindings: { Person: 'mira' } }] }],
    });
  });

  it('keeps durable history literal instead of rewriting stored identity', () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-identity-history-')));
    store.assert(
      'personal',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(works_at, 2, 0).
       works_at('Mira Patel', acme).`,
      { opId: 'literal-history' }
    );

    expect(
      historyTool(
        { store },
        { pattern: "works_at('Mira Patel', _)", namespaces: ['personal'] }
      ).events
    ).toEqual([
      expect.objectContaining({
        clause: "works_at('Mira Patel', acme).",
        opId: 'literal-history',
      }),
    ]);
    expect(
      historyTool(
        { store },
        { pattern: 'works_at(mira, _)', namespaces: ['personal'] }
      ).events
    ).toEqual([]);
  });
});
