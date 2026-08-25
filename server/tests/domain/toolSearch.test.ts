import { describe, it, expect } from 'vitest';

import { scoreTool } from '../../src/domain/toolSearch';

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
