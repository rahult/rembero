import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/store.js';
import { serializeClause } from '../src/engine/index.js';
import { buildSchemaSummary } from '../src/llm/prompts.js';
import { rememberText, recallQuestion } from '../src/llm/pipeline.js';
import type { ChatMessage, LlmClient } from '../src/llm/client.js';
import { OpenRouterClient } from '../src/llm/client.js';

/** LlmClient returning scripted responses, recording every request. */
class ScriptedLlm implements LlmClient {
  calls: ChatMessage[][] = [];
  constructor(private responses: string[]) {}
  async complete(messages: ChatMessage[]): Promise<string> {
    this.calls.push(messages);
    const next = this.responses.shift();
    if (next === undefined) throw new Error('ScriptedLlm ran out of responses');
    return next;
  }
}

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-llm-')));
});

describe('buildSchemaSummary', () => {
  it('lists predicates with arity, sample facts, and rules verbatim', () => {
    store.assert(
      'default',
      `works_at(rahul, acme). works_at(maya, acme). works_at(chen, initech). works_at(dee, initech).
       birth_year(rahul, 1985).
       colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.`
    );
    const summary = buildSchemaSummary(store.clausesFor(['default']));
    expect(summary).toContain('works_at/2');
    expect(summary).toContain('works_at(rahul, acme).');
    expect(summary).toContain('birth_year/2');
    expect(summary).toContain('colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.');
    // samples are capped at 3 per predicate
    expect(summary).not.toContain('works_at(dee, initech).');
  });

  it('says so when there are no memories yet', () => {
    expect(buildSchemaSummary([])).toContain('no memories yet');
  });
});

describe('rememberText', () => {
  it('extracts, validates, and stores clauses', async () => {
    const llm = new ScriptedLlm(['works_at(rahul, acme).\nlives_in(rahul, sydney).']);
    const result = await rememberText({ store, llm }, 'Rahul works at Acme and lives in Sydney');
    expect(result.added).toEqual(['works_at(rahul, acme).', 'lives_in(rahul, sydney).']);
    expect(result.duplicates).toBe(0);
    expect(store.load('default')).toHaveLength(2);
    // the extraction prompt includes the schema and the raw text
    const [messages] = llm.calls;
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Datalog');
    expect(messages[1].content).toContain('Rahul works at Acme');
  });

  it('strips markdown code fences from the response', async () => {
    const llm = new ScriptedLlm(['```prolog\nworks_at(rahul, acme).\n```']);
    const result = await rememberText({ store, llm }, 'Rahul works at Acme');
    expect(result.added).toEqual(['works_at(rahul, acme).']);
  });

  it('retries once with the parse error, then succeeds', async () => {
    const llm = new ScriptedLlm([
      'works_at(X, acme).', // unsafe: non-ground fact
      'works_at(rahul, acme).',
    ]);
    const result = await rememberText({ store, llm }, 'Rahul works at Acme');
    expect(result.added).toEqual(['works_at(rahul, acme).']);
    expect(llm.calls).toHaveLength(2);
    const retryMessages = llm.calls[1];
    const lastUser = retryMessages[retryMessages.length - 1];
    expect(lastUser.content).toMatch(/ground|variable/i);
  });

  it('throws after a second failure, surfacing the error', async () => {
    const llm = new ScriptedLlm(['nonsense((', 'still nonsense((']);
    await expect(rememberText({ store, llm }, 'gibberish')).rejects.toThrow(/pars|expected/i);
    expect(store.load('default')).toEqual([]);
  });

  it('applies retract lines before asserting, superseding stale facts', async () => {
    store.assert('default', 'works_at(mira, acme).');
    const llm = new ScriptedLlm(['retract works_at(mira, _).\nworks_at(mira, initech).']);
    const result = await rememberText({ store, llm }, 'Mira now works at Initech');
    expect(result.retracted).toBe(1);
    expect(result.added).toEqual(['works_at(mira, initech).']);
    expect(store.load('default').map(serializeClause)).toEqual(['works_at(mira, initech).']);
  });

  it('counts retractions that match nothing as zero without failing', async () => {
    const llm = new ScriptedLlm(['retract dentist(rahul, _).\ndentist(rahul, dr_chen).']);
    const result = await rememberText({ store, llm }, 'My dentist is Dr Chen now');
    expect(result.retracted).toBe(0);
    expect(result.added).toEqual(['dentist(rahul, dr_chen).']);
  });

  it('treats "% nothing" as a no-op', async () => {
    const llm = new ScriptedLlm(['% nothing']);
    const result = await rememberText({ store, llm }, 'hello there!');
    expect(result.added).toEqual([]);
    expect(store.load('default')).toEqual([]);
  });
});

describe('recallQuestion', () => {
  beforeEach(() => {
    store.assert(
      'default',
      `works_at(rahul, acme). works_at(maya, acme).
       colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.`
    );
  });

  it('answers immediately without any LLM call when memory is empty', async () => {
    const empty = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-empty-')));
    const llm = new ScriptedLlm([]);
    const result = await recallQuestion({ store: empty, llm }, 'Where does Rahul work?');
    expect(result.query).toBeNull();
    expect(result.answer).toMatch(/no (relevant )?memor/i);
    expect(llm.calls).toHaveLength(0);
  });

  it('generates a query, evaluates it, and phrases the answer', async () => {
    const llm = new ScriptedLlm(['?- colleague(rahul, Who).', 'Maya is Rahul’s colleague.']);
    const result = await recallQuestion({ store, llm }, 'Who are Rahul’s colleagues?');
    expect(result.query).toBe('colleague(rahul, Who)');
    expect(result.bindings).toEqual([{ Who: 'maya' }]);
    expect(result.answer).toBe('Maya is Rahul’s colleague.');
    // phrasing prompt received the bindings
    const phrasing = llm.calls[1];
    expect(phrasing[phrasing.length - 1].content).toContain('maya');
  });

  it('short-circuits on unanswerable without calling the engine or phrasing', async () => {
    const llm = new ScriptedLlm(['?- unanswerable.']);
    const result = await recallQuestion({ store, llm }, 'What is the meaning of life?');
    expect(result.query).toBeNull();
    expect(result.bindings).toEqual([]);
    expect(result.answer).toMatch(/no (relevant )?memor/i);
    expect(llm.calls).toHaveLength(1);
  });

  it('retries when the generated query uses an unknown predicate', async () => {
    const llm = new ScriptedLlm([
      '?- employed_by(rahul, X).',
      '?- works_at(rahul, X).',
      'Rahul works at Acme.',
    ]);
    const result = await recallQuestion({ store, llm }, 'Where does Rahul work?');
    expect(result.query).toBe('works_at(rahul, X)');
    const retry = llm.calls[1];
    expect(retry[retry.length - 1].content).toContain('employed_by/2');
  });

  it('tries one alternative query when the first returns no rows', async () => {
    const llm = new ScriptedLlm([
      '?- works_at(maya, initech).', // plausible but wrong guess: no rows
      '?- works_at(maya, X).', // fallback attempt finds the answer
      'Maya works at Acme.',
    ]);
    const result = await recallQuestion({ store, llm }, 'Is Maya employed anywhere?');
    expect(result.query).toBe('works_at(maya, X)');
    expect(result.bindings).toEqual([{ X: 'acme' }]);
    expect(result.answer).toBe('Maya works at Acme.');
    // the fallback prompt tells the model what came up empty
    const fallback = llm.calls[1];
    expect(fallback[fallback.length - 1].content).toContain('works_at(maya, initech)');
  });

  it('phrases an honest answer when the fallback also returns no rows', async () => {
    const llm = new ScriptedLlm([
      '?- works_at(zoe, X).',
      '?- colleague(zoe, X).',
      "I don't have that in memory.",
    ]);
    const result = await recallQuestion({ store, llm }, 'Where does Zoe work?');
    expect(result.bindings).toEqual([]);
    expect(result.answer).toBe("I don't have that in memory.");
  });

  it('accepts unanswerable as the fallback response and skips phrasing', async () => {
    const llm = new ScriptedLlm(['?- works_at(zoe, X).', '?- unanswerable.']);
    const result = await recallQuestion({ store, llm }, 'Where does Zoe work?');
    expect(result.bindings).toEqual([]);
    expect(result.answer).toMatch(/no (relevant )?memor/i);
    expect(llm.calls).toHaveLength(2);
  });
});

describe('OpenRouterClient', () => {
  it('sends an OpenAI-style chat request with auth header and retries on 5xx', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    let attempt = 0;
    const fakeFetch: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), init: init! });
      attempt++;
      if (attempt === 1) return new Response('upstream error', { status: 502 });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'hi there' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };
    const client = new OpenRouterClient(
      { apiKey: 'sk-test', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5.6-luna' },
      fakeFetch
    );
    const text = await client.complete([{ role: 'user', content: 'hello' }]);
    expect(text).toBe('hi there');
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = requests[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(requests[0].init.body));
    expect(body.model).toBe('openai/gpt-5.6-luna');
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.temperature).toBe(0);
  });

  it('throws a readable error on repeated failure, without leaking the key', async () => {
    const fakeFetch: typeof fetch = async () => new Response('nope', { status: 500 });
    const client = new OpenRouterClient(
      { apiKey: 'sk-secret-value', baseUrl: 'https://x.test/v1', model: 'm' },
      fakeFetch
    );
    await expect(client.complete([{ role: 'user', content: 'q' }])).rejects.toSatisfy(
      (e: Error) => /500/.test(e.message) && !e.message.includes('sk-secret-value')
    );
  });
});
