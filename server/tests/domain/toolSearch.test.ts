import { describe, it, expect } from 'vitest';

import { scoreTool, searchTools } from '../../src/domain/toolSearch';

describe('scoreTool', () => {
  const tool = {
    serverId: 's1',
    name: 'quote_get',
    description: 'Get real-time quote data for a symbol including price and volume',
    inputSchema: {},
    lastSeenAt: new Date().toISOString(),
  };

  it('scores an exact name match highest', () => {
    const score = scoreTool(tool, 'quote_get');
    expect(score).toBeGreaterThanOrEqual(10);
  });

  it('scores partial name matches above description-only matches', () => {
    const nameScore = scoreTool(tool, 'quote');
    const descScore = scoreTool(tool, 'price volume');
    expect(nameScore).toBeGreaterThan(descScore);
  });

  it('gives nonzero score when query words appear in the description', () => {
    const score = scoreTool(tool, 'realtime price');
    expect(score).toBeGreaterThan(0);
  });

  it('returns zero for completely unrelated queries', () => {
    const score = scoreTool(tool, 'send email calendar invite');
    expect(score).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(scoreTool(tool, 'QUOTE_GET')).toBe(scoreTool(tool, 'quote_get'));
  });

  it('handles multi-word queries by summing word scores', () => {
    const single = scoreTool(tool, 'quote');
    const both = scoreTool(tool, 'quote price');
    expect(both).toBeGreaterThan(single);
  });
});

describe('searchTools', () => {
  const tools = [
    {
      serverId: 's1',
      serverName: 'Market',
      name: 'quote_get',
      description: 'Get real-time quote data for a symbol including price and volume',
      inputSchema: {},
    },
    {
      serverId: 's1',
      serverName: 'Market',
      name: 'price_alert',
      description: 'Alert when a symbol price crosses a threshold',
      inputSchema: {},
    },
    {
      serverId: 's1',
      serverName: 'Mail',
      name: 'send_mail',
      description: 'Send an email message',
      inputSchema: {},
    },
  ];

  it('normalizes scores to 0..1 with the best hit at 1', () => {
    const results = searchTools(tools, 'quote price symbol', 5);
    expect(results.length).toBeGreaterThan(1);
    expect(results[0].score).toBe(1);
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
    // ranking order is preserved through normalization
    const raw = tools
      .map((t) => ({ name: t.name, score: scoreTool(t, 'quote price symbol') }))
      .filter((t) => t.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((t) => t.name);
    expect(results.map((r) => r.name)).toEqual(raw);
  });
});
