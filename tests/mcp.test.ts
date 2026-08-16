import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, LlmClient } from '../src/llm/client.js';
import { createServer } from '../src/mcp/server.js';
import { MemoryStore } from '../src/store/store.js';

class ScriptedLlm implements LlmClient {
  constructor(private responses: string[]) {}
  async complete(_messages: ChatMessage[]): Promise<string> {
    const response = this.responses.shift();
    if (response === undefined) throw new Error('out of responses');
    return response;
  }
}

describe('MCP explanation surfaces', () => {
  it('registers and executes explain_query and recall_explain over the real protocol', async () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-mcp-')));
    store.assert('default', 'pet(rahul, luna).', {
      opId: 'mcp-source',
      sourceText: 'My cat is called Luna.',
    });
    store.assert('default', 'employee(alice). employee(bob). suspended(bob).');
    store.assert('default', ':- employee(X), suspended(X).', {
      opId: 'mcp-integrity-policy',
    });
    store.assert('default', 'score(alice, 20). score(bob, 14). baseline(team, 10).');
    store.assert(
      'default',
      'left(a). right(a). answer(X) :- left(X). answer(X) :- right(X).'
    );
    store.assert(
      'default',
      `rembero_alias('Mira Patel', mira).
       rembero_entity_position(works_at, 2, 0).
       works_at('Mira Patel', acme).`,
      { opId: 'mcp-identity-source' }
    );
    const server = createServer({
      store,
      llm: new ScriptedLlm(['?- pet(rahul, Name).', 'Your cat is Luna.']),
    });
    const client = new Client({ name: 'rembero-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect(client.getServerVersion()).toEqual({ name: 'rembero', version: '0.15.0' });
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'explain_query',
          'recall_explain',
          'check_integrity',
          'history',
        ])
      );

      const asserted = await client.callTool({
        name: 'assert_facts',
        arguments: { clauses: 'retry_fact(alpha).', opId: 'mcp-assert-retry' },
      });
      const assertedText = asserted.content.find((item) => item.type === 'text');
      const assertedPayload = JSON.parse(
        assertedText?.type === 'text' ? assertedText.text : ''
      );
      expect(assertedPayload).toMatchObject({
        added: ['retry_fact(alpha).'],
        duplicates: 0,
        opId: 'mcp-assert-retry',
      });
      const replayed = await client.callTool({
        name: 'assert_facts',
        arguments: { clauses: 'retry_fact(alpha).', opId: 'mcp-assert-retry' },
      });
      const replayedText = replayed.content.find((item) => item.type === 'text');
      expect(JSON.parse(replayedText?.type === 'text' ? replayedText.text : '')).toEqual(
        assertedPayload
      );
      const conflict = await client.callTool({
        name: 'assert_facts',
        arguments: { clauses: 'retry_fact(beta).', opId: 'mcp-assert-retry' },
      });
      expect(conflict.isError).toBe(true);
      const conflictText = conflict.content.find((item) => item.type === 'text');
      expect(JSON.parse(conflictText?.type === 'text' ? conflictText.text : '')).toEqual({
        error: 'operation_conflict',
        message: "assert operation 'mcp-assert-retry' was already used for another mutation",
        operation: 'assert',
        namespace: 'default',
        opId: 'mcp-assert-retry',
      });

      const forgotten = await client.callTool({
        name: 'forget',
        arguments: { pattern: 'retry_fact(_)', opId: 'mcp-forget-retry' },
      });
      const forgottenText = forgotten.content.find((item) => item.type === 'text');
      const forgottenPayload = JSON.parse(
        forgottenText?.type === 'text' ? forgottenText.text : ''
      );
      expect(forgottenPayload).toEqual({ removed: 1, opId: 'mcp-forget-retry' });
      const forgottenReplay = await client.callTool({
        name: 'forget',
        arguments: { pattern: 'retry_fact( _ )', opId: 'mcp-forget-retry' },
      });
      const forgottenReplayText = forgottenReplay.content.find(
        (item) => item.type === 'text'
      );
      expect(
        JSON.parse(
          forgottenReplayText?.type === 'text' ? forgottenReplayText.text : ''
        )
      ).toEqual(forgottenPayload);

      const explained = await client.callTool({
        name: 'explain_query',
        arguments: { query: 'pet(rahul, Name)' },
      });
      const explainText = explained.content.find((item) => item.type === 'text');
      expect(explainText?.type).toBe('text');
      const explainPayload = JSON.parse(explainText?.type === 'text' ? explainText.text : '');
      expect(explainPayload.rows[0].proofs[0]).toMatchObject({
        predicate: 'pet',
        sources: [{ opId: 'mcp-source' }],
      });

      const alternatives = await client.callTool({
        name: 'explain_query',
        arguments: { query: 'answer(a)', proofLimit: 2 },
      });
      const alternativesText = alternatives.content.find((item) => item.type === 'text');
      const alternativesPayload = JSON.parse(
        alternativesText?.type === 'text' ? alternativesText.text : ''
      );
      expect(alternativesPayload.rows[0]).toMatchObject({
        proofs: [expect.objectContaining({ rule: 1 })],
        alternativeProofs: [[expect.objectContaining({ rule: 2 })]],
      });
      expect(alternativesPayload.graph.nodes).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'proof' })])
      );

      const integrity = await client.callTool({
        name: 'check_integrity',
        arguments: {
          maxViolations: 10,
          graphSelector: { kind: 'result', row: 1 },
        },
      });
      const integrityText = integrity.content.find((item) => item.type === 'text');
      const integrityPayload = JSON.parse(
        integrityText?.type === 'text' ? integrityText.text : ''
      );
      expect(integrityPayload).toMatchObject({
        status: 'violations',
        constraintCount: 1,
        violationCount: 1,
        checks: [
          {
            sources: [{ opId: 'mcp-integrity-policy' }],
            rows: [{ bindings: { X: 'bob' } }],
            graphSelection: { selector: { kind: 'result', row: 1 } },
          },
        ],
      });

      const negated = await client.callTool({
        name: 'explain_query',
        arguments: { query: 'employee(X), \\+ suspended(X)' },
      });
      const negatedText = negated.content.find((item) => item.type === 'text');
      const negatedPayload = JSON.parse(
        negatedText?.type === 'text' ? negatedText.text : ''
      );
      expect(negatedPayload.rows).toEqual([
        expect.objectContaining({ bindings: { X: 'alice' } }),
      ]);
      expect(negatedPayload.graph.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'absence', predicate: 'suspended' }),
        ])
      );

      const aggregated = await client.callTool({
        name: 'explain_query',
        arguments: { query: 'count(*) as Count where employee(Person)' },
      });
      const aggregatedText = aggregated.content.find((item) => item.type === 'text');
      const aggregatedPayload = JSON.parse(
        aggregatedText?.type === 'text' ? aggregatedText.text : ''
      );
      expect(aggregatedPayload.rows).toEqual([
        expect.objectContaining({ bindings: { Count: '2' } }),
      ]);
      expect(aggregatedPayload.graph.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'aggregate', op: 'count', value: 2 }),
        ])
      );

      const arithmetic = await client.callTool({
        name: 'query',
        arguments: {
          query: 'score(Person, Points), baseline(team, Base), Points > Base + 5',
        },
      });
      const arithmeticText = arithmetic.content.find((item) => item.type === 'text');
      const arithmeticPayload = JSON.parse(
        arithmeticText?.type === 'text' ? arithmeticText.text : ''
      );
      expect(arithmeticPayload.bindings).toEqual([
        { Person: 'alice', Points: '20', Base: '10' },
      ]);

      const identity = await client.callTool({
        name: 'explain_query',
        arguments: {
          query: 'works_at(mira, Company)',
          entityIdentity: 'canonical',
        },
      });
      const identityText = identity.content.find((item) => item.type === 'text');
      const identityPayload = JSON.parse(
        identityText?.type === 'text' ? identityText.text : ''
      );
      expect(identityPayload.rows[0]).toMatchObject({
        bindings: { Company: 'acme' },
        proofs: [
          {
            sources: [
              expect.objectContaining({
                projectedFrom: "works_at('Mira Patel', acme).",
                identityRewrites: [
                  expect.objectContaining({ original: 'Mira Patel', canonical: 'mira' }),
                ],
              }),
            ],
          },
        ],
      });

      const recalled = await client.callTool({
        name: 'recall_explain',
        arguments: {
          question: 'What is my cat called?',
          graphSelector: { kind: 'result', row: 1 },
        },
      });
      const recallText = recalled.content.find((item) => item.type === 'text');
      const recallPayload = JSON.parse(recallText?.type === 'text' ? recallText.text : '');
      expect(recallPayload).toMatchObject({
        answer: 'Your cat is Luna.',
        bindings: [{ Name: 'luna' }],
        explanation: {
          rows: [{ bindings: { Name: 'luna' } }],
          graphSelection: { selector: { kind: 'result', row: 1 } },
        },
      });

      store.assert('default', 'works_at(mira, acme).', {
        opId: 'history-1',
        sourceText: 'Mira works at Acme.',
        at: new Date('2026-08-10T09:00:00.000Z'),
      });
      (
        store as MemoryStore & {
          supersede: (
            namespace: string,
            patterns: string[],
            replacements: string,
            context?: Record<string, unknown>
          ) => unknown;
        }
      ).supersede('default', ['works_at(mira, _)'], 'works_at(mira, initech).', {
        opId: 'history-2',
        sourceText: 'Mira now works at Initech.',
        at: new Date('2026-08-16T16:59:00.000Z'),
      });
      const historical = await client.callTool({
        name: 'history',
        arguments: { pattern: 'works_at(mira, _)', namespaces: ['default'] },
      });
      const historyText = historical.content.find((item) => item.type === 'text');
      const historyPayload = JSON.parse(historyText?.type === 'text' ? historyText.text : '');
      expect(historyPayload).toMatchObject({
        pattern: 'works_at(mira, _)',
        namespaces: ['default'],
        events: [
          expect.objectContaining({
            action: 'asserted',
            clause: 'works_at(mira, acme).',
          }),
          expect.objectContaining({
            action: 'superseded',
            clause: 'works_at(mira, acme).',
            archivedAs: "works_at_until(mira, acme, '2026-08-16T16:59:00.000Z').",
          }),
          expect.objectContaining({
            action: 'asserted',
            clause: 'works_at(mira, initech).',
            current: true,
          }),
        ],
      });
      const recorded = await client.callTool({
        name: 'query',
        arguments: {
          query: 'works_at(mira, Company)',
          recordedSequence: historyPayload.events[0].sequence,
        },
      });
      const recordedText = recorded.content.find((item) => item.type === 'text');
      const recordedPayload = JSON.parse(
        recordedText?.type === 'text' ? recordedText.text : ''
      );
      expect(recordedPayload).toMatchObject({
        bindings: [{ Company: 'acme' }],
        recordedSnapshot: { sequence: historyPayload.events[0].sequence },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns proof-bearing write rejection and preserves memory over the real protocol', async () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-mcp-enforce-')));
    store.assert(
      'default',
      'active(mira). :- active(Person), suspended(Person).'
    );
    const before = store.load('default');
    const server = createServer({
      store,
      llm: new ScriptedLlm([]),
      integrityEnforcement: { mode: 'strict' },
    });
    const client = new Client({ name: 'rembero-enforcement-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const rejected = await client.callTool({
        name: 'assert_facts',
        arguments: {
          clauses: 'suspended(mira).',
          graphSelector: { kind: 'result', row: 1 },
        },
      });
      expect(rejected.isError).toBe(true);
      const text = rejected.content.find((item) => item.type === 'text');
      const payload = JSON.parse(text?.type === 'text' ? text.text : '');
      expect(payload).toMatchObject({
        error: 'integrity_violation',
        mode: 'strict',
        introducedViolationCount: 1,
        candidate: {
          checks: [
            {
              rows: [{ bindings: { Person: 'mira' } }],
              graphSelection: { selector: { kind: 'result', row: 1 } },
            },
          ],
        },
      });
      expect(store.load('default')).toEqual(before);

      const weakened = await client.callTool({
        name: 'assert_facts',
        arguments: {
          clauses: 'suspended(mira).',
          integrityMode: 'no_new_violations',
        },
      });
      expect(weakened.isError).toBe(true);
      const weakenedText = weakened.content.find((item) => item.type === 'text');
      expect(weakenedText?.type === 'text' ? weakenedText.text : '').toMatch(
        /cannot weaken strict server integrity enforcement/i
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('applies the configured valid-time mode through the real remember tool', async () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-mcp-temporal-')));
    store.assert('default', 'works_at(mira, acme).', { opId: 'mcp-before' });
    const server = createServer({
      store,
      validTimeMode: 'archive_until',
      llm: new ScriptedLlm(['retract works_at(mira, _).\nworks_at(mira, initech).']),
    });
    const client = new Client({ name: 'rembero-temporal-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const remembered = await client.callTool({
        name: 'remember',
        arguments: { text: 'Mira now works at Initech' },
      });
      const text = remembered.content.find((item) => item.type === 'text');
      const payload = JSON.parse(text?.type === 'text' ? text.text : '');
      expect(payload).toMatchObject({
        retracted: 1,
        archived: [expect.stringMatching(/^works_at_until\(mira, acme, '/)],
      });
      expect(store.load('default').map((clause) => clause.head.predicate)).toEqual(
        expect.arrayContaining(['works_at', 'works_at_until'])
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('applies a bounded schema slice through the real recall tool', async () => {
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-mcp-schema-')));
    store.assert(
      'default',
      `${Array.from({ length: 40 }, (_, index) => `alpha_${index}(value_${index}).`).join('\n')}
       zeta_relation(target, answer).`
    );
    const server = createServer({
      store,
      llm: new ScriptedLlm([
        '?- zeta_relation(target, Value).',
        'The stored answer is answer.',
      ]),
    });
    const client = new Client({ name: 'rembero-schema-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const recalled = await client.callTool({
        name: 'recall',
        arguments: {
          question: 'Find the requested information',
          schemaPredicateLimit: 2,
        },
      });
      const text = recalled.content.find((item) => item.type === 'text');
      const payload = JSON.parse(text?.type === 'text' ? text.text : '');
      expect(payload).toMatchObject({
        status: 'answered',
        answer: 'The stored answer is answer.',
        query: 'zeta_relation(target, Value)',
        bindings: [{ Value: 'answer' }],
        pruning: {
          totalPredicates: 41,
          selectedPredicates: expect.not.arrayContaining(['zeta_relation/2']),
          catalogComplete: true,
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('applies REMBERO_VALID_TIME_MODE through a programmatic MCP server', async () => {
    const previousMode = process.env.REMBERO_VALID_TIME_MODE;
    process.env.REMBERO_VALID_TIME_MODE = 'archive_until';
    const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'rembero-mcp-temporal-env-')));
    store.assert('default', 'works_at(mira, acme).', { opId: 'mcp-env-before' });
    const server = createServer({
      store,
      llm: new ScriptedLlm(['retract works_at(mira, _).\nworks_at(mira, initech).']),
    });
    const client = new Client({ name: 'rembero-temporal-env-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const remembered = await client.callTool({
        name: 'remember',
        arguments: { text: 'Mira now works at Initech' },
      });
      const text = remembered.content.find((item) => item.type === 'text');
      const payload = JSON.parse(text?.type === 'text' ? text.text : '');
      expect(payload).toMatchObject({
        retracted: 1,
        archived: [expect.stringMatching(/^works_at_until\(mira, acme, '/)],
      });
      expect(store.load('default').map((clause) => clause.head.predicate)).toEqual(
        expect.arrayContaining(['works_at', 'works_at_until'])
      );
    } finally {
      await client.close();
      await server.close();
      if (previousMode === undefined) delete process.env.REMBERO_VALID_TIME_MODE;
      else process.env.REMBERO_VALID_TIME_MODE = previousMode;
    }
  });
});
