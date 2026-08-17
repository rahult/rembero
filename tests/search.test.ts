import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProgram } from '../src/engine/index.js';
import {
  MAX_KNOWLEDGE_SEARCH_LIMIT,
  searchKnowledge,
} from '../src/knowledge/search.js';
import { assertTentativeFacts } from '../src/knowledge/trust-store.js';
import { MemoryStore } from '../src/store/store.js';

function searchStore(label: string): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), `rembero-search-${label}-`)));
}

describe('deterministic local knowledge search', () => {
  it('ranks source, term, predicate, rule, and policy matches with explicit reasons', () => {
    const store = searchStore('ranking');
    store.assert('default', 'works_at(mira, acme).', {
      opId: 'employment',
      sourceText: 'Mira employer is Acme.',
    });
    store.assert('default', 'status(mira, active).', {
      opId: 'status',
      sourceText: 'Mira is active.',
    });
    store.assert(
      'default',
      `colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.
       :- status(Person, active), status(Person, terminated).`,
      { opId: 'rules' }
    );

    const employment = searchKnowledge(
      store.clausesFor(['default']),
      'Mira employer',
      store.sourcesFor(['default'])
    );
    expect(employment.status).toBe('matches');
    expect(employment.results[0]).toMatchObject({
      rank: 1,
      kind: 'fact',
      clause: 'works_at(mira, acme).',
      reasons: expect.arrayContaining([
        { kind: 'source_phrase', token: 'mira employer', points: 180 },
        { kind: 'term', token: 'mira', points: 60 },
      ]),
    });
    expect(employment.results[0].sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          opId: 'employment',
          text: 'Mira employer is Acme.',
        }),
      ])
    );
    expect(employment.results[0].score).toBeGreaterThan(
      employment.results[1]?.score ?? 0
    );

    const rules = searchKnowledge(
      store.clausesFor(['default']),
      'colleagues work',
      store.sourcesFor(['default']),
      { kinds: ['rule'] }
    );
    expect(rules.results[0]).toMatchObject({
      kind: 'rule',
      clause: 'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.',
      reasons: expect.arrayContaining([
        { kind: 'head_predicate', token: 'colleague', points: 120 },
        { kind: 'body_predicate', token: 'work', points: 70 },
      ]),
    });

    const policy = searchKnowledge(
      store.clausesFor(['default']),
      'active terminated',
      store.sourcesFor(['default']),
      { kinds: ['constraint'] }
    );
    expect(policy.results).toMatchObject([
      {
        kind: 'constraint',
        clause: ':- status(Person, active), status(Person, terminated).',
      },
    ]);
  });

  it('marks bounded source ranking while returning complete durable provenance', () => {
    const store = searchStore('source-bound');
    const sourceText = `needle ${'context '.repeat(800)}`;
    store.assert('default', 'note(atlas).', {
      opId: 'long-source',
      sourceText,
    });
    const result = searchKnowledge(
      store.clausesFor(['default']),
      'needle',
      store.sourcesFor(['default'])
    );
    expect(result.results[0]).toMatchObject({
      clause: 'note(atlas).',
      rankingSourceTruncated: true,
      sources: [{ opId: 'long-source', text: sourceText }],
      reasons: expect.arrayContaining([
        { kind: 'source_word', token: 'needle', points: 45 },
      ]),
    });
  });

  it('searches canonical identity and tentative trust views without exposing metadata', () => {
    const store = searchStore('projection');
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
    const clauses = store.clausesFor(['default']);
    const sources = store.sourcesFor(['default']);

    const canonical = searchKnowledge(clauses, 'mira', sources, {
      entityIdentity: 'canonical',
    });
    expect(canonical.results[0]).toMatchObject({
      clause: 'works_at(mira, acme).',
      sources: [{ projectedFrom: "works_at('Mira Patel', acme)." }],
    });
    expect(canonical.results.some(({ clause }) => clause.includes('rembero_alias'))).toBe(
      false
    );
    expect(searchKnowledge(clauses, 'paused', sources).status).toBe('no_match');

    const included = searchKnowledge(clauses, 'paused', sources, {
      trustMode: 'include_tentative',
    });
    expect(included).toMatchObject({
      trustMode: 'include_tentative',
      results: [
        {
          clause: 'status(mira, paused).',
          trust: 'tentative',
          sources: [{ trust: 'tentative' }],
        },
      ],
    });

    const acceptedStore = searchStore('accepted-witness');
    acceptedStore.assert('default', 'status(mira, paused).', {
      opId: 'accepted',
    });
    assertTentativeFacts(acceptedStore, 'default', 'status(mira, paused).', {
      opId: 'also-tentative',
    });
    const accepted = searchKnowledge(
      acceptedStore.clausesFor(['default']),
      'paused',
      acceptedStore.sourcesFor(['default']),
      { trustMode: 'include_tentative' }
    );
    expect(accepted.results[0].trust).toBeUndefined();
  });

  it('applies deterministic kind, limit, truncation, fuzzy, and no-match behavior', () => {
    const program = parseProgram(`
      item(alpha). item(beta). item(gamma).
      colleague(X, Y) :- item(X), item(Y), X != Y.
    `);
    const limited = searchKnowledge(program, 'item', new Map(), {
      kinds: ['fact'],
      limit: 2,
    });
    expect(limited).toMatchObject({
      totalCandidates: 3,
      matchCount: 3,
      returnedCount: 2,
      truncated: true,
      results: [{ rank: 1 }, { rank: 2 }],
    });

    const fuzzy = searchKnowledge(program, 'collegue');
    expect(fuzzy.results[0]).toMatchObject({
      kind: 'rule',
      reasons: [{ kind: 'fuzzy_predicate', token: 'collegue', points: 30 }],
    });
    expect(searchKnowledge(program, 'dentist').status).toBe('no_match');
  });

  it('keeps recursive define and dependency edges distinct in the result graph', () => {
    const result = searchKnowledge(
      parseProgram('path(X, Y) :- edge(X, Y). path(X, Y) :- edge(X, Z), path(Z, Y).'),
      'path',
      new Map(),
      { limit: 2 }
    );
    const recursiveClause = result.graph.nodes.find(
      (node) =>
        node.kind === 'clause' && node.clause.includes('path(Z, Y)')
    );
    expect(recursiveClause).toBeDefined();
    expect(result.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'defines',
          from: recursiveClause?.id,
          to: 'predicate:path/2',
        }),
        expect.objectContaining({
          kind: 'depends_on',
          from: recursiveClause?.id,
          to: 'predicate:path/2',
        }),
      ])
    );
  });

  it('rejects empty terms, invalid kinds, and out-of-range limits', () => {
    expect(() => searchKnowledge([], '---')).toThrow(/no searchable words/i);
    expect(() =>
      searchKnowledge([], 'item', new Map(), { kinds: [] })
    ).toThrow(/must not be empty/i);
    expect(() =>
      searchKnowledge([], 'item', new Map(), {
        kinds: ['metadata' as never],
      })
    ).toThrow(/kind must be/i);
    expect(() =>
      searchKnowledge([], 'item', new Map(), {
        limit: MAX_KNOWLEDGE_SEARCH_LIMIT + 1,
      })
    ).toThrow(/limit must be from 1 to 100/i);
    expect(() =>
      searchKnowledge(
        [],
        Array.from({ length: 257 }, (_, index) => `word_${index}`).join(' ')
      )
    ).toThrow(/exceeds 256 words/i);
  });
});
