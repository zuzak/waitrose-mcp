waitrose-mcp
============

MCP server exposing Waitrose product search. Deployed in the `claude-waitrose-mcp`
namespace of the home k3s cluster; see `claude-waitrose-mcp/` in
[zuzak/kube](https://github.com/zuzak/kube) for manifests.

## Tools

All tools work anonymously (the upstream client uses `customerId: "-1"` when
not logged in).

| Tool | Purpose |
|---|---|
| `search_products` | Free-text product search, with optional sort/pagination/filter-tag parameters |
| `browse_products` | Browse a category path (e.g. `groceries/bakery/bread`) |
| `get_products_by_line_numbers` | Look up specific products by their line number |
| `get_promotion_products` | List products on a given promotion |

## Auth extension point

The server supports optional login via `WAITROSE_USERNAME` and
`WAITROSE_PASSWORD` environment variables. When both are set, the server
calls `client.login()` at startup; when absent, it runs anonymously.

Authenticated-only tools (trolley management, orders, slots, etc) are not
implemented yet. When added, they should check `client.isAuthenticated()`
and return a clear "not authenticated" error when it is false.

## Local development

```
npm install
npm run build
PORT=8080 node build/index.js
```

## Endpoints

- `POST /mcp` — MCP streamable HTTP request channel
- `GET /mcp` — MCP SSE fallback channel (requires `Mcp-Session-Id` header)
- `GET /healthz` — liveness probe
- `GET /` — service info

## Credits

Vendors [jonastemplestein/waitrose](https://github.com/jonastemplestein/waitrose)
(MIT) as `src/waitrose.ts`. HTTP transport pattern adapted from
[saya6k/mcp-grocy-api](https://github.com/saya6k/mcp-grocy-api) (MIT).
