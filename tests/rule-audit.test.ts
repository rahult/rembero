import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProgram } from '../src/engine/index.js';
import {
  auditKnowledgeRules,
  MAX_RULE_AUDIT_FINDINGS,
} from '../src/knowledge/rule-audit.js';
import { assertTentativeFacts } from '../src/knowledge/trust-store.js';
import { MemoryStore } from '../src/store/store.js';

function auditStore(label: string): MemoryStore {
  return new MemoryStore(mkdtempSync(join(tmpdir(), `rembero-rule-audit-${label}-`)));
}

describe('deterministic rule health audit', () => {
  it('reports only evidence-backed structural and current-productivity findings', () => {
    const store = auditStore('findings');
    store.assert(
      'first',
      `seed(a).
       value(a). value(a, b).
       eligible(X) :- seed(X), \\+ blocked(X).
       inactive(X) :- missing(X).
       loop(X) :- loop(X).
       :- eligible(X), approval(X).`,
      { opId: 'first-source' }
    );
    store.assert('second', 'eligible(Y) :- seed(Y), \\+ blocked(Y).', {
      opId: 'duplicate-source',
    });

    const result = auditKnowledgeRules(
      store.clausesFor(['first', 'second']),
      store.sourcesFor(['first', 'second'])
    );

    expect(result.status).toBe('review');
    expect(result.warningCount).toBe(3);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          code: 'open_negated_input',
          predicateKeys: ['blocked/1'],
          currentFactCount: 0,
        }),
        expect.objectContaining({
          severity: 'warning',
          code: 'policy_open_input',
          predicateKeys: ['approval/1'],
          constraintIds: [expect.stringMatching(/^constraint:/)],
        }),
        expect.objectContaining({
          severity: 'warning',
          code: 'unseeded_recursion',
          predicateKeys: ['loop/1'],
          currentFactCount: 0,
        }),
        expect.objectContaining({
          severity: 'info',
          code: 'open_positive_input',
          predicateKeys: ['missing/1'],
        }),
        expect.objectContaining({
          severity: 'info',
          code: 'inactive_derived_predicate',
          predicateKeys: ['inactive/1'],
        }),
        expect.objectContaining({
          severity: 'info',
          code: 'duplicate_semantic_rule',
          ruleIds: [expect.stringMatching(/^rule:/)],
        }),
        expect.objectContaining({
          severity: 'info',
          code: 'predicate_arity_overload',
          predicateKeys: ['value/1', 'value/2'],
        }),
      ])
    );
    expect(result.materializedFactCount).toBe(4);
    expect(result.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'finding', code: 'open_negated_input' }),
      ])
    );
    expect(result.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'flags', to: 'predicate:blocked/1' }),
      ])
    );
  });

  it('keeps productive positive recursion clean', () => {
    const result = auditKnowledgeRules(
      parseProgram(`
        edge(a, b). edge(b, c).
        path(X, Y) :- edge(X, Y).
        path(X, Y) :- edge(X, Z), path(Z, Y).
      `)
    );
    expect(result).toMatchObject({
      status: 'clean',
      warningCount: 0,
      infoCount: 0,
      findings: [],
      materializedFactCount: 5,
    });
    expect(result.topology.recursiveComponents).toHaveLength(1);
  });

  it('returns advisory status for non-blocking duplicate and arity information', () => {
    const result = auditKnowledgeRules(
      parseProgram(`
        value(a). value(a, b).
        copy(X) :- value(X).
        copy(Y) :- value(Y).
      `)
    );
    expect(result).toMatchObject({
      status: 'advisory',
      warningCount: 0,
      infoCount: 2,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: 'duplicate_semantic_rule' }),
        expect.objectContaining({ code: 'predicate_arity_overload' }),
      ]),
    });
  });

  it('scopes findings through the complete topology focus closure', () => {
    const program = parseProgram(`
      base(a).
      selected(X) :- base(X), missing_selected(X).
      unrelated(X) :- missing_unrelated(X).
    `);
    const result = auditKnowledgeRules(program, new Map(), {
      focus: 'selected',
      direction: 'upstream',
    });
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ predicateKeys: ['missing_selected/1'] }),
      ])
    );
    expect(
      result.findings.some(({ predicateKeys }) =>
        predicateKeys.includes('missing_unrelated/1')
      )
    ).toBe(false);
    expect(result.topology.selection).toMatchObject({
      focus: 'selected/1',
      direction: 'upstream',
    });
  });

  it('audits the same canonical identity and tentative trust view as reasoning', () => {
    const store = auditStore('projection');
    store.assert(
      'default',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(person, 1, 0).
       rembero_entity_position(blocked, 1, 0).
       person('Mira Patel').
       eligible(X) :- person(X), \\+ blocked(X).`,
      { opId: 'identity' }
    );
    assertTentativeFacts(store, 'default', "blocked('Mira Patel').", {
      opId: 'tentative',
    });
    const clauses = store.clausesFor(['default']);
    const sources = store.sourcesFor(['default']);

    const accepted = auditKnowledgeRules(clauses, sources, {
      entityIdentity: 'canonical',
    });
    expect(accepted.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'open_negated_input',
          predicateKeys: ['blocked/1'],
        }),
      ])
    );

    const included = auditKnowledgeRules(clauses, sources, {
      entityIdentity: 'canonical',
      trustMode: 'include_tentative',
    });
    expect(included.topology.trustMode).toBe('include_tentative');
    expect(included.findings.some(({ code }) => code === 'open_negated_input')).toBe(false);
    expect(included.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'inactive_derived_predicate',
          predicateKeys: ['eligible/1'],
        }),
      ])
    );
  });

  it('fails closed when valid topology can produce more than the finding bound', () => {
    const constraints = Array.from({ length: 256 }, (_, constraintIndex) => {
      const goals = Array.from(
        { length: 16 },
        (_, goalIndex) => `open_${constraintIndex}_${goalIndex}`
      );
      return `:- ${goals.join(', ')}.`;
    }).join('\n');
    expect(() => auditKnowledgeRules(parseProgram(constraints))).toThrow(
      new RegExp(`exceeded ${MAX_RULE_AUDIT_FINDINGS} findings`, 'i')
    );
  });
});
