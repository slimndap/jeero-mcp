import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { normalizeSiteIdentifier } from "../dist/config.js";
import { JeeroDatabase } from "../dist/db.js";

test("normalizes Mother site identifiers", () => {
  assert.equal(normalizeSiteIdentifier("https://example.com/subsite/?ignored=yes"), "example.com/subsite");
  assert.equal(normalizeSiteIdentifier("example.com"), "example.com");
});

test("migrates a legacy database into the default subscription", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "jeero-mcp-"));
  const databasePath = path.join(dataDir, "jeero.sqlite");
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE subscription (
      mother_subscription_id TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO subscription VALUES ('mother-1', '{"theater":"stager"}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO sync_state VALUES ('last_inbox_check_at', '2026-01-01T00:00:00.000Z');
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      theater TEXT NOT NULL,
      ref TEXT NOT NULL,
      start TEXT NOT NULL,
      end TEXT,
      status TEXT,
      tickets_json TEXT,
      prices_json TEXT,
      venue_json TEXT,
      production_json TEXT NOT NULL,
      custom_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO events VALUES (1, 'stager', 'event-1', '2026-02-01 20:00', NULL, 'onsale', NULL, NULL, NULL, '{"ref":"show-1","title":"Show"}', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();

  const db = new JeeroDatabase(databasePath);
  assert.equal(db.getDefaultSubscription()?.motherSubscriptionId, "mother-1");
  assert.equal(db.getSyncState("default", "last_inbox_check_at"), "2026-01-01T00:00:00.000Z");
  assert.equal(db.getEvents({}).events[0]?.subscriptionKey, "default");
  db.close();

  await rm(dataDir, { recursive: true, force: true });
});
