import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/store.js';
import type { ChatMessage, LlmClient } from '../src/llm/client.js';
import { MAX_INPUT_BYTES, MAX_NAMESPACE_COUNT } from '../src/safety.js';
import {
  assertFactsTool,
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

  it('assert_facts takes raw Datalog without any LLM', async () => {
    const result = assertFactsTool({ store }, { clauses: 'f(a). g(X) :- f(X).' });
    expect(result.added).toEqual(['f(a).', 'g(X) :- f(X).']);
    expect(result.duplicates).toBe(0);
    expect(result.opId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('query evaluates raw Datalog and returns bindings', () => {
    store.assert('default', 'f(a). f(b). g(X) :- f(X), X != a.');
    const result = queryTool({ store }, { query: 'g(X)' });
    expect(result.bindings).toEqual([{ X: 'b' }]);
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

  it('list_memories filters by predicate name', () => {
    store.assert('default', 'f(a). g(b).');
    const result = listMemoriesTool({ store }, { predicate: 'f' });
    expect(result.predicates).toEqual([{ predicate: 'f/1', facts: ['f(a).'] }]);
  });
});
