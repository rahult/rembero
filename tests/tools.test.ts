import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, OperationConflictError } from '../src/store/store.js';
import { IntegrityViolationError } from '../src/knowledge/enforcement.js';
import type { ChatMessage, LlmClient } from '../src/llm/client.js';
import { MAX_INPUT_BYTES, MAX_NAMESPACE_COUNT } from '../src/safety.js';
import { serializeClause } from '../src/engine/index.js';
import {
  assertFactsTool,
  checkIntegrityTool,
  explainQueryTool,
  forgetTool,
  listMemoriesTool,
  queryTool,
  recallExplainTool,
  rememberTool,
  recallTool,
} from '../src/mcp/tools.js';

class ScriptedLlm implements LlmClient {
  constructor(private responses: string[]) {}
  async complete(_messages: ChatMessage[]): Promise<string> {
    const next = this.responses.shift();
    if (next === undefined) throw new Error('out of responses');
    return next;
  }
}

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-tools-')));
});

describe('MCP tool handlers', () => {
  it('remember extracts via LLM and stores', async () => {
    const llm = new ScriptedLlm(['pet(rahul, luna_the_cat).']);
    const result = await rememberTool({ store, llm }, { text: 'My cat is called Luna' });
    expect(result.added).toEqual(['pet(rahul, luna_the_cat).']);
    expect(result.opId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('recall answers from memory', async () => {
    store.assert('default', 'pet(rahul, luna).');
    const llm = new ScriptedLlm(['?- pet(rahul, X).', 'Your cat is Luna.']);
    const result = await recallTool({ store, llm }, { question: 'What is my cat called?' });
    expect(result.answer).toBe('Your cat is Luna.');
    expect(result.bindings).toEqual([{ X: 'luna' }]);
  });

  it('recall answers from an explicit recorded snapshot', async () => {
    store.assert('default', 'status(mira, active).', { opId: 'past' });
    store.replace('default', ['status(mira, _)'], 'status(mira, paused).', {
      opId: 'current',
    });
    const llm = new ScriptedLlm(['?- status(mira, State).', 'Mira was active.']);

    const result = await recallTool(
      { store, llm },
      { question: 'What was Mira status?', recordedSequence: 1 }
    );

    expect(result.answer).toBe('Mira was active.');
    expect(result.bindings).toEqual([{ State: 'active' }]);
    expect(result.recordedSnapshot).toMatchObject({ sequence: 1, journalEntries: 2 });
  });

  it('assert_facts takes raw Datalog without any LLM', async () => {
    const result = assertFactsTool({ store }, { clauses: 'f(a). g(X) :- f(X).' });
    expect(result.added).toEqual(['f(a).', 'g(X) :- f(X).']);
    expect(result.duplicates).toBe(0);
    expect(result.opId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('assert_facts and forget forward caller operation ids for safe retries', () => {
    const asserted = assertFactsTool(
      { store },
      { clauses: 'f(a). f(b).', opId: 'tool-assert' }
    );
    expect(
      assertFactsTool({ store }, { clauses: 'f(a). f(b).', opId: 'tool-assert' })
    ).toEqual(asserted);
    expect(() =>
      assertFactsTool({ store }, { clauses: 'g(a).', opId: 'tool-assert' })
    ).toThrow(OperationConflictError);

    const forgotten = forgetTool(
      { store },
      { pattern: 'f(_)', opId: 'tool-forget' }
    );
    expect(
      forgetTool({ store }, { pattern: 'f( _ )', opId: 'tool-forget' })
    ).toEqual(forgotten);
    expect(forgotten).toEqual({ removed: 2, opId: 'tool-forget' });
  });

  it('write tools share atomic integrity enforcement and structured rejection', () => {
    store.assert(
      'default',
      'active(mira). :- active(X), suspended(X).'
    );
    expect(() =>
      assertFactsTool(
        { store, integrityEnforcement: { mode: 'strict' } },
        { clauses: 'suspended(mira).' }
      )
    ).toThrow(IntegrityViolationError);
    expect(store.load('default').map(serializeClause)).toEqual([
      'active(mira).',
      ':- active(X), suspended(X).',
    ]);

    store.assert('default', 'manager(mira, rahul).');
    store.assert(
      'default',
      ':- active(Person), \\+ manager(Person, _).'
    );
    expect(() =>
      forgetTool(
        { store, integrityEnforcement: { mode: 'strict' } },
        { pattern: 'manager(mira, _)' }
      )
    ).toThrow(IntegrityViolationError);
  });

  it('query evaluates raw Datalog and returns bindings', () => {
    store.assert('default', 'f(a). f(b). g(X) :- f(X), X != a.');
    const result = queryTool({ store }, { query: 'g(X)' });
    expect(result.bindings).toEqual([{ X: 'b' }]);
  });

  it('query and explain read deterministic recorded snapshots with past sources', () => {
    store.assert(
      'default',
      'works_at(mira, acme). coworker(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.',
      { opId: 'past-source', sourceText: 'Mira worked at Acme.' }
    );
    store.assert('default', 'works_at(rahul, acme).', { opId: 'second-source' });
    store.replace('default', ['works_at(mira, _)'], 'works_at(mira, initech).', {
      opId: 'current-source',
    });

    expect(queryTool({ store }, { query: 'works_at(mira, C)' })).toEqual({
      bindings: [{ C: 'initech' }],
    });
    const past = queryTool(
      { store },
      { query: 'coworker(mira, Who)', recordedSequence: 2 }
    );
    expect(past).toEqual({
      bindings: [{ Who: 'rahul' }],
      recordedSnapshot: {
        sequence: 2,
        journalEntries: 3,
        namespaces: ['default'],
      },
    });
    const explained = explainQueryTool(
      { store },
      { query: 'works_at(mira, Company)', recordedSequence: 1 }
    );
    expect(explained.rows[0]).toMatchObject({
      bindings: { Company: 'acme' },
      proofs: [{ sources: [{ opId: 'past-source', text: 'Mira worked at Acme.' }] }],
    });
    expect(explained.recordedSnapshot?.sequence).toBe(1);
  });

  it('applies integrity, listing, and explicit identity to the selected snapshot', () => {
    store.assert(
      'default',
      "rembero_alias('Mira Patel', mira). rembero_entity_position(active, 1, 0). active('Mira Patel'). :- active(Person), suspended(Person).",
      { opId: 'baseline' }
    );
    store.assert('default', 'suspended(mira).', { opId: 'later' });

    expect(
      checkIntegrityTool({ store }, { recordedSequence: 1, entityIdentity: 'canonical' })
    ).toMatchObject({
      status: 'consistent',
      recordedSnapshot: { sequence: 1, journalEntries: 2 },
    });
    expect(checkIntegrityTool({ store }, { entityIdentity: 'canonical' }).status).toBe(
      'violations'
    );
    const listed = listMemoriesTool({ store }, { recordedSequence: 1 });
    expect(listed.predicates.some((group) => group.predicate === 'suspended/1')).toBe(false);
    expect(listed.recordedSnapshot?.sequence).toBe(1);
    expect(
      queryTool(
        { store },
        { query: 'active(mira)', recordedSequence: 1, entityIdentity: 'canonical' }
      ).bindings
    ).toEqual([{}]);
  });

  it('query and explain_query accept arithmetic comparison filters', () => {
    store.assert(
      'default',
      'score(alice, 20). score(bob, 14). baseline(team, 10). ahead(X) :- score(X, S), baseline(team, B), S > B + 5.'
    );
    expect(queryTool({ store }, { query: 'ahead(Person)' })).toEqual({
      bindings: [{ Person: 'alice' }],
    });
    expect(
      explainQueryTool({ store }, { query: 'score(Person, S), S / 2 >= 10' }).rows
    ).toHaveLength(1);
  });

  it('query and explain_query expose exact scalar aggregation', () => {
    store.assert('default', 'works_at(alice, acme). works_at(bob, acme).', {
      opId: 'aggregate-source',
    });
    const query = 'count(*) as Count where works_at(Person, acme)';

    expect(queryTool({ store }, { query })).toEqual({ bindings: [{ Count: '2' }] });
    const explained = explainQueryTool({ store }, { query });
    expect(explained.rows[0]).toMatchObject({
      bindings: { Count: '2' },
      proofs: [
        {
          aggregated: true,
          op: 'count',
          value: 2,
          contributors: [
            { bindings: { Person: 'alice' } },
            { bindings: { Person: 'bob' } },
          ],
        },
      ],
    });
    expect(explained.graph.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'aggregate', value: 2 })])
    );
  });

  it('rejects oversized inputs and namespace fan-out before evaluation', () => {
    expect(() =>
      queryTool({ store }, { query: 'x'.repeat(MAX_INPUT_BYTES + 1) })
    ).toThrow(/query exceeds/i);
    expect(() =>
      listMemoriesTool(
        { store },
        { namespaces: Array.from({ length: MAX_NAMESPACE_COUNT + 1 }, (_, i) => `ns${i}`) }
      )
    ).toThrow(/namespace list exceeds/i);
  });

  it('explain_query returns proof sources and a query-scoped graph', () => {
    store.assert(
      'default',
      'works_at(rahul, acme). works_at(mira, acme). colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.',
      { opId: 'source-1', sourceText: 'Rahul and Mira work at Acme.' }
    );
    const result = explainQueryTool({ store }, { query: 'colleague(rahul, Who)' });
    expect(result.rows[0].bindings).toEqual({ Who: 'mira' });
    expect(result.rows[0].proofs[0]).toMatchObject({
      predicate: 'colleague',
      rule: 1,
      because: [
        { predicate: 'works_at', sources: [{ opId: 'source-1' }] },
        { predicate: 'works_at', sources: [{ opId: 'source-1' }] },
      ],
    });
    expect(result.graph.nodes.some((node) => node.kind === 'result')).toBe(true);
  });

  it('explain_query returns bounded alternative proofs only when requested', () => {
    store.assert(
      'default',
      'left(a). right(a). answer(X) :- left(X). answer(X) :- right(X).'
    );

    const primary = explainQueryTool({ store }, { query: 'answer(a)' });
    const expanded = explainQueryTool(
      { store },
      { query: 'answer(a)', proofLimit: 2 }
    );

    expect(primary.rows[0]).not.toHaveProperty('alternativeProofs');
    expect(expanded.rows[0].proofs[0]).toMatchObject({ rule: 1 });
    expect(expanded.rows[0].alternativeProofs).toEqual([
      [expect.objectContaining({ rule: 2 })],
    ]);
    expect(expanded.graph.nodes.some((node) => node.kind === 'proof')).toBe(true);
  });

  it('check_integrity returns proof-bearing violations without mutating memory', () => {
    store.assert(
      'default',
      'active(mira). suspended(mira). :- active(X), suspended(X).',
      { opId: 'integrity-input' }
    );
    const before = store.load('default');

    const result = checkIntegrityTool(
      { store },
      { maxViolations: 10 }
    );

    expect(result).toMatchObject({
      status: 'violations',
      constraintCount: 1,
      violationCount: 1,
      checks: [{ rows: [{ bindings: { X: 'mira' } }] }],
    });
    expect(store.load('default')).toEqual(before);
  });

  it('recall_explain keeps the answer and adds deterministic evidence', async () => {
    store.assert('default', 'pet(rahul, luna).', {
      opId: 'pet-source',
      sourceText: 'My cat is called Luna.',
    });
    const llm = new ScriptedLlm(['?- pet(rahul, Name).', 'Your cat is Luna.']);
    const result = await recallExplainTool(
      { store, llm },
      { question: 'What is my cat called?' }
    );
    expect(result.answer).toBe('Your cat is Luna.');
    expect(result.bindings).toEqual([{ Name: 'luna' }]);
    expect(result.explanation?.rows[0].proofs[0]).toMatchObject({
      predicate: 'pet',
      sources: [{ opId: 'pet-source', text: 'My cat is called Luna.' }],
    });
  });

  it('recall_explain threads the proof limit through generated-query evaluation', async () => {
    store.assert(
      'default',
      'left(a). right(a). answer(X) :- left(X). answer(X) :- right(X).'
    );
    const llm = new ScriptedLlm(['?- answer(a).', 'The answer is supported twice.']);

    const result = await recallExplainTool(
      { store, llm },
      { question: 'Is a an answer?', proofLimit: 2 }
    );

    expect(result.explanation?.rows[0].proofs[0]).toMatchObject({ rule: 1 });
    expect(result.explanation?.rows[0].alternativeProofs).toEqual([
      [expect.objectContaining({ rule: 2 })],
    ]);
  });

  it('query can span all namespaces with *', () => {
    store.assert('work', 'works_at(rahul, acme).');
    store.assert('home', 'lives_in(rahul, sydney).');
    const result = queryTool(
      { store },
      { query: 'works_at(P, _), lives_in(P, C)', namespaces: '*' }
    );
    expect(result.bindings).toEqual([{ P: 'rahul', C: 'sydney' }]);
  });

  it('forget retracts matching facts', () => {
    store.assert('default', 'f(a). f(b).');
    const result = forgetTool({ store }, { pattern: 'f(_)' });
    expect(result.removed).toBe(2);
    expect(result.opId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('list_memories groups clauses by predicate', () => {
    store.assert('default', 'f(a). f(b). g(X) :- f(X).');
    const result = listMemoriesTool({ store }, {});
    expect(result.predicates).toEqual([
      { predicate: 'f/1', facts: ['f(a).', 'f(b).'] },
      { predicate: 'g/1', facts: [], rules: ['g(X) :- f(X).'] },
    ]);
  });

  it('list_memories exposes integrity constraints separately from predicates', () => {
    store.assert('default', 'active(mira). :- active(X), suspended(X).');
    expect(listMemoriesTool({ store }, {})).toEqual({
      predicates: [{ predicate: 'active/1', facts: ['active(mira).'] }],
      constraints: [':- active(X), suspended(X).'],
    });
  });

  it('list_memories filters by predicate name', () => {
    store.assert(
      'default',
      'f(a). g(b). :- f(X), blocked(X). :- g(X), hidden(X).'
    );
    const result = listMemoriesTool({ store }, { predicate: 'f' });
    expect(result).toEqual({
      predicates: [{ predicate: 'f/1', facts: ['f(a).'] }],
      constraints: [':- f(X), blocked(X).'],
    });
  });
});
