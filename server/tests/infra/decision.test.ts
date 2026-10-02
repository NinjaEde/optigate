import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  NONE_OPTION,
  DecisionOutputError,
  candidateKey,
  normalizeRanking,
  parseDecisionPayload,
  toDecisionCandidates,
  type DecisionCandidate,
} from '../../src/domain/toolDecision.js';
import { createOpenAiCompatibleDecisionModel } from '../../src/infra/decision/openaiCompatible.js';
import { createJevDecisionModel } from '../../src/infra/decision/jev.js';
import { withDecisionCache } from '../../src/infra/decision/cache.js';

const CANDIDATES: DecisionCandidate[] = [
  { key: 's1::greet', name: 'greet', serverName: 'Alpha', description: 'Say hello' },
  { key: 's1::echo', name: 'echo', serverName: 'Alpha', description: 'Echo input' },
  { key: 's2::file_read', name: 'file_read', serverName: 'Beta', description: 'Read a file' },
];

const BASE_CONFIG = {
  baseUrl: 'https://decision.example',
  model: 'test-model',
  timeoutMs: 1000,
};

type FetchMock = ReturnType<typeof vi.fn>;

function stubFetch(impl: (...args: unknown[]) => unknown): FetchMock {
  const mock = vi.fn(impl) as unknown as FetchMock;
  vi.stubGlobal('fetch', mock);
  return mock;
}

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeRanking', () => {
  it('sorts best-first and clamps scores', () => {
    const scores = normalizeRanking(
      [
        { key: 'a', score: 0.3 },
        { key: 'b', score: 5 },
        { key: 'c', score: -1 },
      ],
      new Set(['a', 'b', 'c']),
    );
    expect(scores).toEqual([
      { key: 'b', score: 1 },
      { key: 'a', score: 0.3 },
      { key: 'c', score: 0 },
    ]);
  });

  it('drops unknown and duplicate keys', () => {
    const scores = normalizeRanking(
      [
        { key: 's1::greet', score: 0.5 },
        { key: 'injected::tool', score: 1 },
        { key: 's1::greet', score: 0.9 },
      ],
      new Set(CANDIDATES.map((c) => c.key)),
    );
    expect(scores).toEqual([{ key: 's1::greet', score: 0.5 }]);
  });

  it('skips non-object entries defensively', () => {
    const scores = normalizeRanking(
      [null, undefined, 42, 'x', { key: 's1::greet', score: 0.5 }],
      new Set(CANDIDATES.map((c) => c.key)),
    );
    expect(scores).toEqual([{ key: 's1::greet', score: 0.5 }]);
  });
});

describe('parseDecisionPayload', () => {
  it('parses a valid ranking', () => {
    const result = parseDecisionPayload(
      { none: false, ranking: [{ key: 's1::echo', score: 0.9 }, { key: 's1::greet', score: 0.2 }] },
      CANDIDATES,
    );
    expect(result.outcome).toEqual({
      kind: 'ranking',
      scores: [
        { key: 's1::echo', score: 0.9 },
        { key: 's1::greet', score: 0.2 },
      ],
    });
  });

  it('maps none=true to a none outcome with inverted confidence', () => {
    const result = parseDecisionPayload(
      { none: true, ranking: [{ key: 's1::greet', score: 0.2 }] },
      CANDIDATES,
    );
    expect(result.outcome).toEqual({ kind: 'none', confidence: 0.8 });
  });

  it('rejects structurally broken payloads', () => {
    expect(() => parseDecisionPayload('nope', CANDIDATES)).toThrow(DecisionOutputError);
    expect(() => parseDecisionPayload({ ranking: 'x' }, CANDIDATES)).toThrow(DecisionOutputError);
    expect(() =>
      parseDecisionPayload({ none: false, ranking: [] }, CANDIDATES),
    ).toThrow(DecisionOutputError);
  });

  it('rejects rankings that filter down to nothing', () => {
    // only injection keys → empty after filtering → invalid output
    expect(() =>
      parseDecisionPayload(
        { none: false, ranking: [{ key: 'attacker::tool', score: 1 }] },
        CANDIDATES,
      ),
    ).toThrow(DecisionOutputError);
  });
});

describe('openai-compatible adapter', () => {
  it('posts chat completions and parses the ranking', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                none: false,
                ranking: [
                  { key: 's1::echo', score: 0.9 },
                  { key: 's1::greet', score: 0.4 },
                ],
              }),
            },
          },
        ],
      }),
    );

    const model = createOpenAiCompatibleDecisionModel({
      ...BASE_CONFIG,
      apiKey: 'sk-test',
    });
    const result = await model.select({ query: 'echo things', candidates: CANDIDATES, limit: 2 });

    expect(result.outcome).toEqual({
      kind: 'ranking',
      scores: expect.arrayContaining([
        { key: 's1::echo', score: 0.9 },
      ]),
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://decision.example/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string) as {
      model: string;
      temperature: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('test-model');
    expect(body.temperature).toBe(0);
    expect(body.messages[1].content).toContain('echo things');
  });

  it('omits the auth header without an API key', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({
        choices: [{ message: { content: '{"none":true,"ranking":[]}' } }],
      }),
    );
    const model = createOpenAiCompatibleDecisionModel(BASE_CONFIG);
    const result = await model.select({ query: 'q', candidates: CANDIDATES, limit: 2 });
    expect(result.outcome).toEqual({ kind: 'none', confidence: 1 });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('treats unparseable JSON as invalid output', async () => {
    stubFetch(() => jsonResponse({ choices: [{ message: { content: 'not json' } }] }));
    const model = createOpenAiCompatibleDecisionModel(BASE_CONFIG);
    await expect(
      model.select({ query: 'q', candidates: CANDIDATES, limit: 2 }),
    ).rejects.toThrow(DecisionOutputError);
  });

  it('surfaces HTTP errors', async () => {
    stubFetch(() => jsonResponse({ error: 'boom' }, 500));
    const model = createOpenAiCompatibleDecisionModel(BASE_CONFIG);
    await expect(
      model.select({ query: 'q', candidates: CANDIDATES, limit: 2 }),
    ).rejects.toThrow('decision model HTTP 500');
  });
});

describe('jev adapter', () => {
  it('ranks by Choice probabilities', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({
        answers: {
          tool_selection: {
            type: 'choice',
            choice: 's2::file_read',
            confidence: 0.9,
            probabilities: {
              's1::greet': 0.1,
              's1::echo': 0.2,
              [NONE_OPTION]: 0.05,
              's2::file_read': 0.65,
            },
          },
        },
      }),
    );

    const model = createJevDecisionModel(BASE_CONFIG);
    const result = await model.select({ query: 'read a file', candidates: CANDIDATES, limit: 2 });

    expect(result.outcome).toEqual({
      kind: 'ranking',
      scores: [
        { key: 's2::file_read', score: 0.65 },
        { key: 's1::echo', score: 0.2 },
        { key: 's1::greet', score: 0.1 },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://decision.example/v1/systemone');
    const body = JSON.parse(init.body as string) as {
      model: string;
      state: string;
      questions: Record<string, { type: string; criteria: Record<string, string> }>;
    };
    expect(body.model).toBe('test-model');
    expect(body.questions.tool_selection.type).toBe('choice');
    expect(Object.keys(body.questions.tool_selection.criteria)).toContain(NONE_OPTION);
    expect(body.state).toContain('read a file');
  });

  it('reports none when the none option wins', async () => {
    stubFetch(() =>
      jsonResponse({
        answers: {
          tool_selection: {
            type: 'choice',
            choice: NONE_OPTION,
            confidence: 0.95,
            probabilities: { [NONE_OPTION]: 0.9, 's1::greet': 0.1 },
          },
        },
      }),
    );
    const model = createJevDecisionModel(BASE_CONFIG);
    const result = await model.select({ query: 'q', candidates: CANDIDATES, limit: 2 });
    expect(result.outcome).toEqual({ kind: 'none', confidence: 0.95 });
  });

  it('reports none when no candidate has any probability', async () => {
    stubFetch(() =>
      jsonResponse({
        answers: { tool_selection: { type: 'choice', confidence: 0.4, probabilities: {} } },
      }),
    );
    const model = createJevDecisionModel(BASE_CONFIG);
    const result = await model.select({ query: 'q', candidates: CANDIDATES, limit: 2 });
    expect(result.outcome).toEqual({ kind: 'none', confidence: 0.4 });
  });

  it('defaults the endpoint and model', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ answers: { tool_selection: { confidence: 1, probabilities: { 's1::greet': 1 } } } }),
    );
    const model = createJevDecisionModel({ ...BASE_CONFIG, baseUrl: '', model: '' });
    await model.select({ query: 'q', candidates: CANDIDATES, limit: 2 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((JSON.parse(init.body as string) as { model: string }).model).toBe('jev-latest');
  });

  it('routes OpenRouter base URLs to the Decisions API', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ answers: { tool_selection: { confidence: 1, probabilities: { 's1::greet': 1 } } } }),
    );
    const model = createJevDecisionModel({
      ...BASE_CONFIG,
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    await model.select({ query: 'q', candidates: CANDIDATES, limit: 2 });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
  });

  it('honors a definitive choice without probabilities', async () => {
    stubFetch(() =>
      jsonResponse({
        answers: {
          tool_selection: {
            type: 'choice',
            choice: 's1::echo',
            confidence: 0.9,
          },
        },
      }),
    );
    const model = createJevDecisionModel(BASE_CONFIG);
    const result = await model.select({ query: 'q', candidates: CANDIDATES, limit: 2 });
    expect(result.outcome).toEqual({
      kind: 'ranking',
      scores: [
        { key: 's1::echo', score: 1 },
        { key: 's1::greet', score: 0 },
        { key: 's2::file_read', score: 0 },
      ],
    });
  });

  it('honors a none choice without probabilities', async () => {
    stubFetch(() =>
      jsonResponse({
        answers: {
          tool_selection: { type: 'choice', choice: NONE_OPTION, confidence: 0.8 },
        },
      }),
    );
    const model = createJevDecisionModel(BASE_CONFIG);
    const result = await model.select({ query: 'q', candidates: CANDIDATES, limit: 2 });
    expect(result.outcome).toEqual({ kind: 'none', confidence: 0.8 });
  });

  it('ignores a choice naming an unknown candidate', async () => {
    stubFetch(() =>
      jsonResponse({
        answers: {
          tool_selection: { type: 'choice', choice: 'attacker::tool', confidence: 0.9 },
        },
      }),
    );
    const model = createJevDecisionModel(BASE_CONFIG);
    const result = await model.select({ query: 'q', candidates: CANDIDATES, limit: 2 });
    expect(result.outcome).toEqual({ kind: 'none', confidence: 0.9 });
  });

  it('rejects a missing answer', async () => {
    stubFetch(() => jsonResponse({ answers: {} }));
    const model = createJevDecisionModel(BASE_CONFIG);
    await expect(
      model.select({ query: 'q', candidates: CANDIDATES, limit: 2 }),
    ).rejects.toThrow(DecisionOutputError);
  });
});

describe('decision cache', () => {
  it('serves repeated selections from cache', async () => {
    const select = vi.fn().mockResolvedValue({
      outcome: { kind: 'ranking', scores: [{ key: 's1::greet', score: 1 }] },
    });
    const model = withDecisionCache(
      { provider: 'fake', select } as unknown as Parameters<typeof withDecisionCache>[0],
      { ttlMs: 1000 },
    );

    const request = { query: 'q', candidates: CANDIDATES, limit: 2 };
    await model.select(request);
    await model.select(request);

    expect(select).toHaveBeenCalledTimes(1);
  });

  it('distinguishes candidate sets and expires entries', async () => {
    const select = vi.fn().mockResolvedValue({
      outcome: { kind: 'none', confidence: 1 },
    });
    const model = withDecisionCache(
      { provider: 'fake', select } as unknown as Parameters<typeof withDecisionCache>[0],
      { ttlMs: 10 },
    );

    await model.select({ query: 'q', candidates: CANDIDATES, limit: 2 });
    await model.select({ query: 'q', candidates: CANDIDATES.slice(0, 2), limit: 2 });
    expect(select).toHaveBeenCalledTimes(2);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await model.select({ query: 'q', candidates: CANDIDATES, limit: 2 });
    expect(select).toHaveBeenCalledTimes(3);
  });
});

describe('candidateKey / toDecisionCandidates', () => {
  it('builds stable keys and truncates descriptions', () => {
    expect(candidateKey('s1', 'greet')).toBe('s1::greet');
    const candidates = toDecisionCandidates(
      [
        {
          serverId: 's1',
          serverName: 'Alpha',
          name: 'greet',
          description: 'x'.repeat(500),
          inputSchema: {},
          score: 3,
        },
      ],
      100,
    );
    expect(candidates[0].description).toHaveLength(100);
    expect(candidates[0].key).toBe('s1::greet');
  });
});
