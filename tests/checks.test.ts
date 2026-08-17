import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProgram } from '../src/engine/index.js';
import {
  MAX_KNOWLEDGE_CHECKS,
  MAX_KNOWLEDGE_CHECK_EXPECTED_ROWS,
  parseKnowledgeCheckSuite,
  runKnowledgeChecks,
  type KnowledgeCheckSuite,
} from '../src/knowledge/checks.js';
import { assertTentativeFacts } from '../src/knowledge/trust-store.js';
import { MemoryStore } from '../src/store/store.js';

function suite(...checks: KnowledgeCheckSuite['checks']): KnowledgeCheckSuite {
  return { version: 1, checks };
}

describe('deterministic knowledge regression suites', () => {
  it('passes empty, nonempty, exact-order, and set-row expectations compactly', () => {
    const clauses = parseProgram(`
      item(a). item(b). blocked(b).
      available(X) :- item(X), \\+ blocked(X).
    `);
    const result = runKnowledgeChecks(
      clauses,
      new Map(),
      suite(
        { name: 'available exists', query: 'available(X)', expect: { kind: 'nonempty' } },
        { name: 'nothing missing', query: 'missing(X)', expect: { kind: 'empty' } },
        {
          name: 'item order',
          query: 'item(X)',
          expect: {
            kind: 'rows',
            order: 'exact',
            rows: [{ X: 'a' }, { X: 'b' }],
          },
        },
        {
          name: 'item set',
          query: 'item(X)',
          expect: {
            kind: 'rows',
            order: 'set',
            rows: [{ X: 'b' }, { X: 'a' }],
          },
        }
      )
    );

    expect(result).toMatchObject({
      status: 'passed',
      checkCount: 4,
      passedCount: 4,
      failedCount: 0,
      checks: [
        { name: 'available exists', status: 'passed', actualRows: [{ X: 'a' }] },
        { name: 'nothing missing', status: 'passed', actualRows: [] },
        { name: 'item order', status: 'passed', orderMismatch: false },
        { name: 'item set', status: 'passed', orderMismatch: false },
      ],
    });
    expect(result.checks.every((check) => check.explanation === undefined)).toBe(true);

    const withEvidence = runKnowledgeChecks(
      clauses,
      new Map(),
      suite({
        name: 'proof retained',
        query: 'available(a)',
        expect: { kind: 'nonempty' },
      }),
      { includePassingEvidence: true }
    );
    expect(withEvidence.checks[0].explanation?.rows[0].proofs[0]).toMatchObject({
      rule: 1,
    });
  });

  it('returns exact row deltas, order mismatch, proofs, and why-not evidence on failure', () => {
    const clauses = parseProgram('item(a). item(b).');
    const result = runKnowledgeChecks(
      clauses,
      new Map(),
      suite(
        {
          name: 'wrong rows',
          query: 'item(X)',
          expect: {
            kind: 'rows',
            order: 'set',
            rows: [{ X: 'a' }, { X: 'c' }],
          },
        },
        {
          name: 'wrong order',
          query: 'item(X)',
          expect: {
            kind: 'rows',
            order: 'exact',
            rows: [{ X: 'b' }, { X: 'a' }],
          },
        },
        { name: 'expected empty', query: 'item(X)', expect: { kind: 'empty' } },
        { name: 'expected result', query: 'missing(a)', expect: { kind: 'nonempty' } }
      )
    );

    expect(result).toMatchObject({
      status: 'failed',
      passedCount: 0,
      failedCount: 4,
      checks: [
        {
          name: 'wrong rows',
          missingRows: [{ X: 'c' }],
          unexpectedRows: [{ X: 'b' }],
          explanation: { rows: [{ bindings: { X: 'a' } }, { bindings: { X: 'b' } }] },
        },
        {
          name: 'wrong order',
          missingRows: [],
          unexpectedRows: [],
          orderMismatch: true,
        },
        {
          name: 'expected empty',
          unexpectedRows: [{ X: 'a' }, { X: 'b' }],
          explanation: { rows: expect.any(Array) },
        },
        {
          name: 'expected result',
          actualRows: [],
          whyNot: {
            status: 'blocked',
            failures: [{ reason: 'missing_fact', goal: 'missing(a)' }],
          },
        },
      ],
    });
  });

  it('uses the same identity and tentative trust projection as reasoning', () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-check-view-')));
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
    const checks = suite(
      {
        name: 'canonical employment',
        query: 'works_at(mira, Company)',
        expect: {
          kind: 'rows',
          order: 'exact',
          rows: [{ Company: 'acme' }],
        },
      },
      {
        name: 'tentative status',
        query: 'status(mira, State)',
        expect: {
          kind: 'rows',
          order: 'exact',
          rows: [{ State: 'paused' }],
        },
      }
    );
    const result = runKnowledgeChecks(
      store.clausesFor(['default']),
      store.sourcesFor(['default']),
      checks,
      {
        entityIdentity: 'canonical',
        trustMode: 'include_tentative',
        includePassingEvidence: true,
      }
    );
    expect(result.status).toBe('passed');
    expect(result.checks[0].explanation?.rows[0].proofs[0]).toMatchObject({
      projectedFrom: "works_at('Mira Patel', acme).",
    });
    expect(result.checks[1].explanation?.rows[0].proofs[0]).toMatchObject({
      trust: 'tentative',
    });
  });

  it('normalizes standalone JSON and rejects malformed or ambiguous suites', () => {
    const normalized = parseKnowledgeCheckSuite(
      JSON.stringify(
        suite({
          name: 'set order',
          query: 'item(X)',
          expect: {
            kind: 'rows',
            order: 'set',
            rows: [{ X: 'b' }, { X: 'a' }],
          },
        })
      )
    );
    expect(normalized.checks[0].expect).toEqual({
      kind: 'rows',
      order: 'set',
      rows: [{ X: 'a' }, { X: 'b' }],
    });
    expect(() => parseKnowledgeCheckSuite('{bad')).toThrow(/not valid JSON/i);
    expect(() => parseKnowledgeCheckSuite({ version: 2, checks: [] } as never)).toThrow(
      /version must be 1/i
    );
    expect(() =>
      parseKnowledgeCheckSuite(
        suite(
          { name: 'duplicate', query: 'a', expect: { kind: 'empty' } },
          { name: 'duplicate', query: 'b', expect: { kind: 'empty' } }
        )
      )
    ).toThrow(/duplicated/i);
    expect(() =>
      parseKnowledgeCheckSuite(
        suite({
          name: 'duplicate rows',
          query: 'item(X)',
          expect: {
            kind: 'rows',
            order: 'set',
            rows: [{ X: 'a' }, { X: 'a' }],
          },
        })
      )
    ).toThrow(/must not contain duplicates/i);
    expect(() =>
      parseKnowledgeCheckSuite(
        suite({
          name: 'noncanonical value',
          query: 'item(X)',
          expect: {
            kind: 'rows',
            order: 'exact',
            rows: [{ X: '01' }],
          },
        })
      )
    ).toThrow(/canonical Datalog term/i);
    expect(() =>
      parseKnowledgeCheckSuite(
        suite({
          name: 'variable value',
          query: 'item(X)',
          expect: {
            kind: 'rows',
            order: 'exact',
            rows: [{ X: 'Value' }],
          },
        })
      )
    ).toThrow(/ground Datalog term/i);
    expect(() =>
      parseKnowledgeCheckSuite({
        version: 1,
        checks: Array.from({ length: MAX_KNOWLEDGE_CHECKS + 1 }, (_, index) => ({
          name: `check-${index}`,
          query: 'item(X)',
          expect: { kind: 'empty' as const },
        })),
      })
    ).toThrow(/1 to 64 checks/i);
  });

  it('fails before execution when aggregate expected-row bounds are exceeded', () => {
    expect(() =>
      parseKnowledgeCheckSuite(
        suite({
          name: 'too many rows',
          query: 'item(X)',
          expect: {
            kind: 'rows',
            order: 'exact',
            rows: Array.from(
              { length: MAX_KNOWLEDGE_CHECK_EXPECTED_ROWS + 1 },
              (_, index) => ({ X: String(index) })
            ),
          },
        })
      )
    ).toThrow(/exceeds 10000 expected rows/i);
    expect(() =>
      runKnowledgeChecks(
        [],
        new Map(),
        suite({ name: 'empty', query: 'item(X)', expect: { kind: 'empty' } }),
        { includePassingEvidence: 'yes' as never }
      )
    ).toThrow(/must be a boolean/i);
  });
});
