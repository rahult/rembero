import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KnowledgeCheckEnforcementError,
  type KnowledgeCheckEnforcementOptions,
} from '../src/knowledge/check-enforcement.js';
import {
  assertTentativeFacts,
  reviewTentativeClaims,
  resolveTentativeFacts,
} from '../src/knowledge/trust-store.js';
import { MemoryStore } from '../src/store/store.js';
import { serializeClause } from '../src/engine/index.js';

function guardedStore(label: string): { root: string; store: MemoryStore } {
  const root = mkdtempSync(join(tmpdir(), `rembero-check-enforcement-${label}-`));
  return { root, store: new MemoryStore(root) };
}

function guard(
  mode: KnowledgeCheckEnforcementOptions['mode'],
  suite: KnowledgeCheckEnforcementOptions['suite']
): KnowledgeCheckEnforcementOptions {
  return { mode, suite, namespaces: ['default'] };
}

describe('atomic knowledge check write enforcement', () => {
  it('strict mode rejects a failing candidate without journal or file mutation', () => {
    const { root, store } = guardedStore('strict');
    const checks = guard('strict', {
      version: 1,
      checks: [
        {
          name: 'forbidden item stays absent',
          query: 'forbidden(a)',
          expect: { kind: 'empty' },
        },
      ],
    });

    store.assert('default', 'safe(a).', { checks, opId: 'safe-write' });
    const before = readFileSync(join(root, 'journal.log'), 'utf8');
    expect(() =>
      store.assert('default', 'forbidden(a).', {
        checks,
        opId: 'blocked-write',
      })
    ).toThrow(KnowledgeCheckEnforcementError);
    expect(store.load('default').map(serializeClause)).toEqual(['safe(a).']);
    expect(readFileSync(join(root, 'journal.log'), 'utf8')).toBe(before);
  });

  it('no-regressions mode permits legacy debt and repairs but blocks new failure', () => {
    const { store } = guardedStore('migration');
    store.assert('default', 'base(a).', { opId: 'legacy' });
    const checks = guard('no_regressions', {
      version: 1,
      checks: [
        {
          name: 'required fact',
          query: 'required(a)',
          expect: { kind: 'nonempty' },
        },
      ],
    });

    expect(
      store.assert('default', 'unrelated(a).', {
        checks,
        opId: 'legacy-unchanged',
      }).added
    ).toHaveLength(1);
    expect(
      store.assert('default', 'required(a).', {
        checks,
        opId: 'repair',
      }).added
    ).toHaveLength(1);
    expect(() =>
      store.retract('default', 'required(a)', {
        checks,
        opId: 'regression',
      })
    ).toThrow(KnowledgeCheckEnforcementError);
    expect(store.load('default').map(serializeClause)).toContain('required(a).');
  });

  it('blocks semantic coverage regression when a write adds an untested rule', () => {
    const { store } = guardedStore('coverage');
    store.assert('default', 'base(a). derived(X) :- base(X).', {
      opId: 'covered-program',
    });
    const checks = guard('no_regressions', {
      version: 1,
      coverage: { minimumPercent: 100 },
      checks: [
        {
          name: 'derived proof',
          query: 'derived(a)',
          expect: { kind: 'nonempty' },
        },
      ],
    });

    expect(() =>
      store.assert('default', 'untested(X) :- base(X).', {
        checks,
        opId: 'untested-rule',
      })
    ).toThrow(KnowledgeCheckEnforcementError);
    expect(store.load('default').map(serializeClause)).not.toContain(
      'untested(X) :- base(X).'
    );
  });

  it('guards replacements and tentative promotion through the same candidate hook', () => {
    const { store } = guardedStore('writers');
    store.assert('default', 'works_at(mira, acme).', { opId: 'work' });
    const workChecks = guard('strict', {
      version: 1,
      checks: [
        {
          name: 'Acme remains current',
          query: 'works_at(mira, acme)',
          expect: { kind: 'nonempty' },
        },
      ],
    });
    expect(() =>
      store.supersede(
        'default',
        ['works_at(mira, _)'],
        'works_at(mira, initech).',
        { checks: workChecks, opId: 'blocked-supersede' }
      )
    ).toThrow(KnowledgeCheckEnforcementError);

    assertTentativeFacts(store, 'default', 'blocked(a).', {
      opId: 'tentative',
    });
    const trustChecks = guard('strict', {
      version: 1,
      checks: [
        {
          name: 'blocked stays absent',
          query: 'blocked(a)',
          expect: { kind: 'empty' },
        },
      ],
    });
    expect(() =>
      resolveTentativeFacts(
        store,
        'default',
        'blocked(a).',
        'accept',
        { checks: trustChecks, opId: 'blocked-promotion' }
      )
    ).toThrow(KnowledgeCheckEnforcementError);
    expect(reviewTentativeClaims(store, ['default'])).toHaveLength(1);
  });
});
