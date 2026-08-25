import type { ToolMeta } from './types.js';

const NAME_EXACT_WEIGHT = 12;
const NAME_WORD_WEIGHT = 6;
const DESC_WORD_WEIGHT = 2;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
}

/**
 * Lexical relevance score for a tool against a natural language query.
 *
 * Deliberately simple and dependency-free (BM25-style intuition):
 * exact tool-name hits dominate, name-word matches beat description
 * matches. This is the retrieval layer that keeps the LLM context small —
 * a semantic embedding index can be added later without changing this
 * interface.
 */
export function scoreTool(tool: ToolMeta, query: string): number {
  const q = query.trim().toLowerCase();

  if (!q) {
    return 0;
  }

  const nameLower = tool.name.toLowerCase();
  const descLower = tool.description.toLowerCase();
  const words = tokenize(q);

  let score = 0;

  if (nameLower === q) {
    score += NAME_EXACT_WEIGHT;
  }

  for (const word of words) {
    if (!word) {
      continue;
    }

    if (nameLower.includes(word)) {
      score += NAME_WORD_WEIGHT;
    }

    if (descLower.includes(word)) {
      score += DESC_WORD_WEIGHT;
    }
  }

  return score;
}

export interface SearchableTool extends ToolMeta {
  serverName: string;
}

/**
 * Rank tools for a query and return the top k.
 * Only tools with score > 0 are returned.
 */
export function searchTools(
  tools: SearchableTool[],
  query: string,
  limit: number,
): Array<SearchableTool & { score: number }> {
  return tools
    .map((tool) => ({ ...tool, score: scoreTool(tool, query) }))
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}
