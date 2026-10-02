import { describe, it, expect } from 'vitest';

import { searchTools, type SearchableTool } from '../../src/domain/toolSearch.js';

/**
 * Retrieval quality baseline for search_tools (lexical layer).
 *
 * This is the harness the decision-model reranker is measured against:
 * run the same fixture set through a decision model and compare
 * recall@k. Lexical matching is deliberately naive — the `hard` queries
 * below document the paraphrase gap that motivated decision mode.
 */

const TOOLS: SearchableTool[] = [
  { serverId: 's1', serverName: 'FS', name: 'file_read', description: 'Read a file from disk', inputSchema: {} },
  { serverId: 's1', serverName: 'FS', name: 'file_write', description: 'Write content to a file on disk', inputSchema: {} },
  { serverId: 's1', serverName: 'Web', name: 'http_fetch', description: 'Fetch a URL over HTTP and return the response body', inputSchema: {} },
  { serverId: 's1', serverName: 'Data', name: 'db_query', description: 'Run a SQL query against the Postgres database', inputSchema: {} },
  { serverId: 's1', serverName: 'Comms', name: 'email_send', description: 'Send an email via SMTP', inputSchema: {} },
  { serverId: 's1', serverName: 'Media', name: 'image_resize', description: 'Resize an image to given dimensions', inputSchema: {} },
  { serverId: 's1', serverName: 'Docs', name: 'pdf_extract_text', description: 'Extract text from a PDF document', inputSchema: {} },
  { serverId: 's1', serverName: 'Data', name: 'csv_to_json', description: 'Convert a CSV file to JSON', inputSchema: {} },
];

interface EvalCase {
  query: string;
  expected: string;
  /** True when lexical retrieval is known to miss (decision-model motivation). */
  hard?: boolean;
}

const CASES: EvalCase[] = [
  { query: 'read file', expected: 'file_read' },
  { query: 'write file contents', expected: 'file_write' },
  { query: 'download web page', expected: 'http_fetch', hard: true },
  { query: 'send mail', expected: 'email_send' },
  { query: 'run sql', expected: 'db_query' },
  { query: 'resize picture', expected: 'image_resize' },
  { query: 'shrink images', expected: 'image_resize', hard: true },
  { query: 'extract pdf text', expected: 'pdf_extract_text' },
  { query: 'convert csv json', expected: 'csv_to_json' },
  { query: 'fetch url', expected: 'http_fetch' },
];

const K = 5;

function recallAtK(cases: EvalCase[]): number {
  let hits = 0;
  for (const c of cases) {
    const results = searchTools(TOOLS, c.query, K);
    if (results.some((r) => r.name === c.expected)) {
      hits += 1;
    }
  }
  return hits / cases.length;
}

describe('tool search retrieval baseline (eval fixture)', () => {
  it('reports per-query hits and misses', () => {
    for (const c of CASES) {
      const results = searchTools(TOOLS, c.query, K);
      const hit = results.some((r) => r.name === c.expected);
      console.info(
        `[eval] ${hit ? 'HIT ' : 'MISS'}${c.hard ? ' (hard)' : '      '} `
        + `q="${c.query}" expected=${c.expected} got=[${results.map((r) => r.name).join(', ')}]`,
      );
    }
  });

  it('lexical baseline reaches the documented recall@5 floor', () => {
    const recall = recallAtK(CASES);
    console.info(`[eval] lexical recall@${K} = ${(recall * 100).toFixed(0)}%`);
    // The two hard (paraphrase) cases miss lexically; everything else must hit.
    expect(recall).toBeGreaterThanOrEqual(0.8);
  });

  it('hard paraphrase queries stay identifiable for decision mode', () => {
    const hard = CASES.filter((c) => c.hard);
    expect(hard.length).toBeGreaterThan(0);
    for (const c of hard) {
      const results = searchTools(TOOLS, c.query, K);
      console.info(
        `[eval] hard case "${c.query}" → [${results.map((r) => r.name).join(', ') || '∅'}] `
        + `(expected ${c.expected})`,
      );
    }
  });
});
