import type { SearchableTool } from './toolSearch.js';

/**
 * Decision-model layer for tool selection: a reranker that sits ON TOP of
 * lexical retrieval (toolSearch.ts), never in front of it. Retrieval stays
 * dependency-free and instant; the decision model only re-orders a small
 * candidate pool and may declare "no tool matches".
 *
 * The interface is provider-agnostic (Jev, OpenAI-compatible endpoints, …)
 * so the backend can be swapped without touching the gateway.
 */

/** Option id the model may choose when no candidate fits the query. */
export const NONE_OPTION = '__none__';

/** Stable candidate id across retrieval and decision layers. */
export function candidateKey(serverId: string, toolName: string): string {
  return `${serverId}::${toolName}`;
}

/** A single retrieval candidate handed to the decision model. */
export interface DecisionCandidate {
  key: string;
  name: string;
  serverName: string;
  description: string;
}

export interface DecisionRequest {
  query: string;
  candidates: DecisionCandidate[];
  /** Final top-k the caller wants (adapters may ignore; gateway slices). */
  limit: number;
}

export type DecisionOutcome =
  | {
      kind: 'ranking';
      /** Candidate keys ordered best-first with a 0..1 relevance score. */
      scores: Array<{ key: string; score: number }>;
    }
  | { kind: 'none'; confidence: number };

export interface DecisionResult {
  outcome: DecisionOutcome;
}

export interface DecisionModel {
  readonly provider: string;
  select(request: DecisionRequest): Promise<DecisionResult>;
}

/** Shared adapter configuration (provider endpoints, credentials, limits). */
export interface DecisionModelConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

/** Thrown when the model answered but the output is structurally invalid. */
export class DecisionOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionOutputError';
  }
}

/** Builds candidates from lexical retrieval results. */
export function toDecisionCandidates(
  tools: Array<SearchableTool & { score: number }>,
  maxDescription = 300,
): DecisionCandidate[] {
  return tools.map((tool) => ({
    key: candidateKey(tool.serverId, tool.name),
    name: tool.name,
    serverName: tool.serverName,
    description: tool.description.slice(0, maxDescription),
  }));
}

/**
 * Validates and normalizes a ranking payload. Unknown keys are dropped,
 * duplicates keep their first (best) occurrence, results are sorted
 * best-first. Scores are clamped to 0..1. Non-object entries are
 * skipped defensively.
 */
export function normalizeRanking(
  raw: unknown[],
  validKeys: ReadonlySet<string>,
): Array<{ key: string; score: number }> {
  const seen = new Set<string>();
  const scores: Array<{ key: string; score: number }> = [];

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const key = (entry as { key?: unknown }).key;
    if (typeof key !== 'string' || !validKeys.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const score = (entry as { score?: unknown }).score;
    scores.push({
      key,
      score:
        typeof score === 'number' && Number.isFinite(score)
          ? Math.min(1, Math.max(0, score))
          : 0,
    });
  }

  scores.sort((a, b) => b.score - a.score);
  return scores;
}

/**
 * Validates a decision-model payload of the shape
 * `{"none": boolean, "ranking": [{"key": string, "score": number}]}`.
 *
 * - `none: true`          → outcome "none" (confidence = 1 − best score,
 *   i.e. how certain the model is that nothing fits).
 * - `none: false/absent`  → outcome "ranking"; unknown or duplicate keys
 *   are dropped (candidate keys are the only trustworthy identifiers).
 * - Structurally broken payloads raise DecisionOutputError.
 */
export function parseDecisionPayload(
  parsed: unknown,
  candidates: DecisionCandidate[],
): DecisionResult {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new DecisionOutputError('decision payload is not an object');
  }

  const { none, ranking } = parsed as {
    none?: unknown;
    ranking?: unknown;
  };

  const validKeys = new Set(candidates.map((c) => c.key));

  if (ranking !== undefined && !Array.isArray(ranking)) {
    throw new DecisionOutputError('decision ranking is not an array');
  }

  const raw = Array.isArray(ranking) ? ranking : [];

  const scores = normalizeRanking(raw, validKeys);

  if (none === true) {
    const best = scores[0]?.score ?? 0;
    return { outcome: { kind: 'none', confidence: 1 - best } };
  }

  if (scores.length === 0) {
    throw new DecisionOutputError('decision ranking is empty');
  }

  return { outcome: { kind: 'ranking', scores } };
}
