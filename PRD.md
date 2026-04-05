# Jeero MCP PRD

## Goal

Build a local MCP server that reproduces the useful agent-facing behavior of the Jeero WordPress plugin without using WordPress as the local storage layer.

The MCP server will:

- run locally as a `stdio` MCP server
- be distributed as an npm package and launched with `npx`
- use the existing Jeero "Mother" AWS Lambda API as upstream
- store event data locally in its own database
- expose a minimal tool surface for AI agents

The MCP does **not** replace Mother. It replaces the local WordPress plugin role.

## Product Summary

The MCP server gives Claude, Codex, and similar MCP-capable agents a simple way to:

1. obtain or initialize the local Jeero subscription for this machine
2. configure that subscription using the field definitions returned by Mother
3. retrieve locally stored events, while lazily synchronizing new inbox items from Mother

This product is intentionally narrow. It avoids the WordPress admin UI, WordPress post creation, calendar integrations, and the broader Jeero operational backend.

## Scope

### In Scope

- local MCP server in Node.js and TypeScript
- npm distribution with `npx` launch
- exactly one Jeero subscription per MCP client machine
- local SQLite database
- local storage of:
  - subscription metadata
  - subscription settings
  - synchronized events
  - sync state
- calling existing Mother endpoints for:
  - create subscription
  - get subscription
  - update subscription
  - get inbox
  - remove inbox items
- processing inbox items into local event records
- filtering events in `get_events`
- throttled inbox refresh in `get_events` at max once per minute

### Out of Scope

- rewriting or porting the Python Mother/Lambda code
- replacing AWS Lambda, SNS, or DynamoDB
- storing raw inbox payloads locally
- storing inbox items locally
- supporting multiple subscriptions per machine
- WordPress post creation
- WordPress admin screens
- background daemon scheduling
- non-event content types

## Users

### Primary Users

- Claude Desktop users with MCP support
- Codex users with MCP support
- other local AI agent users who can run `npx`-based MCP servers

### User Need

Users want Jeero event data available to their AI agent without installing WordPress or relying on WordPress as the storage and processing layer.

## Core Product Principles

### 1. Minimal installation friction

The MCP should be usable through an npm package launched with `npx`, with no custom runtime besides Node.js.

### 2. Mother remains the source of truth for upstream import behavior

The MCP should use the existing Jeero API/Lambda infrastructure instead of copying Jeero backend logic locally.

### 3. Local DB stores only useful final data

The local database should store subscription state and processed events, not a persistent inbox or raw payload archive.

### 4. Agent-first workflow

The product should be optimized for tool use by agents, not for manual UI administration.

## Product Behavior

## Subscription Model

- The MCP maintains exactly one local subscription per machine.
- If no local subscription exists yet, `get_subscription` creates one through Mother and persists the returned subscription ID locally.
- Subscription settings are stored locally and also sent to Mother when needed.
- Mother remains responsible for returning the active field definitions and subscription metadata.

## Sync Model

- `get_events` is the only public sync trigger in v1.
- On each `get_events` call, the MCP checks the last inbox synchronization timestamp.
- If the last check was less than 60 seconds ago, the MCP skips refresh and returns local DB results.
- If the last check was 60 seconds ago or more, the MCP:
  - requests inbox items from Mother
  - processes those items immediately in memory
  - upserts resulting events into SQLite
  - removes successfully processed inbox items from Mother
  - updates local sync state
  - returns the resulting filtered event set

This is a lazy sync model, not a continuous scheduler.

## Public Tools

## 1. `get_subscription`

### Purpose

Return the single local subscription for this machine. If it does not exist yet, create it first.

### Behavior

- Load local subscription record.
- If missing:
  - call Mother `subscribe`
  - persist local subscription ID
- call Mother `get subscription` using current local settings
- return:
  - subscription metadata
  - current settings
  - field definitions
  - status data such as `inactive`, `interval`, `next_delivery`, `limit`, `theater`

### Notes

This is the MCP equivalent of the WordPress plugin's "load subscription from DB, then enrich from Mother" flow.

## 2. `config_subscription`

### Purpose

Update the local subscription settings based on user or agent input, using the field definitions provided by Mother.

### Behavior

- Accept settings payload.
- Persist settings locally.
- call Mother `update subscription`
- call Mother `get subscription` to retrieve fresh state and fields
- return:
  - updated settings
  - refreshed field definitions
  - status data

### Notes

The MCP should treat Mother as the authoritative source for field behavior and validation feedback.

## 3. `get_events`

### Purpose

Return stored events with optional filtering, while ensuring the local store is reasonably fresh.

### Behavior

- Check local sync state.
- If inbox was not checked in the last minute:
  - call Mother `get inbox`
  - process received items in memory
  - upsert event rows into SQLite
  - remove successfully processed inbox items from Mother
  - update local `last_inbox_check_at`
- Query the local event table using provided filters.
- Return events in the Jeero/Mother event structure.

### Filtering

Initial filtering should support:

- date or date range
- status
- theater
- free-text query on title and description
- optional limit

## Upstream Dependencies

The MCP will call the existing Jeero Mother API, equivalent to the endpoints used in the WordPress plugin.

Expected upstream capabilities:

- create subscription
- fetch subscription
- update subscription
- fetch inbox items
- remove inbox items

The MCP should preserve the request semantics already used by the plugin wherever practical, including use of local site identity values if required by Mother.

### Required Mother Endpoints

Derived from the WordPress plugin's Mother client and the corresponding Lambda handlers, the MCP only needs these endpoints for v1:

- `POST /v1/subscriptions`
- `GET /v1/subscriptions/{subscription_id}`
- `POST /v1/subscriptions/{subscription_id}`
- `POST /v1/inbox/big`
- `DELETE /v1/inbox`

These are the direct equivalents of:

- `subscribe_me()` in [Mother.php](/Users/jeroen/Sites/jeero-plugin/app/public/wp-content/plugins/jeero/includes/Mother/Mother.php#L289)
- `get_subscription()` in [Mother.php](/Users/jeroen/Sites/jeero-plugin/app/public/wp-content/plugins/jeero/includes/Mother/Mother.php#L257)
- `update_subscription()` in [Mother.php](/Users/jeroen/Sites/jeero-plugin/app/public/wp-content/plugins/jeero/includes/Mother/Mother.php#L307)
- `get_inbox()` in [Mother.php](/Users/jeroen/Sites/jeero-plugin/app/public/wp-content/plugins/jeero/includes/Mother/Mother.php#L173)
- `remove_inbox_items()` in [Mother.php](/Users/jeroen/Sites/jeero-plugin/app/public/wp-content/plugins/jeero/includes/Mother/Mother.php#L228)

### Required Headers

The Mother authorizer requires these headers to be present:

- `site_key`
- `site_url`

This is enforced in [jeero-authorizer.py](/Users/jeroen/Dev/jeero-mother/functions/jeero-authorizer.py#L3).

For inbox polling, one additional optional header is supported:

- `no_of_items_per_pickup`

This is consumed in [jeero-inbox.py](/Users/jeroen/Dev/jeero-mother/functions/jeero-inbox.py#L17).

### Required Request Shapes

#### `POST /v1/subscriptions`

- headers:
  - `site_key`
  - `site_url`
- body:
  - none required

Mother stores the new subscription using the provided `site_key` and sanitized `site_url`, as shown in [jeero-subscription-add.py](/Users/jeroen/Dev/jeero-mother/functions/jeero-subscription-add.py#L7).

#### `GET /v1/subscriptions/{subscription_id}`

- headers:
  - `site_key`
  - `site_url`
- query parameters:
  - `settings`: URL-encoded JSON object

The plugin injects timezone into this settings payload before calling Mother.

#### `POST /v1/subscriptions/{subscription_id}`

- headers:
  - `site_key`
  - `site_url`
- JSON body:
  - `{ "settings": { ... } }`

This matches [jeero-subscription-update.py](/Users/jeroen/Dev/jeero-mother/functions/jeero-subscription-update.py#L8).

#### `POST /v1/inbox/big`

- headers:
  - `site_key`
  - `site_url`
  - optional `no_of_items_per_pickup`
- JSON body:
  - local settings object keyed by subscription or equivalent subscription settings payload

For this MCP, with one subscription per machine, the payload can be shaped specifically for the one local subscription as long as it remains compatible with Mother expectations.

#### `DELETE /v1/inbox`

- headers:
  - `site_key`
  - `site_url`
- query parameters:
  - `inbox_id`: JSON-encoded array of inbox item IDs

This matches [jeero-inbox-remove.py](/Users/jeroen/Dev/jeero-mother/functions/jeero-inbox-remove.py#L8).

### Site URL Format

Mother expects a normalized site identifier, not necessarily a full URL with scheme.

The normalization logic is defined in [helpers.py](/Users/jeroen/Dev/jeero-mother/functions/jeero/helpers.py#L23):

- if no scheme is present, prepend `http://`
- parse the URL
- store only `netloc + path`
- discard scheme, query string, and fragment

Examples:

- `example.com` -> `example.com`
- `https://example.com` -> `example.com`
- `https://example.com/subsite` -> `example.com/subsite`

The MCP should emulate this behavior exactly when generating or persisting its local `site_url` identity value.

### Site Key Behavior

The plugin generates a persistent local `site_key` once and reuses it for all calls, as shown in [Mother.php](/Users/jeroen/Sites/jeero-plugin/app/public/wp-content/plugins/jeero/includes/Mother/Mother.php#L121).

The MCP should do the same:

- generate once on first run
- store locally
- reuse for all Mother requests

### Validation Reality

The current Mother validator in [security.py](/Users/jeroen/Dev/jeero-mother/functions/jeero/security.py#L1) returns `True` unconditionally, so current authorization effectively checks only for the presence of `site_key` and `site_url`.

Even so, the MCP should still treat both values as stable persistent identity values, because they are used in subscription creation, inbox lookup, and site-level grouping.

## Data Model

The local data model should follow the **actual Mother event structure**, not a WordPress-derived schema.

### Canonical Event Shape

```json
{
  "ref": "source-event-ref",
  "start": "2026-04-05 20:00",
  "end": "2026-04-05 22:00",
  "tickets": {
    "url": "https://example.com/tickets",
    "total": 100,
    "available": 34
  },
  "prices": [
    {
      "title": "Regular",
      "amount": "12.50"
    }
  ],
  "venue": {
    "title": "Main Hall",
    "city": "Rotterdam"
  },
  "status": "onsale",
  "production": {
    "ref": "source-production-ref",
    "title": "Example Show",
    "description": "Long description",
    "img": "https://example.com/image.jpg",
    "categories": ["Film"]
  },
  "custom": {}
}
```

### Important Decisions

- `tickets` is canonical
- `tickets_url` is not stored
- `prices` remains an array of structured objects
- `production`, `venue`, `prices`, `tickets`, and `custom` should remain close to Mother shape
- inbox items are **not** stored locally
- raw inbox payloads are **not** stored locally

### SQLite Tables

#### `subscription`

Exactly one row.

Suggested fields:

- `id`
- `mother_subscription_id`
- `settings_json`
- `site_key`
- `site_identifier`
- `created_at`
- `updated_at`

#### `events`

Suggested fields:

- `id`
- `theater`
- `ref`
- `start`
- `end`
- `status`
- `tickets_json`
- `prices_json`
- `venue_json`
- `production_json`
- `custom_json`
- `created_at`
- `updated_at`

Suggested uniqueness:

- unique key on `theater + ref`

#### `sync_state`

Suggested fields:

- `key`
- `value`

Expected keys:

- `last_inbox_check_at`

## Processing Rules

### Inbox Processing

- inbox items are fetched from Mother
- inbox items are processed in memory
- only successful event results are persisted
- successfully processed inbox item IDs are removed upstream
- failed items are not removed upstream

### Event Upsert

- event uniqueness is based on `theater + ref`
- if an existing event is found, update it
- otherwise insert a new event
- `updated_at` should always reflect the latest successful processing time

### Event Retention

- deleted or expired events are not actively pruned from the local database
- the local store acts as a growing historical cache unless a future explicit cleanup feature is introduced

## Local Identity

The MCP is machine-scoped, not workspace-scoped.

There is only one subscription per MCP client machine.

Any local identity values required for Mother should be generated and persisted once, then reused. The equivalent of the plugin's `site_key` behavior should exist locally.

## Technical Stack

- Node.js
- TypeScript
- stdio MCP server
- npm package
- launched with `npx`
- SQLite for storage
- HTTP client for Jeero API communication

## Installation Experience

Target UX for users:

- install nothing except Node.js
- configure Claude or another MCP host with an `npx` command
- first `get_subscription` call initializes local state automatically

## Success Criteria

The product is successful when:

- a Claude user can add the server with an `npx` command
- the server can initialize a Jeero subscription on first use
- the user can configure the subscription via MCP tools
- `get_events` returns up-to-date locally stored events
- event data matches the Mother structure closely enough that existing Jeero assumptions still hold

## Risks

### 1. Mother coupling

The MCP depends on current Mother endpoint behavior and payload shape.

### 2. Local identity expectations

If Mother strongly assumes WordPress-specific site identity behavior, the MCP will need a compatible local replacement.

### 3. Lazy sync only

Because sync only happens during `get_events`, event freshness depends on user or agent reads.

## Open Questions

- Should `get_events` return the raw Mother-like structure only, or also include local metadata such as `updated_at`?
