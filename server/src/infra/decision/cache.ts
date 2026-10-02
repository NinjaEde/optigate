import type {
  DecisionModel,
  DecisionRequest,
  DecisionResult,
} from '../../domain/toolDecision.js';

/**
 * TTL + LRU cache in front of a DecisionModel. Identical
 * (query, candidate set, limit) tuples within the TTL are served from
 * memory — repeated searches from chatty agents stay free.
 */
export function withDecisionCache(
  model: DecisionModel,
  options: { ttlMs?: number; max?: number } = {},
): DecisionModel {
  const ttlMs = options.ttlMs ?? 60_000;
  const max = options.max ?? 200;
  const cache = new Map<string, { at: number; value: DecisionResult }>();

  return {
    provider: model.provider,

    async select(request: DecisionRequest): Promise<DecisionResult> {
      const key =
        request.query
        + '\u0000'
        + request.candidates.map((c) => c.key).join('\u0001')
        + '\u0000'
        + request.limit;

      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttlMs) {
        // refresh recency (LRU)
        cache.delete(key);
        cache.set(key, hit);
        return hit.value;
      }

      const value = await model.select(request);
      cache.set(key, { at: Date.now(), value });
      if (cache.size > max) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          cache.delete(oldest);
        }
      }
      return value;
    },
  };
}
