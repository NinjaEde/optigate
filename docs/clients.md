# Connecting MCP clients

Register OptiGate once in any MCP client:

```json
{
  "mcpServers": {
    "optigate": {
      "type": "http",
      "url": "http://localhost:8100/mcp",
      "headers": { "x-dev-user": "alice" }
    }
  }
}
```

That's it — `search_tools` and `execute_tool` now give the client access to every visible registry server.

## Machine clients (agents, CI)

For clients without Keycloak, admins can issue **gateway API keys** (`POST /api/api-keys`, or the UI's API-Keys view). Keys are gateway-only (`/mcp`, never `/api`), bound to a user/role/tenant, and shown in plaintext exactly once:

```json
{
  "mcpServers": {
    "optigate": {
      "type": "http",
      "url": "http://localhost:8100/mcp",
      "headers": { "x-api-key": "og_..." }
    }
  }
}
```

## Using decision mode from a client

Pass `mode: "decision"` to opt into semantic reranking per call (requires a configured decision model, see [decision-model reranking](./decision-model.md)):

```json
{ "query": "download web page", "k": 5, "mode": "decision" }
```

The second content block always reports what happened (`used`, `provider`, `forced`, `fallback`, `latencyMs`) — so agents can adapt, e.g. rephrase the query when the model reports no matching tool.
