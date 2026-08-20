import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('LongMemEval-V2 Remembero bridge', () => {
  it('indexes trajectory states and returns bounded sourced context without a model', () => {
    const bridge = resolve('benchmarks/adapters/longmemeval-v2/bridge.mjs');
    const commands = [
      {
        op: 'insert',
        trajectory: {
          id: 'noise',
          environment: 'workarena',
          goal: 'Review hardware assets',
          outcome: 'success',
          states: [{
            state_index: 0,
            url: 'https://example.test/assets',
            action: 'open assets',
            thought: 'Inspect the hardware list',
            accessibility_tree: 'Assets table with laptop and monitor rows',
          }],
        },
      },
      {
        op: 'insert',
        trajectory: {
          id: 'evidence',
          environment: 'workarena',
          goal: 'Inspect incident filters',
          outcome: 'success',
          states: [{
            state_index: 0,
            url: 'https://example.test/incidents',
            action: 'open Filters',
            thought: 'Read every available incident filter',
            accessibility_tree:
              'Filters menu: Incident Mobile, Incident Portal, My Open Incidents',
          }],
        },
      },
      {
        op: 'insert',
        trajectory: {
          id: 'tail',
          environment: 'workarena',
          goal: 'Inspect a long form',
          outcome: 'success',
          states: [{
            state_index: 0,
            url: 'https://example.test/long-form',
            action: 'open long form',
            thought: 'Inspect the complete form',
            accessibility_tree:
              `${'noise '.repeat(2_000)}Tail-only marker: Depreciation effective date`,
          }],
        },
      },
      {
        op: 'query',
        query: 'Which filter option labels contain Incident?',
        topK: 1,
        sourceCharacters: 16_384,
        contextCharacters: 12_000,
      },
      {
        op: 'query',
        query: 'Where is the tail-only marker?',
        topK: 1,
        sourceCharacters: 16_384,
        contextCharacters: 12_000,
      },
      { op: 'stats' },
      { op: 'close' },
    ];
    const result = spawnSync(process.execPath, [bridge], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: `${commands.map((command) => JSON.stringify(command)).join('\n')}\n`,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const responses = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(responses).toHaveLength(7);
    expect(responses[3]).toMatchObject({
      ok: true,
      result: {
        items: [{ type: 'text', value: expect.stringContaining('Incident Mobile') }],
        metadata: {
          route: 'remembero-local-source-search',
          returnedCount: 1,
          modelCalls: 0,
          embeddingCalls: 0,
        },
      },
    });
    expect(responses[3].result.items[0].value).toContain('Source state: evidence:0');
    expect(responses[4]).toMatchObject({
      ok: true,
      result: {
        items: [{ type: 'text', value: expect.stringContaining('Tail-only marker') }],
        metadata: { embeddingCalls: 0 },
      },
    });
    expect(responses[5]).toMatchObject({
      ok: true,
      result: { trajectoryCount: 3, stateCount: 3 },
    });
  });
});
