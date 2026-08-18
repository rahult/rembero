import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/store.js';
import {
  RemberoWebService,
  WebServiceError,
} from '../src/web/service.js';
import { startWebServer } from '../src/web/server.js';

function webService(label: string): RemberoWebService {
  return new RemberoWebService({
    store: new MemoryStore(mkdtempSync(join(tmpdir(), `rembero-web-${label}-`))),
    llmConfigured: false,
  });
}

describe('Remembero web use-case service', () => {
  it('seeds one sourced personal workspace idempotently', () => {
    const service = webService('seed');

    expect(service.seedDemo()).toEqual({ seeded: true, added: 15 });
    expect(service.seedDemo()).toEqual({ seeded: false, added: 0 });
    expect(service.bootstrap()).toMatchObject({
      namespace: 'personal',
      llmConfigured: false,
      empty: false,
      counts: {
        facts: 12,
        rules: 3,
        constraints: 0,
        sourcedPercent: 100,
      },
      health: {
        status: 'healthy',
        clauseCount: 15,
        provenance: { sourceCoveragePercent: 100 },
      },
    });
  });

  it('answers a guided personal question with real rule proof and sources', async () => {
    const service = webService('ask');
    service.seedDemo();

    const result = await service.ask({
      question: 'Who is collaborating on Atlas?',
      presetId: 'collaborators',
    });

    expect(result).toMatchObject({
      mode: 'guided-local',
      status: 'answered',
      query: 'collaborator(Person, atlas)',
      answer: 'Maya is collaborating on Atlas.',
      bindings: [{ Person: 'maya' }],
      evidence: {
        claims: expect.arrayContaining([
          'project_owner(atlas, rahul)',
          'project_contributor(atlas, maya)',
        ]),
        rules: [
          expect.objectContaining({
            clause:
              'collaborator(Person, Project) :- project_owner(Project, Owner), project_contributor(Project, Person), Owner != Person.',
          }),
        ],
        sources: expect.arrayContaining([
          expect.objectContaining({ opId: 'web-demo-atlas-session-v1' }),
        ]),
      },
      explanation: { rows: [{ bindings: { Person: 'maya' } }] },
    });
  });

  it('keeps a failed guided question separate from related discovery', async () => {
    const service = webService('related');
    service.seedDemo();

    const result = await service.ask({
      question: 'What gift does Maya want?',
      presetId: 'gift',
    });

    expect(result).toMatchObject({
      mode: 'guided-local',
      status: 'no_match',
      query: 'prefers_gift(maya, Gift)',
      bindings: [],
      whyNot: { status: 'blocked' },
      relatedKnowledge: { status: 'matches' },
    });
    expect(result.answer).toMatch(/don't have a supported answer/i);
    expect(result.relatedKnowledge.results.length).toBeGreaterThan(0);
  });

  it('searches source phrases and browses the explicit Maya neighborhood', () => {
    const service = webService('discovery');
    service.seedDemo();

    const search = service.search({ text: 'vendor security review' });
    expect(search).toMatchObject({ status: 'matches' });
    expect(search.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sources: expect.arrayContaining([
            expect.objectContaining({
              text: expect.stringContaining('vendor security review'),
            }),
          ]),
          reasons: expect.arrayContaining([
            expect.objectContaining({ kind: 'source_phrase' }),
          ]),
        }),
      ])
    );

    const graph = service.graph({ focus: 'maya' });
    expect(graph.selection.selectedClaims).toBeGreaterThan(0);
    expect(graph.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'entity', value: 'maya' }),
        expect.objectContaining({ kind: 'claim', predicate: 'project_contributor' }),
      ])
    );
  });

  it('stores a structured fact with durable source evidence', () => {
    const service = webService('capture');
    service.seedDemo();

    expect(
      service.addMemory({
        subject: 'maya',
        predicate: 'prefers_channel',
        object: 'signal',
        sourceText: 'Maya asked me to use Signal for project updates.',
      })
    ).toMatchObject({
      status: 'saved',
      clause: 'prefers_channel(maya, signal).',
      added: 1,
      duplicate: false,
    });
    expect(service.search({ text: 'Signal project updates' }).results[0]).toMatchObject({
      clause: 'prefers_channel(maya, signal).',
      sources: [
        expect.objectContaining({
          text: 'Maya asked me to use Signal for project updates.',
        }),
      ],
    });
  });

  it('requires a configured model for arbitrary questions but keeps guided recall local', async () => {
    const service = webService('model-boundary');
    service.seedDemo();

    await expect(
      service.ask({ question: 'Tell me something surprising.' })
    ).rejects.toMatchObject<WebServiceError>({
      code: 'model_not_configured',
      status: 400,
    });
    await expect(
      service.ask({ question: 'Who owns Atlas?', presetId: 'owner' })
    ).resolves.toMatchObject({ status: 'answered', answer: 'Rahul owns Atlas.' });
  });

  it('serves the real same-origin JSON workflow over loopback HTTP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rembero-web-http-'));
    const running = await startWebServer({ root, port: 0, seedDemo: true });
    try {
      const bootstrap = await fetch(`${running.url}/api/bootstrap`).then((response) =>
        response.json()
      );
      expect(bootstrap).toMatchObject({
        namespace: 'personal',
        counts: { facts: 12, rules: 3, sourcedPercent: 100 },
      });

      const answerResponse = await fetch(`${running.url}/api/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: running.url,
        },
        body: JSON.stringify({
          question: 'Who is collaborating on Atlas?',
          presetId: 'collaborators',
        }),
      });
      expect(answerResponse.status).toBe(200);
      await expect(answerResponse.json()).resolves.toMatchObject({
        status: 'answered',
        answer: 'Maya is collaborating on Atlas.',
      });

      const rejected = await fetch(`${running.url}/api/seed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://example.invalid',
        },
        body: '{}',
      });
      expect(rejected.status).toBe(403);
      await expect(rejected.json()).resolves.toMatchObject({
        error: 'origin_rejected',
      });
    } finally {
      await running.close();
    }
  });

  it('refuses every non-loopback bind because the web console has no authentication', async () => {
    await expect(
      startWebServer({ host: '0.0.0.0', port: 0, seedDemo: false })
    ).rejects.toThrow(/loopback hosts only/i);
  });
});
