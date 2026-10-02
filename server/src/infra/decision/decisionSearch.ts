import {
  DecisionOutputError,
  candidateKey,
  toDecisionCandidates,
  type DecisionModel,
} from '../../domain/toolDecision.js';
import type { ToolMeta } from '../../domain/types.js';

/** Retrieval result with the winning score (plus the lexical score when reranked). */
export type ScoredTool = ToolMeta & {
  serverName: string;
  score: number;
  lexicalScore?: number;
};

export type DecisionFallback =
  | 'disabled'
  | 'no_candidates'
  | 'error'
  | 'invalid_output';

/** Machine-readable account of what happened (second content block / REST field). */
export interface DecisionMeta {
  used: boolean;
  provider?: string;
  none?: boolean;
  confidence?: number;
  fallback: DecisionFallback | null;
  latencyMs?: number;
  error?: string;
  /** True when reranking was applied although lexical mode was requested. */
  forced?: boolean;
}

export type LexicalSearchFn = (
  tools: Array<ToolMeta & { serverName: string }>,
  query: string,
  limit: number,
) =>
  | Array<ToolMeta & { serverName: string; score: number }>
  | Promise<Array<ToolMeta & { serverName: string; score: number }>>;

export type ResolveDecisionFn = () => Promise<{
  model: DecisionModel;
  candidatePool: number;
} | null>;

/**
 * Shared two-stage search behind both `search_tools` (MCP gateway) and
 * `POST /api/tools/search` (REST / Tool-Suche view):
 *
 * 1. lexical retrieval builds a candidate pool,
 * 2. the decision model reranks it — or reports "no match".
 *
 * Any model failure falls back to plain lexical results, flagged in
 * `meta.fallback`. Unknown model keys are dropped (candidate keys are
 * the only trustworthy identifiers); unranked remainder slots keep
 * lexical order.
 */
export async function searchWithDecision(
  index: Array<ToolMeta & { serverName: string }>,
  query: string,
  limit: number,
  searchLexical: LexicalSearchFn,
  resolveDecision: ResolveDecisionFn | undefined,
): Promise<{ tools: ScoredTool[]; meta: DecisionMeta }> {
  const decision = resolveDecision ? await resolveDecision() : null;

  if (!decision) {
    const tools = await searchLexical(index, query, limit);
    return { tools, meta: { used: false, fallback: 'disabled' } };
  }

  const retrieval = await searchLexical(index, query, decision.candidatePool);

  if (retrieval.length === 0) {
    return { tools: [], meta: { used: false, fallback: 'no_candidates' } };
  }

  const startedAt = Date.now();
  try {
    const result = await decision.model.select({
      query,
      candidates: toDecisionCandidates(retrieval),
      limit,
    });
    const latencyMs = Date.now() - startedAt;

    if (result.outcome.kind === 'none') {
      return {
        tools: [],
        meta: {
          used: true,
          provider: decision.model.provider,
          none: true,
          confidence: result.outcome.confidence,
          fallback: null,
          latencyMs,
        },
      };
    }

    const byKey = new Map(
      retrieval.map((r) => [candidateKey(r.serverId, r.name), r]),
    );
    const seen = new Set<string>();
    const ranked: ScoredTool[] = [];

    for (const { key, score } of result.outcome.scores) {
      const tool = byKey.get(key);
      if (!tool || seen.has(key)) {
        continue;
      }
      seen.add(key);
      ranked.push({ ...tool, score, lexicalScore: tool.score });
    }
    for (const tool of retrieval) {
      const key = candidateKey(tool.serverId, tool.name);
      if (!seen.has(key)) {
        seen.add(key);
        // remainder slot: score stays the lexical score, so no
        // redundant lexicalScore field is emitted
        ranked.push({ ...tool });
      }
    }

    return {
      tools: ranked.slice(0, limit),
      meta: {
        used: true,
        provider: decision.model.provider,
        none: false,
        fallback: null,
        latencyMs,
      },
    };
  } catch (err) {
    return {
      tools: retrieval.slice(0, limit),
      meta: {
        used: false,
        provider: decision.model.provider,
        fallback: err instanceof DecisionOutputError ? 'invalid_output' : 'error',
        error: (err as Error).message,
      },
    };
  }
}
