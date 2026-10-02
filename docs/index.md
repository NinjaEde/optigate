---
layout: home

hero:
  name: OptiGate
  text: Self-hosted MCP gateway with token-sparing tool retrieval
  tagline: One endpoint for all your MCP servers. Clients retrieve only the LLM tools they actually need — optionally reranked by a decision model.
  image:
    src: /screenshot.png
    alt: OptiGate admin UI with server cards and tool search
  actions:
    - theme: brand
      text: Get started
      link: /installation
    - theme: alt
      text: Decision-model reranking
      link: /decision-model
    - theme: alt
      text: GitHub
      link: https://github.com/NinjaEde/optigate

features:
  - title: Token-sparing retrieval
    details: search_tools returns the top-k relevant tool cards per query (~200–800 tokens regardless of registry size). LLM context usage stays flat whether you manage 20 or 2,000 tools.
  - title: Decision-model reranking
    details: Optional mode="decision" hands the candidate pool to a decision model (Jev via OpenRouter, or any OpenAI-compatible endpoint) — semantic reranking with honest "no matching tool" answers.
  - title: MCP facade
    details: The registry itself is an MCP server. Any MCP client (Claude, ChatGPT, Hermes, coding agents) gets every managed server through a single Streamable HTTP endpoint.
  - title: Governance built in
    details: Scopes (global / tenant / private), approval workflow, full audit trail, per-tenant credential isolation, SSRF protection, rate limiting.
  - title: Flexible auth
    details: Keycloak JWT in production, local username/password login for homelabs, dev mode for local testing.
  - title: Self-hosted & MIT
    details: Docker Compose stack, Postgres persistence, admin UI in DE/EN/FR. Your tool traffic and credentials never leave your infrastructure.
---

## What is OptiGate?

OptiGate is a **self-hosted MCP (Model Context Protocol) gateway and server registry**. Without a gateway, every AI agent needs every MCP server registered individually — and every tool schema lands in the LLM context, exploding token costs. OptiGate flips this around:

```
MCP Client ──▶ POST /mcp ──▶ OptiGate ──▶ managed MCP servers (HTTP/SSE/stdio)
                  search_tools + execute_tool only
```

1. The agent calls `search_tools(query, k)` and gets the k most relevant **tool cards**.
2. It executes one via `execute_tool(server_id, tool_name, args)` — scope-checked, args-validated, audited.

Head to [installation](./installation.md) to run it in five minutes, or read how [decision-model reranking](./decision-model.md) closes the paraphrase gap of keyword search.
