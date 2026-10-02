# Decision-model reranking

Lexical search is fast but misses paraphrases ("download web page" vs. a tool named `http_fetch`). Opt-in per request, `search_tools` hands its candidate pool to a **decision model** that reranks semantically — and may honestly report "no matching tool" instead of guessing.

```json
// tools/call search_tools
{ "query": "download web page", "k": 5, "mode": "decision" }
```

## Backends

Two backends through one provider-agnostic interface:

| Provider | Endpoint | Notes |
|---|---|---|
| `jev` | TypeSafe AI System One (`Choice` primitive with per-option probabilities + confidence) | Via OpenRouter (`https://openrouter.ai/api/v1`, model `typesafe/jev-1.13`) or first-party (`https://api.typesafe.ai`) |
| `openai-compatible` | Any chat-completions endpoint (OpenAI, Ollama, OmniRoute, …) | Temperature 0, JSON output, strictly validated against the candidate set |

::: tip OpenRouter quirk
OpenRouter serves Jev through its **Decisions API** (`POST /api/alpha/decisions`) — the first-party System One path 404s there. The Jev adapter maps OpenRouter base URLs automatically; just set the base URL to `https://openrouter.ai/api/v1`.
:::

## Guarantees

- **Reranker, never retriever** — lexical search builds the candidate pool (`decisionModel.candidatePool`, default 20); the model only re-orders it.
- **"None" is a first-class answer** — with `none` the response is empty plus a confidence score, so agents can rephrase instead of calling the wrong tool.
- **Fail-safe** — timeout, error, or invalid model output falls back to lexical results; the metadata block always reports `{used, provider, forced, fallback, latencyMs, …}`.
- **Injection-safe** — the model selects only from supplied candidate keys (re-validated server-side); tool descriptions are treated as untrusted data and the model never executes anything (`execute_tool` is unchanged).

## Setup

```bash
# .env — OpenRouter (key at https://openrouter.ai/settings/keys)
DECISION_MODEL_ENABLED=true
DECISION_MODEL_PROVIDER=jev
DECISION_MODEL_BASE_URL=https://openrouter.ai/api/v1
DECISION_MODEL_MODEL=typesafe/jev-1.13
DECISION_MODEL_API_KEY=<key>
DECISION_MODEL_TIMEOUT_MS=3000
DECISION_MODEL_CANDIDATE_POOL=20
```

The API key can also be stored at runtime in the UI's **Settings** view (`decisionModel.apiKey`): AES-256-GCM encrypted at rest, never returned in plaintext. Precedence: database value > environment variable > built-in default.

## Forcing reranking server-side

By default the LLM opts in per call via `mode="decision"`. Set `decisionModel.forceWhenConfigured=true` (`DECISION_MODEL_FORCE=true`) and every `search_tools` call — gateway and REST alike — is reranked once a model is configured. Forced responses carry `"forced": true` in the metadata. Note the cost implication: every search then pays model tokens + latency.

## Trying it in the UI

The **Tool Search** view has a Lexical / Decision Model toggle running the exact same retrieval path agents use — including provider, latency, and fallback reporting. Ideal for comparing lexical vs. reranked results on your own registry.
