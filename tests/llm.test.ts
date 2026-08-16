import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/store/store.js';
import { parseProgram, serializeClause } from '../src/engine/index.js';
import { buildSchemaSummary } from '../src/llm/prompts.js';
import { rememberText, recallQuestion, retrieveQuestion } from '../src/llm/pipeline.js';
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

  it('keeps integrity policy out of the LLM-facing recall schema', () => {
    const summary = buildSchemaSummary(
      parseProgram('active(mira). :- active(X), suspended(X).')
    );
    expect(summary).toContain('active/1');
    expect(summary).not.toContain('integrity');
    expect(summary).not.toContain('suspended');
    expect(summary).not.toContain(':-');
  });

  it('keeps entity identity metadata out of the LLM-facing schema', () => {
    const summary = buildSchemaSummary(
      parseProgram(
        "rembero_alias('Mira Patel', mira). rembero_entity_position(works_at, 2, 0). works_at(mira, acme)."
      )
    );
    expect(summary).toContain('works_at/2');
    expect(summary).not.toContain('rembero_alias');
    expect(summary).not.toContain('rembero_entity_position');
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

  it('never lets natural-language extraction create integrity policy', async () => {
    const llm = new ScriptedLlm([
      ':- active(X), suspended(X).',
      ':- active(X), terminated(X).',
    ]);
    await expect(
      rememberText({ store, llm }, 'Make sure active users are not suspended')
    ).rejects.toThrow(/may not create integrity constraints/i);
    expect(store.load('default')).toEqual([]);
  });

  it('never lets natural-language extraction create entity identity metadata', async () => {
    const llm = new ScriptedLlm([
      "rembero_alias('Mira Patel', mira).",
      'rembero_entity_position(works_at, 2, 0).',
    ]);
    await expect(
      rememberText({ store, llm }, 'Mira Patel and Mira are the same person')
    ).rejects.toThrow(/may not create entity identity metadata/i);
    expect(store.load('default')).toEqual([]);
  });

  it('never lets natural-language extraction retract entity identity metadata', async () => {
    store.assert('default', "rembero_alias('Mira Patel', mira).");
    const llm = new ScriptedLlm([
      "retract rembero_alias('Mira Patel', _).",
      "retract rembero_alias('Mira Patel', mira).",
    ]);
    await expect(
      rememberText({ store, llm }, 'Forget that Mira Patel is Mira')
    ).rejects.toThrow(/may not retract entity identity metadata/i);
    expect(store.load('default').map(serializeClause)).toEqual([
      "rembero_alias('Mira Patel', mira).",
    ]);
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

  it('keeps deletion semantics by default when no valid-time mode is requested', async () => {
    store.assert('default', 'works_at(mira, acme).');
    const llm = new ScriptedLlm(['retract works_at(mira, _).\nworks_at(mira, initech).']);

    const result = await rememberText({ store, llm }, 'Mira now works at Initech');

    expect(result.retracted).toBe(1);
    const clauses = store.load('default').map(serializeClause);
    expect(clauses).toEqual(['works_at(mira, initech).']);
    expect(clauses.some((clause) => clause.startsWith('works_at_until('))).toBe(false);
  });

  it('uses archive_until supersession with a full ISO timestamp when valid-time mode is enabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-valid-time-'));
    const temporal = new MemoryStore(root);
    temporal.assert('default', 'works_at(mira, acme).', {
      opId: 'source-1',
      sourceText: 'Mira works at Acme.',
      at: new Date('2026-08-10T09:00:00.000Z'),
    });
    const llm = new ScriptedLlm(['retract works_at(mira, _).\nworks_at(mira, initech).']);

    const result = await (rememberText as unknown as (
      deps: { store: MemoryStore; llm: LlmClient },
      text: string,
      namespace?: string,
      options?: { validTimeMode?: 'delete' | 'archive_until'; at?: Date }
    ) => Promise<{
      added: string[];
      duplicates: number;
      retracted: number;
      archived: string[];
      opId: string;
    }>)(
      { store: temporal, llm },
      'Mira now works at Initech',
      'default',
      { validTimeMode: 'archive_until', at: new Date('2026-08-16T16:59:00.000Z') }
    );

    expect(result).toMatchObject({
      retracted: 1,
      archived: ["works_at_until(mira, acme, '2026-08-16T16:59:00.000Z')."],
    });
    expect(temporal.load('default').map(serializeClause).sort()).toEqual([
      'works_at(mira, initech).',
      "works_at_until(mira, acme, '2026-08-16T16:59:00.000Z').",
    ].sort());
    const journal = readFileSync(join(root, 'journal.log'), 'utf8');
    expect(journal).toContain('"op":"supersede"');
    expect(journal).toContain("works_at_until(mira, acme, '2026-08-16T16:59:00.000Z').");
  });

  it('honors the server-level valid-time mode when no per-call override is supplied', async () => {
    store.assert('default', 'works_at(mira, acme).');
    const llm = new ScriptedLlm(['retract works_at(mira, _).\nworks_at(mira, initech).']);

    const result = await rememberText(
      { store, llm, validTimeMode: 'archive_until' },
      'Mira now works at Initech'
    );

    expect(result.archived).toHaveLength(1);
    expect(store.load('default').map(serializeClause)).toEqual(
      expect.arrayContaining([
        'works_at(mira, initech).',
        expect.stringMatching(/^works_at_until\(mira, acme, '/),
      ])
    );
  });

  it('journals the source text of what was remembered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-journal-'));
    const s = new MemoryStore(root);
    const llm = new ScriptedLlm(['works_at(rahul, acme).']);
    await rememberText({ store: s, llm }, 'Rahul works at Acme');
    const journal = readFileSync(join(root, 'journal.log'), 'utf8');
    const entries = journal.trim().split('\n').map((line) => JSON.parse(line));
    const remember = entries.find((entry) => entry.op === 'remember');
    const assertion = entries.find((entry) => entry.op === 'assert');
    expect(remember.text).toBe('Rahul works at Acme');
    expect(assertion.sourceText).toBe('Rahul works at Acme');
    expect(assertion.opId).toBe(remember.opId);
  });

  it('refuses to send secrets to the external LLM or persist them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-secret-journal-'));
    const s = new MemoryStore(root);
    const secret = 'ghp_supersecretvalue';
    const llm = new ScriptedLlm(['uses(rahul, github).']);

    await expect(
      rememberText({ store: s, llm }, `My GitHub token is ${secret}`)
    ).rejects.toThrow(/refusing to send sensitive memory text/i);
    expect(llm.calls).toHaveLength(0);
    expect(existsSync(join(root, 'journal.log'))).toBe(false);
  });

  it('keeps namespaces outside the explicit LLM allowlist local-only', async () => {
    const llm = new ScriptedLlm([]);
    const deps = { store, llm, llmAllowedNamespaces: new Set(['shared']) };

    await expect(rememberText(deps, 'Alice works at Acme', 'private')).rejects.toThrow(
      /namespace 'private' is local-only/i
    );
    expect(llm.calls).toHaveLength(0);
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

  it('refuses to expose sensitive stored facts to the external LLM', async () => {
    const sensitive = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-sensitive-')));
    sensitive.assert('default', "password(rahul, 'do-not-send-this').");
    const llm = new ScriptedLlm(['?- password(rahul, Value).']);

    await expect(
      recallQuestion({ store: sensitive, llm }, 'What credential is stored?')
    ).rejects.toThrow(/refusing to send sensitive memory schema/i);
    expect(llm.calls).toHaveLength(0);
  });

  it('rejects wildcard recall when it includes a local-only namespace', async () => {
    const scoped = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-scoped-')));
    scoped.assert('shared', 'project(atlas).');
    scoped.assert('private', 'health_note(alice, stable).');
    const llm = new ScriptedLlm([]);

    await expect(
      retrieveQuestion(
        { store: scoped, llm, llmAllowedNamespaces: new Set(['shared']) },
        'What projects are stored?',
        '*'
      )
    ).rejects.toThrow(/namespace 'private' is local-only/i);
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

  it('projects an alias only at declared positions during opt-in recall', async () => {
    const identityStore = new MemoryStore(
      mkdtempSync(join(tmpdir(), 'rembero-recall-identity-'))
    );
    identityStore.assert(
      'default',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(works_at, 2, 0).
       works_at('Mira Patel', acme).`
    );
    const llm = new ScriptedLlm([
      "?- works_at('Mira Patel', Company).",
      'Mira Patel works at Acme.',
    ]);

    const result = await recallQuestion(
      { store: identityStore, llm },
      'Where does Mira Patel work?',
      ['default'],
      { entityIdentity: 'canonical' }
    );

    expect(result).toMatchObject({
      status: 'answered',
      query: 'works_at(mira, Company)',
      bindings: [{ Company: 'acme' }],
      answer: 'Mira Patel works at Acme.',
    });
    expect(llm.calls[0][0].content).toContain('works_at(mira, acme).');
    expect(llm.calls[0][0].content).not.toContain('rembero_alias');
  });

  it('can evaluate retrieval without a phrasing call and applies the grounded prompt', async () => {
    const llm = new ScriptedLlm(['?- works_at(rahul, Company).']);
    const result = await retrieveQuestion(
      { store, llm },
      'Where does Rahul work?',
      ['default'],
      { queryPromptVariant: 'grounded' }
    );
    expect(result).toEqual({
      status: 'answered',
      query: 'works_at(rahul, Company)',
      bindings: [{ Company: 'acme' }],
    });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0][0].content).toContain('schema examples as syntax evidence only');
  });

  it('uses the grounded query prompt by default', async () => {
    const llm = new ScriptedLlm(['?- works_at(rahul, Company).']);
    await retrieveQuestion({ store, llm }, 'Where does Rahul work?');
    expect(llm.calls[0][0].content).toContain('Datalog variables represent requested unknown');
  });

  it('recalls through a deterministic relevant schema slice with 100+ predicates', async () => {
    const scaled = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-recall-scale-')));
    const noise = Array.from(
      { length: 120 },
      (_, index) => `noise_${String(index).padStart(3, '0')}(subject_${index}, value_${index}).`
    ).join('\n');
    scaled.assert(
      'default',
      `${noise}\nworks_at(alice, northwind).\nworks_at(mira, acme).`
    );
    const llm = new ScriptedLlm(['?- works_at(mira, Company).']);

    const result = await retrieveQuestion(
      { store: scaled, llm, recallSchemaPredicateLimit: 8 },
      'Who is Mira employed by?'
    );

    expect(result).toMatchObject({
      status: 'answered',
      query: 'works_at(mira, Company)',
      bindings: [{ Company: 'acme' }],
      pruning: {
        totalPredicates: 121,
        selectedPredicates: expect.arrayContaining(['works_at/2']),
        catalogComplete: true,
      },
    });
    const prompt = llm.calls[0][0].content;
    expect(prompt).toContain('% selected predicates (8 of 121');
    expect(prompt).toContain('% e.g. works_at(mira, acme).');
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(64 * 1024);
  });

  it('keeps derived-rule dependencies in a pruned recall-explain path', async () => {
    const scaled = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-recall-derived-')));
    const noise = Array.from(
      { length: 100 },
      (_, index) => `noise_${String(index).padStart(3, '0')}(subject_${index}).`
    ).join('\n');
    scaled.assert(
      'default',
      `${noise}
       works_at(rahul, acme). works_at(mira, acme).
       colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.`
    );
    const llm = new ScriptedLlm(['?- colleague(rahul, Who).']);

    const result = await retrieveQuestion(
      { store: scaled, llm, recallSchemaPredicateLimit: 6 },
      'Who are Rahul’s colleagues?',
      ['default'],
      { explain: true }
    );

    expect(result.status).toBe('answered');
    expect(result.bindings).toEqual([{ Who: 'mira' }]);
    expect(result.pruning?.selectedPredicates).toEqual(
      expect.arrayContaining(['colleague/2', 'works_at/2'])
    );
    expect(llm.calls[0][0].content).toContain(
      'colleague(X, Y) :- works_at(X, C), works_at(Y, C), X != Y.'
    );
    expect(result.explanation?.rows[0].proofs[0]).toMatchObject({
      predicate: 'colleague',
      because: [
        expect.objectContaining({ predicate: 'works_at' }),
        expect.objectContaining({ predicate: 'works_at' }),
      ],
    });
  });

  it('does not let schema ranking change the requested-namespace proof witness', async () => {
    const scaled = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-recall-witness-')));
    scaled.assert('first', 'pet(rahul, luna).', {
      opId: 'first-source',
      sourceText: 'First namespace source.',
    });
    scaled.assert('second', 'pet(rahul, luna).', {
      opId: 'second-source',
      sourceText: 'Second namespace source.',
    });
    scaled.assert(
      'noise',
      Array.from(
        { length: 40 },
        (_, index) => `noise_${String(index).padStart(3, '0')}(value_${index}).`
      ).join('\n')
    );
    const llm = new ScriptedLlm(['?- pet(rahul, Name).']);

    const result = await retrieveQuestion(
      { store: scaled, llm, recallSchemaPredicateLimit: 2 },
      'What is Rahul’s pet?',
      ['second', 'first', 'noise'],
      { explain: true }
    );

    expect(result.status).toBe('answered');
    expect(result.explanation?.rows[0].proofs[0]).toMatchObject({
      predicate: 'pet',
      sources: [expect.objectContaining({ namespace: 'second', opId: 'second-source' })],
    });
  });

  it('uses a complete name/arity catalog when the relevant predicate is outside details', async () => {
    const scaled = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-recall-catalog-')));
    scaled.assert(
      'default',
      `${Array.from({ length: 40 }, (_, index) => `alpha_${index}(value_${index}).`).join('\n')}
       zeta_relation(target, answer).`
    );
    const llm = new ScriptedLlm(['?- zeta_relation(target, Value).']);

    const result = await retrieveQuestion(
      { store: scaled, llm, recallSchemaPredicateLimit: 2 },
      'Find the requested information'
    );

    expect(result.status).toBe('answered');
    expect(result.bindings).toEqual([{ Value: 'answer' }]);
    expect(result.pruning).toMatchObject({
      selectedPredicates: expect.not.arrayContaining(['zeta_relation/2']),
      catalogComplete: true,
    });
    expect(llm.calls[0][0].content).toContain('zeta_relation/2');
  });

  it('widens deterministically before accepting unanswerable from a partial schema', async () => {
    const scaled = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-recall-widen-')));
    scaled.assert(
      'default',
      `${Array.from({ length: 40 }, (_, index) => `alpha_${index}(value_${index}).`).join('\n')}
       zeta_relation(target, answer).`
    );
    const llm = new ScriptedLlm([
      '?- unanswerable.',
      '?- zeta_relation(target, Value).',
    ]);

    const result = await retrieveQuestion(
      { store: scaled, llm, recallSchemaPredicateLimit: 2 },
      'Find the requested information'
    );

    expect(result).toMatchObject({
      status: 'answered',
      query: 'zeta_relation(target, Value)',
      bindings: [{ Value: 'answer' }],
      pruning: {
        schemaComplete: true,
        initialSelectedPredicates: ['alpha_0/1', 'alpha_1/1'],
        attempts: [
          expect.objectContaining({ detailedPredicates: 2, outcome: 'unanswerable' }),
          expect.objectContaining({ detailedPredicates: 41, outcome: 'answered' }),
        ],
      },
    });
    expect(llm.calls).toHaveLength(2);
  });

  it('fails closed instead of claiming unanswerable when the predicate catalog is bounded', async () => {
    const scaled = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-recall-budget-')));
    scaled.assert(
      'default',
      Array.from(
        { length: 180 },
        (_, index) =>
          `very_long_predicate_name_${String(index).padStart(3, '0')}(entity_${index}, value_${index}).`
      ).join('\n')
    );
    const llm = new ScriptedLlm(['?- unanswerable.']);

    const result = await recallQuestion(
      {
        store: scaled,
        llm,
        recallSchemaPredicateLimit: 2,
        recallSchemaByteLimit: 512,
      },
      'What relationship is stored?'
    );

    expect(result).toMatchObject({
      status: 'schema_budget_exhausted',
      query: null,
      bindings: [],
      pruning: { catalogComplete: false },
    });
    expect(result.answer).toMatch(/schema budget/i);
    expect(llm.calls).toHaveLength(1);
  });

  it('reports budget exhaustion when selected rule text cannot fit the byte cap', async () => {
    const scaled = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-recall-rule-budget-')));
    const facts = Array.from(
      { length: 20 },
      (_, index) => `base_${String(index).padStart(3, '0')}(item).`
    );
    const body = Array.from(
      { length: 20 },
      (_, index) => `base_${String(index).padStart(3, '0')}(X)`
    ).join(', ');
    scaled.assert('default', `${facts.join('\n')}\nimportant(X) :- ${body}.`);
    const llm = new ScriptedLlm(['?- unanswerable.']);

    const result = await retrieveQuestion(
      { store: scaled, llm, recallSchemaByteLimit: 512 },
      'What is important?'
    );

    expect(result).toMatchObject({
      status: 'schema_budget_exhausted',
      query: null,
      pruning: {
        schemaComplete: false,
        omittedRules: 1,
        attempts: [expect.objectContaining({ outcome: 'unanswerable' })],
      },
    });
  });

  it('widens before recall when the relevant dependency closure exceeds the first-pass cap', async () => {
    const scaled = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-recall-closure-')));
    scaled.assert(
      'default',
      `base_a(x). base_b(x). base_c(x).
       important(X) :- base_a(X), base_b(X), base_c(X).`
    );
    const llm = new ScriptedLlm(['?- important(Value).']);

    const result = await retrieveQuestion(
      { store: scaled, llm, recallSchemaPredicateLimit: 2 },
      'What is important?'
    );

    expect(result).toMatchObject({
      status: 'answered',
      query: 'important(Value)',
      bindings: [{ Value: 'x' }],
    });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0][0].content).toContain(
      'important(X) :- base_a(X), base_b(X), base_c(X).'
    );
  });

  it('returns bounded exhaustion instead of throwing on oversized predicate names', async () => {
    const scaled = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-recall-name-budget-')));
    const clauses = Array.from(
      { length: 4 },
      (_, index) => `${'p'.repeat(8_000)}_${index}(value).`
    ).join('\n');
    scaled.assert('default', clauses);
    const llm = new ScriptedLlm([]);

    const result = await recallQuestion({ store: scaled, llm }, 'What is stored?');

    expect(result).toEqual({
      status: 'schema_budget_exhausted',
      answer: 'Recall reached its schema budget before it could rule out relevant memories.',
      query: null,
      bindings: [],
    });
    expect(llm.calls).toHaveLength(0);
  });

  it('generates exact count aggregation and treats zero as a real result', async () => {
    const llm = new ScriptedLlm([
      '?- count(*) as Count where works_at(Person, nowhere).',
    ]);
    const result = await retrieveQuestion(
      { store, llm },
      'How many people work at Nowhere?',
      ['default'],
      { explain: true }
    );

    expect(result).toMatchObject({
      query: 'count(*) as Count where works_at(Person, nowhere)',
      bindings: [{ Count: '0' }],
    });
    expect(result.explanation?.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'aggregate',
          op: 'count',
          value: 0,
          contributorCount: 0,
        }),
      ])
    );
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0][0].content).toContain('count(*) as Count where');
  });

  it('generates and evaluates an explicit arithmetic threshold query', async () => {
    const numeric = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-arithmetic-')));
    numeric.assert(
      'default',
      'age(alice, 30). age(bob, 20). age(carol, 38). age(dana, 27).'
    );
    const llm = new ScriptedLlm([
      '?- age(Person, Years), age(dana, DanaYears), Years > DanaYears + 5.',
    ]);

    const result = await retrieveQuestion(
      { store: numeric, llm },
      'Who is more than 5 years older than Dana?'
    );

    expect(result).toEqual({
      status: 'answered',
      query: 'age(Person, Years), age(dana, DanaYears), Years > DanaYears + 5',
      bindings: [{ Person: 'carol', Years: '38', DanaYears: '27' }],
    });
    expect(llm.calls[0][0].content).toContain('Years > DanaYears + 5');
  });

  it('recall-explain carries temporal source metadata for an archived fact', async () => {
    const temporal = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-recall-temporal-')));
    temporal.assert('default', 'works_at(mira, acme).', {
      opId: 'source-1',
      sourceText: 'Mira works at Acme.',
      at: new Date('2026-08-10T09:00:00.000Z'),
    });
    await (rememberText as unknown as (
      deps: { store: MemoryStore; llm: LlmClient },
      text: string,
      namespace?: string,
      options?: { validTimeMode?: 'delete' | 'archive_until'; at?: Date }
    ) => Promise<unknown>)(
      { store: temporal, llm: new ScriptedLlm(['retract works_at(mira, _).\nworks_at(mira, initech).']) },
      'Mira now works at Initech',
      'default',
      { validTimeMode: 'archive_until', at: new Date('2026-08-16T16:59:00.000Z') }
    );
    const llm = new ScriptedLlm([
      '?- works_at(mira, initech), works_at_until(mira, Company, Until).',
      'Mira worked at Acme until 16 August 2026.',
    ]);

    const result = await recallQuestion(
      { store: temporal, llm },
      'Where did Mira work before Initech?',
      ['default'],
      { explain: true }
    );

    expect(result.answer).toBe('Mira worked at Acme until 16 August 2026.');
    expect(result.explanation?.rows[0].proofs[1]).toMatchObject({
      predicate: 'works_at_until',
      sources: [
        expect.objectContaining({
          opId: expect.any(String),
          ts: expect.any(String),
          temporal: {
            kind: 'superseded',
            previousClause: 'works_at(mira, acme).',
            validUntil: '2026-08-16T16:59:00.000Z',
          },
        }),
      ],
    });
    expect(llm.calls[0][0].content).toContain(
      'works_at(mira, initech), works_at_until(mira, Company, Until)'
    );
  });

  it('retries an aggregate the question did not explicitly request', async () => {
    const llm = new ScriptedLlm([
      '?- count(*) as Count where works_at(Person, acme).',
      '?- works_at(Person, acme).',
    ]);
    const result = await retrieveQuestion({ store, llm }, 'Who works at Acme?');

    expect(result.bindings).toEqual([{ Person: 'rahul' }, { Person: 'maya' }]);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].at(-1)?.content).toContain(
      'requires the question to explicitly request'
    );
  });

  it('retries a relational query when the question explicitly requests a count', async () => {
    const llm = new ScriptedLlm([
      '?- works_at(Person, acme).',
      '?- count(*) as Count where works_at(Person, acme).',
    ]);
    const result = await retrieveQuestion({ store, llm }, 'How many people work at Acme?');

    expect(result.bindings).toEqual([{ Count: '2' }]);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].at(-1)?.content).toContain(
      'question explicitly requests count aggregation'
    );
  });

  it('can generate and explain a safe closed-world negation query', async () => {
    const employment = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-negation-')));
    employment.assert('default', 'employee(alice). employee(bob). suspended(bob).', {
      opId: 'employment-source',
    });
    const llm = new ScriptedLlm(['?- employee(X), \\+ suspended(X).']);

    const result = await retrieveQuestion(
      { store: employment, llm },
      'Which employees are not suspended?',
      ['default'],
      { explain: true }
    );

    expect(result.query).toBe('employee(X), \\+ suspended(X)');
    expect(result.bindings).toEqual([{ X: 'alice' }]);
    expect(result.explanation?.rows[0].proofs).toEqual([
      expect.objectContaining({ predicate: 'employee' }),
      {
        negated: true,
        predicate: 'suspended',
        pattern: ['alice'],
        stratum: 0,
      },
    ]);
    expect(llm.calls[0][0].content).toContain('Closed-world negation is written \\+');
  });

  it('allows a negated relation with no stored facts under closed-world recall', async () => {
    const employment = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-absent-relation-')));
    employment.assert('default', 'employee(alice). employee(bob).');
    const llm = new ScriptedLlm(['?- employee(X), \\+ suspended(X).']);

    const result = await retrieveQuestion(
      { store: employment, llm },
      'Which employees are not suspended?'
    );

    expect(result.bindings).toEqual([{ X: 'alice' }, { X: 'bob' }]);
  });

  it('retries a misspelled negated predicate instead of proving the typo by absence', async () => {
    const employment = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-negation-typo-')));
    employment.assert('default', 'employee(alice). employee(bob). suspended(bob).');
    const llm = new ScriptedLlm([
      '?- employee(X), \\+ suspendd(X).',
      '?- employee(X), \\+ suspended(X).',
    ]);

    const result = await retrieveQuestion(
      { store: employment, llm },
      'Which employees are not suspended?'
    );

    expect(result.bindings).toEqual([{ X: 'alice' }]);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].at(-1)?.content).toContain('resembles suspended/1');
  });

  it('rejects an absent negated relation that the question did not name', async () => {
    const employment = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-negation-ungrounded-')));
    employment.assert('default', 'employee(alice).');
    const llm = new ScriptedLlm([
      '?- employee(X), \\+ blacklisted(X).',
      '?- employee(X), \\+ blacklisted(X).',
    ]);

    await expect(
      retrieveQuestion({ store: employment, llm }, 'Which employees are not suspended?')
    ).rejects.toThrow('must be explicitly named by the question');
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

  it('preserves a valid empty query when the fallback repeats it unchanged', async () => {
    const llm = new ScriptedLlm([
      '?- works_at(zoe, X).',
      '?- works_at(zoe, X).',
      "I don't have that in memory.",
    ]);
    const result = await recallQuestion({ store, llm }, 'Where does Zoe work?');
    expect(result.bindings).toEqual([]);
    expect(result.query).toBe('works_at(zoe, X)');
    expect(result.answer).toMatch(/don't have/i);
    expect(llm.calls).toHaveLength(3);
    expect(llm.calls[1].at(-1)?.content).toContain('empty result is valid evidence');
  });

  it('accepts structurally unanswerable as the fallback response and skips phrasing', async () => {
    const llm = new ScriptedLlm(['?- works_at(zoe, X).', '?- unanswerable.']);
    const result = await recallQuestion({ store, llm }, 'Why does Zoe work there?');
    expect(result.bindings).toEqual([]);
    expect(result.query).toBeNull();
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
