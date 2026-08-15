import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/store.js';
import type { ChatMessage, LlmClient } from '../src/llm/client.js';
import {
  assertFactsTool,
  forgetTool,
  listMemoriesTool,
  queryTool,
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
  });

  it('query evaluates raw Datalog and returns bindings', () => {
    store.assert('default', 'f(a). f(b). g(X) :- f(X), X != a.');
    const result = queryTool({ store }, { query: 'g(X)' });
    expect(result.bindings).toEqual([{ X: 'b' }]);
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
