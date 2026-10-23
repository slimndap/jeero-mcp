# Jeero MCP

Jeero MCP is a local [Model Context Protocol](https://modelcontextprotocol.io/) server for Jeero subscriptions and event data. It synchronizes with Mother and keeps its local event cache in SQLite; it does not require WordPress or a hosted MCP service.

## Install

Use Node.js 20 or later and configure your MCP client to run the published package:

```json
{
  "mcpServers": {
    "jeero": {
      "command": "npx",
      "args": ["-y", "jeero-mcp"]
    }
  }
}
```

The server communicates over stdio. Do not write application logs to stdout.

## First use

Create a subscription with `create_subscription`, then call `config_subscription` without settings. Jeero opens a private configuration flow using MCP URL elicitation when the client advertises support. Otherwise the tool returns a link and an access code. Open the link yourself, enter the code, choose your ticketing solution, and save to load its connector-specific fields. Enter keys only in that browser page. Keep the page private: do not ask your agent or its browser tools to inspect or fill it.

The screen runs on `127.0.0.1` on the same computer as the MCP server. Links expire after 15 minutes or when the server stops. If an app's URL prompt does not work, call `config_subscription` with `manual: true` to get a fresh link. This local screen requires a browser on the MCP server's computer; it is not a remotely hosted configuration portal.

Only `settings.theater` can still be supplied through `create_subscription` or `config_subscription`. Other settings, including all credentials, must be entered in the browser. Existing saved settings continue to work. This intentionally replaces the previous arbitrary settings input and raw subscription envelopes: `get_subscription` and `create_subscription` now return a summary with configured field names, required-field completeness, and a connection-error count. Completeness does not prove that a key is valid; check synchronization too. Raw Mother metadata, field values, and saved credentials are never returned by these tools.

One subscription can be the default; tools use it when `subscription` is omitted. Multiple active subscriptions are supported.

`get_events` synchronizes the selected subscriptions at most once a minute. While the server is running, active subscriptions are also checked every minute. Use `sync_subscription` or `sync_subscriptions` with `force: true` when an immediate refresh is needed.

## Tools

- Subscription management: `list_subscriptions`, `create_subscription`, `get_subscription`, `config_subscription`, `set_default_subscription`, `activate_subscription`, `deactivate_subscription`
- Synchronization: `sync_subscription`, `sync_subscriptions`
- Event data: `get_events`, `get_event`, `list_event_categories`, `get_ticket_snapshots`, `get_logs`

## Local data and configuration

By default Jeero MCP stores its SQLite cache and persistent site identity in `~/.jeero-mcp/`. Keep that directory private: the identity is used for Mother requests.

Credentials remain in the local SQLite settings and are sent to Mother using its existing API. This change keeps them out of MCP tool answers and errors; it does not encrypt the database or erase keys from old chat histories or existing debug files. Tool outputs and newly imported logs redact known credentials; request tracing omits query strings and response bodies. No third-party scripts or assets are loaded by the configuration screen.

New installations use a random UUID as their site identifier, saved in `site-identity.json` and reused on every restart. Existing installations keep their saved identifier and key so their Mother subscriptions and inbox remain accessible. Do not copy this identity file between independent installations.

| Variable | Purpose |
| --- | --- |
| `JEERO_DATA_DIR` | Override the local data directory. |
| `JEERO_SITE_URL` | Optional site identifier override for new installations; defaults to a random UUID. Existing saved identities take precedence. |
| `JEERO_MOTHER_BASE_URL` | Override Mother’s base URL, for example for staging. |
| `JEERO_NO_OF_ITEMS_PER_PICKUP` | Limit inbox items requested per sync. |
| `JEERO_LOG_MOTHER` | Enable Mother request tracing with `true`, `1`, `yes`, or `on`. |
| `JEERO_LOG_MOTHER_FILE` | Override the trace log path. |

Mother remains the upstream source of truth. Jeero MCP stores processed event records and synchronization state, not raw inbox payloads.

## Development

```sh
npm install
npm test
npm pack --dry-run
```

The tag-based publish workflow requires an explicit repository release approval before a version tag can publish.

## License

[MIT](LICENSE)
