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

Create a subscription with `create_subscription`, then use `config_subscription` to send its Jeero settings to Mother. One subscription can be the default; tools use it when `subscription` is omitted. Multiple active subscriptions are supported.

`get_events` synchronizes the selected subscriptions at most once a minute. While the server is running, active subscriptions are also checked every minute. Use `sync_subscription` or `sync_subscriptions` with `force: true` when an immediate refresh is needed.

## Tools

- Subscription management: `list_subscriptions`, `create_subscription`, `get_subscription`, `config_subscription`, `set_default_subscription`, `activate_subscription`, `deactivate_subscription`
- Synchronization: `sync_subscription`, `sync_subscriptions`
- Event data: `get_events`, `get_event`, `list_event_categories`, `get_ticket_snapshots`, `get_logs`

## Local data and configuration

By default Jeero MCP stores its SQLite cache and persistent site identity in `~/.jeero-mcp/`. Keep that directory private: the identity is used for Mother requests.

| Variable | Purpose |
| --- | --- |
| `JEERO_DATA_DIR` | Override the local data directory. |
| `JEERO_SITE_URL` | Stable local site identifier; defaults to the machine hostname. |
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
