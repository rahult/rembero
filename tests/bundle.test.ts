import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createKnowledgeBundle,
  KNOWLEDGE_BUNDLE_FORMAT,
  serializeKnowledgeBundle,
  verifyKnowledgeBundle,
  type KnowledgeBundle,
} from '../src/knowledge/bundle.js';
import { assertTentativeFacts } from '../src/knowledge/trust-store.js';
import { MemoryStore } from '../src/store/store.js';

function bundleStore(label: string): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), `rembero-bundle-${label}-`)));
}

function redigest(bundle: KnowledgeBundle): KnowledgeBundle {
  const { sha256: _sha256, ...body } = bundle;
  return {
    ...body,
    sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };
}

describe('content-addressed portable knowledge bundles', () => {
  it('exports raw multi-namespace clauses, metadata, provenance, and deterministic bytes', () => {
    const store = bundleStore('current');
    store.assert(
      'personal',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(works_at, 2, 0).
       works_at('Mira Patel', acme).`,
      { opId: 'identity-source', sourceText: 'Mira works at Acme.' }
    );
    assertTentativeFacts(store, 'personal', 'status(mira, paused).', {
      opId: 'tentative-source',
    });
    store.assert(
      'policy',
      `employee(mira).
       eligible(X) :- employee(X), \\+ suspended(X).
       :- status(Person, active), status(Person, terminated).`,
      { opId: 'policy-source' }
    );

    const first = createKnowledgeBundle(store, {
      namespaces: ['policy', 'personal'],
    });
    const second = createKnowledgeBundle(store, {
      namespaces: ['personal', 'policy'],
    });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      format: KNOWLEDGE_BUNDLE_FORMAT,
      version: 1,
      view: { kind: 'current' },
      namespaces: [
        {
          namespace: 'personal',
          clauses: expect.arrayContaining([
            expect.objectContaining({
              clause: "rembero_alias('Mira Patel', mira).",
              sources: [expect.objectContaining({ opId: 'identity-source' })],
            }),
            expect.objectContaining({
              clause: "rembero_tentative('status(mira, paused).').",
              sources: [expect.objectContaining({ opId: 'tentative-source' })],
            }),
            expect.objectContaining({
              clause: "works_at('Mira Patel', acme).",
              sources: [
                expect.objectContaining({
                  opId: 'identity-source',
                  text: 'Mira works at Acme.',
                }),
              ],
            }),
          ]),
        },
        {
          namespace: 'policy',
          clauses: expect.arrayContaining([
            expect.objectContaining({
              clause: 'eligible(X) :- employee(X), \\+ suspended(X).',
            }),
            expect.objectContaining({
              clause: ':- status(Person, active), status(Person, terminated).',
            }),
          ]),
        },
      ],
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const text = serializeKnowledgeBundle(first);
    expect(text).toBe(serializeKnowledgeBundle(second));
    expect(verifyKnowledgeBundle(text)).toMatchObject({
      valid: true,
      sha256: first.sha256,
      view: { kind: 'current' },
      namespaces: ['personal', 'policy'],
      namespaceCount: 2,
      clauseCount: 7,
      sourceCount: 7,
      bytes: Buffer.byteLength(text, 'utf8'),
    });
  });

  it('exports exact recorded coordinates and namespace-specific duplicate provenance', () => {
    const store = bundleStore('recorded');
    store.assert('first', 'shared_fact(value).', { opId: 'first-source' });
    store.assert('second', 'shared_fact(value).', { opId: 'second-source' });
    store.assert('first', 'later(value).', { opId: 'later-source' });

    const bundle = createKnowledgeBundle(store, {
      namespaces: '*',
      recordedSequence: 2,
    });
    expect(bundle).toMatchObject({
      view: { kind: 'recorded', sequence: 2, journalEntries: 3 },
      namespaces: [
        {
          namespace: 'first',
          clauses: [
            {
              clause: 'shared_fact(value).',
              sources: [expect.objectContaining({ opId: 'first-source' })],
            },
          ],
        },
        {
          namespace: 'second',
          clauses: [
            {
              clause: 'shared_fact(value).',
              sources: [expect.objectContaining({ opId: 'second-source' })],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(bundle)).not.toContain('later(value)');
  });

  it('retains temporal and trust-action source lineage', () => {
    const store = bundleStore('lineage');
    store.assert('default', 'status(mira, active).', { opId: 'before' });
    store.supersede(
      'default',
      ['status(mira, _)'],
      'status(mira, paused).',
      {
        opId: 'change',
        at: new Date('2026-08-17T02:00:00.000Z'),
      }
    );
    const bundle = createKnowledgeBundle(store);
    const clauses = bundle.namespaces[0].clauses;
    expect(clauses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clause: "status_until(mira, active, '2026-08-17T02:00:00.000Z').",
          sources: [
            expect.objectContaining({
              opId: 'change',
              temporal: {
                kind: 'superseded',
                previousClause: 'status(mira, active).',
                validUntil: '2026-08-17T02:00:00.000Z',
              },
            }),
          ],
        }),
      ])
    );
    expect(verifyKnowledgeBundle(bundle).valid).toBe(true);
  });

  it('fails closed on clause, source, order, identity, and digest tampering', () => {
    const store = bundleStore('tamper');
    store.assert('default', 'item(a). item(b).', { opId: 'items' });
    const original = createKnowledgeBundle(store);

    const changed = structuredClone(original);
    changed.namespaces[0].clauses[1].clause = 'item(c).';
    expect(() => verifyKnowledgeBundle(changed)).toThrow(/SHA-256 validation/i);

    const nonCanonical = structuredClone(original);
    nonCanonical.namespaces[0].clauses[0].clause = 'item( a ).';
    expect(() => verifyKnowledgeBundle(redigest(nonCanonical))).toThrow(/must be canonical/i);

    const wrongNamespace = structuredClone(original);
    wrongNamespace.namespaces[0].clauses[0].sources[0].namespace = 'other';
    expect(() => verifyKnowledgeBundle(redigest(wrongNamespace))).toThrow(
      /namespace must match/i
    );

    const hypothetical = structuredClone(original) as unknown as {
      namespaces: Array<{ clauses: Array<{ sources: Array<Record<string, unknown>> }> }>;
    } & KnowledgeBundle;
    hypothetical.namespaces[0].clauses[0].sources[0].hypothetical = true;
    expect(() => verifyKnowledgeBundle(redigest(hypothetical))).toThrow(/unexpected field/i);

    const duplicateSource = structuredClone(original);
    duplicateSource.namespaces[0].clauses[0].sources.push(
      structuredClone(duplicateSource.namespaces[0].clauses[0].sources[0])
    );
    expect(() => verifyKnowledgeBundle(redigest(duplicateSource))).toThrow(/duplicates/i);

    const unsorted = structuredClone(original);
    unsorted.namespaces[0].clauses.reverse();
    expect(() => verifyKnowledgeBundle(redigest(unsorted))).toThrow(/strictly sorted/i);

    const extra = structuredClone(original) as KnowledgeBundle & { extra?: boolean };
    extra.extra = true;
    expect(() => verifyKnowledgeBundle(extra)).toThrow(/unexpected or missing fields/i);
    expect(() => verifyKnowledgeBundle('{bad json')).toThrow(/not valid JSON/i);
  });

  it('exports and verifies an empty current bundle', () => {
    const bundle = createKnowledgeBundle(bundleStore('empty'));
    expect(bundle).toMatchObject({
      view: { kind: 'current' },
      namespaces: [],
    });
    expect(verifyKnowledgeBundle(bundle)).toMatchObject({
      namespaceCount: 0,
      clauseCount: 0,
      sourceCount: 0,
    });
  });
});
