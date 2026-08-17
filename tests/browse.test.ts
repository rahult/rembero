import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProgram } from '../src/engine/index.js';
import { browseKnowledgeGraph } from '../src/knowledge/browse.js';
import { assertTentativeFacts } from '../src/knowledge/trust-store.js';
import { MemoryStore } from '../src/store/store.js';

function browseStore(label: string): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), `rembero-browse-${label}-`)));
}

describe('bounded personal knowledge graph browsing', () => {
  it('expands an entity-centered explicit-fact neighborhood by exact depth', () => {
    const store = browseStore('depth');
    store.assert('default', 'works_at(mira, acme).', {
      opId: 'mira-employment',
    });
    store.assert('default', 'works_at(rahul, acme).', {
      opId: 'rahul-employment',
    });
    store.assert('default', 'lives_in(rahul, sydney).', {
      opId: 'rahul-home',
    });

    const one = browseKnowledgeGraph(
      store.clausesFor(['default']),
      store.sourcesFor(['default']),
      { focus: 'mira', depth: 1 }
    );
    expect(one).toMatchObject({
      status: 'matches',
      selection: {
        focus: 'mira',
        resolvedFocus: 'mira',
        depth: 1,
        totalGroundFacts: 3,
        selectedClaims: 1,
        selectedEntities: 2,
      },
    });
    expect(one.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'claim',
          predicate: 'works_at',
          values: ['mira', 'acme'],
          sources: [expect.objectContaining({ opId: 'mira-employment' })],
        }),
      ])
    );

    const two = browseKnowledgeGraph(
      store.clausesFor(['default']),
      store.sourcesFor(['default']),
      { focus: 'mira', depth: 2 }
    );
    expect(two.selection.selectedClaims).toBe(2);
    expect(
      two.graph.nodes.some(
        (node) => node.kind === 'claim' && node.predicate === 'lives_in'
      )
    ).toBe(false);

    const three = browseKnowledgeGraph(
      store.clausesFor(['default']),
      store.sourcesFor(['default']),
      { focus: 'mira', depth: 3 }
    );
    expect(three.selection.selectedClaims).toBe(3);
    expect(
      three.graph.nodes.some(
        (node) => node.kind === 'claim' && node.predicate === 'lives_in'
      )
    ).toBe(true);
  });

  it('uses a predicate as the seed and then expands across shared entities', () => {
    const result = browseKnowledgeGraph(
      parseProgram(`
        works_at(mira, acme).
        works_at(rahul, acme).
        lives_in(rahul, sydney).
        unrelated(other).
      `),
      new Map(),
      { predicate: 'works_at', depth: 2 }
    );
    expect(result).toMatchObject({
      selection: { predicate: 'works_at/2', selectedClaims: 3 },
    });
    expect(
      result.graph.nodes.some(
        (node) => node.kind === 'claim' && node.predicate === 'unrelated'
      )
    ).toBe(false);

    const ruleOnly = browseKnowledgeGraph(
      parseProgram('colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.'),
      new Map(),
      { predicate: 'colleague' }
    );
    expect(ruleOnly).toMatchObject({
      status: 'no_match',
      selection: { predicate: 'colleague/2', selectedClaims: 0 },
    });
  });

  it('resolves alias focus and retains canonical identity evidence', () => {
    const store = browseStore('identity');
    store.assert(
      'default',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(works_at, 2, 0).
       works_at('Mira Patel', acme).`,
      { opId: 'identity-source' }
    );
    const result = browseKnowledgeGraph(
      store.clausesFor(['default']),
      store.sourcesFor(['default']),
      { focus: 'Mira Patel', entityIdentity: 'canonical' }
    );
    expect(result.selection).toMatchObject({
      focus: 'Mira Patel',
      resolvedFocus: 'mira',
      focusNodeIds: expect.arrayContaining([
        'entity:["atom","Mira Patel"]',
        'entity:["atom","mira"]',
      ]),
    });
    expect(result.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'claim',
          predicate: 'works_at',
          values: ['mira', 'acme'],
          projectedFrom: "works_at('Mira Patel', acme).",
        }),
        expect.objectContaining({
          id: 'entity:["atom","mira"]',
          kind: 'entity',
          aliases: [expect.objectContaining({ alias: 'Mira Patel' })],
        }),
      ])
    );
  });

  it('keeps tentative facts hidden by default and accepted duplicate witnesses accepted', () => {
    const store = browseStore('trust');
    assertTentativeFacts(store, 'default', 'status(mira, paused).', {
      opId: 'tentative',
    });
    const clauses = store.clausesFor(['default']);
    const sources = store.sourcesFor(['default']);
    expect(
      browseKnowledgeGraph(clauses, sources, { focus: 'mira' }).status
    ).toBe('no_match');
    const included = browseKnowledgeGraph(clauses, sources, {
      focus: 'mira',
      trustMode: 'include_tentative',
    });
    expect(included).toMatchObject({
      trustMode: 'include_tentative',
      graph: {
        nodes: expect.arrayContaining([
          expect.objectContaining({
            kind: 'claim',
            predicate: 'status',
            trust: 'tentative',
          }),
        ]),
      },
    });

    store.assert('default', 'status(mira, paused).', { opId: 'accepted' });
    const accepted = browseKnowledgeGraph(
      store.clausesFor(['default']),
      store.sourcesFor(['default']),
      { focus: 'mira', trustMode: 'include_tentative' }
    );
    const claim = accepted.graph.nodes.find(
      (node) => node.kind === 'claim' && node.predicate === 'status'
    );
    expect(claim?.kind === 'claim' ? claim.trust : undefined).toBeUndefined();
  });

  it('retains temporal facts and multi-namespace provenance', () => {
    const store = browseStore('temporal');
    store.assert('work', "works_at_until(mira, acme, '2026-01-01T00:00:00.000Z').", {
      opId: 'history-source',
    });
    store.assert('personal', 'lives_in(mira, melbourne).', {
      opId: 'home-source',
    });
    const result = browseKnowledgeGraph(
      store.clausesFor(['work', 'personal']),
      store.sourcesFor(['work', 'personal']),
      { focus: 'mira', depth: 1 }
    );
    expect(result.selection.selectedClaims).toBe(2);
    expect(result.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'claim',
          predicate: 'works_at_until',
          sources: [expect.objectContaining({ namespace: 'work', opId: 'history-source' })],
        }),
        expect.objectContaining({
          kind: 'claim',
          predicate: 'lives_in',
          sources: [
            expect.objectContaining({ namespace: 'personal', opId: 'home-source' }),
          ],
        }),
      ])
    );
  });

  it('fails closed on incomplete neighborhoods and reports non-ground stored facts', () => {
    const crowded = parseProgram('link(a, b). link(a, c).');
    crowded.push({
      head: {
        predicate: 'variable_fact',
        args: [{ type: 'var', name: 'X' }],
      },
      body: [],
    });
    expect(() =>
      browseKnowledgeGraph(crowded, new Map(), { focus: 'a', maxClaims: 1 })
    ).toThrow(/exceeded 1 claims/i);

    const skipped = browseKnowledgeGraph(crowded, new Map(), {
      predicate: 'link',
    });
    expect(skipped.skippedNonGroundFacts).toBe(1);

    const huge = parseProgram(
      `wide(${Array.from({ length: 5_001 }, (_, index) => `v${index}`).join(', ')}).`
    );
    expect(() =>
      browseKnowledgeGraph(huge, new Map(), { predicate: 'wide' })
    ).toThrow(/exceeded 5000 nodes/i);
    expect(() => browseKnowledgeGraph([], new Map(), {})).toThrow(/requires/i);
    expect(() =>
      browseKnowledgeGraph([], new Map(), { focus: 'x'.repeat(2_049) })
    ).toThrow(/focus exceeds 2048 bytes/i);
    expect(() =>
      browseKnowledgeGraph([], new Map(), { focus: Number.NaN })
    ).toThrow(/must be finite/i);
    expect(() =>
      browseKnowledgeGraph(parseProgram('p(a). p(a, b).'), new Map(), {
        predicate: 'p',
      })
    ).toThrow(/ambiguous/i);
    expect(() =>
      browseKnowledgeGraph(parseProgram('p(a).'), new Map(), {
        focus: 'a',
        depth: 9,
      })
    ).toThrow(/depth must be from 1 to 8/i);
  });
});
