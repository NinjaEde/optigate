import { describe, it, expect, vi } from 'vitest';

import { searchWithDecision } from '../../src/infra/decision/decisionSearch.js';
import { createOpenAiCompatibleDecisionModel } from '../../src/infra/decision/openaiCompatible.js';
import {
  DecisionOutputError,
  type DecisionModel,
  type DecisionResult,
} from '../../src/domain/toolDecision.js';

const INDEX = [
  { serverId: 's1', serverName: 'Alpha', name: 'greet', description: 'Say hello', inputSchema: {} },
  { serverId: 's1', serverName: 'Alpha', name: 'echo', description: 'Echo input', inputSchema: {} },
];

const POOL_LEXICAL = vi.fn(
  async (tools: typeof INDEX, _query: string, limit: number) =>
    tools.slice(0, limit).map((t) => ({ ...t, score: 1 })),
);

function fakeModel(outcome: DecisionResult['outcome'] | Error) {
  const select =
    outcome instanceof Error
      ? vi.fn().mockRejectedValue(outcome)
      : vi.fn().mockResolvedValue({ outcome });
  return { model: { provider: 'fake', select } as DecisionModel, candidatePool: 5 };
}

describe('searchWithDecision', () => {
  it('reranks the pool and records provider metadata', async () => {
    const decision = fakeModel({
      kind: 'ranking',
      scores: [
        { key: 's1::echo', score: 0.9 },
        { key: 's1::greet', score: 0.4 },
      ],
    });

    const { tools, meta } = await searchWithDecision(
      INDEX,
      'hello',
      2,
      POOL_LEXICAL,
      async () => decision,
    );

    expect(tools.map((t) => t.name)).toEqual(['echo', 'greet']);
    expect(tools[0]).toMatchObject({ score: 0.9, lexicalScore: 1 });
    expect(meta).toMatchObject({ used: true, provider: 'fake', none: false, fallback: null });
    expect(typeof meta.latencyMs).toBe('number');
  });

  it('reports none with confidence and no tools', async () => {
    const decision = fakeModel({ kind: 'none', confidence: 0.85 });
    const { tools, meta } = await searchWithDecision(
      INDEX,
      'zzz',
      2,
      POOL_LEXICAL,
      async () => decision,
    );

    expect(tools).toEqual([]);
    expect(meta).toMatchObject({ used: true, none: true, confidence: 0.85 });
  });

  it('drops unknown model keys and fills the rest lexically', async () => {
    const decision = fakeModel({
      kind: 'ranking',
      scores: [
        { key: 'attacker::tool', score: 1 },
        { key: 's1::echo', score: 0.7 },
      ],
    });

    const { tools } = await searchWithDecision(INDEX, 'q', 5, POOL_LEXICAL, async () => decision);
    expect(tools.map((t) => t.name)).toEqual(['echo', 'greet']);
  });

  it('falls back to lexical on transport errors', async () => {
    const decision = fakeModel(new Error('boom'));
    const { tools, meta } = await searchWithDecision(
      INDEX,
      'q',
      2,
      POOL_LEXICAL,
      async () => decision,
    );

    expect(tools.map((t) => t.name)).toEqual(['greet', 'echo']);
    expect(meta).toMatchObject({ used: false, fallback: 'error', error: 'boom' });
  });

  it('distinguishes invalid model output', async () => {
    const decision = fakeModel(new DecisionOutputError('bad json'));
    const { meta } = await searchWithDecision(INDEX, 'q', 2, POOL_LEXICAL, async () => decision);
    expect(meta.fallback).toBe('invalid_output');
  });

  it('reports disabled when no model is configured', async () => {
    for (const resolve of [undefined, async () => null] as const) {
      const { tools, meta } = await searchWithDecision(INDEX, 'q', 2, POOL_LEXICAL, resolve);
      expect(tools.map((t) => t.name)).toEqual(['greet', 'echo']);
      expect(meta).toMatchObject({ used: false, fallback: 'disabled' });
    }
  });

  it('reports no_candidates on an empty pool without calling the model', async () => {
    const select = vi.fn();
    const { tools, meta } = await searchWithDecision(
      [],
      'q',
      2,
      POOL_LEXICAL,
      async () => ({ model: { provider: 'fake', select } as DecisionModel, candidatePool: 5 }),
    );

    expect(tools).toEqual([]);
    expect(meta).toMatchObject({ used: false, fallback: 'no_candidates' });
    expect(select).not.toHaveBeenCalled();
  });

  it('surfaces unreachable provider endpoints as error fallback', async () => {
    const model = createOpenAiCompatibleDecisionModel({
      baseUrl: 'http://127.0.0.1:1',
      model: 'test-model',
      timeoutMs: 2000,
    });

    const { tools, meta } = await searchWithDecision(
      INDEX,
      'q',
      2,
      POOL_LEXICAL,
      async () => ({ model, candidatePool: 5 }),
    );

    expect(tools.map((t) => t.name)).toEqual(['greet', 'echo']);
    expect(meta.used).toBe(false);
    expect(meta.fallback).toBe('error');
  });
});
