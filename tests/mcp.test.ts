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
    const server = createServer({
      store,
      llm: new ScriptedLlm(['?- pet(rahul, Name).', 'Your cat is Luna.']),
    });
    const client = new Client({ name: 'rembero-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['explain_query', 'recall_explain'])
      );

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

      const recalled = await client.callTool({
        name: 'recall_explain',
        arguments: { question: 'What is my cat called?' },
      });
      const recallText = recalled.content.find((item) => item.type === 'text');
      const recallPayload = JSON.parse(recallText?.type === 'text' ? recallText.text : '');
      expect(recallPayload).toMatchObject({
        answer: 'Your cat is Luna.',
        bindings: [{ Name: 'luna' }],
        explanation: { rows: [{ bindings: { Name: 'luna' } }] },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
