import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { loadConfig, loadOrCreateSiteIdentity, normalizeSiteIdentifier } from "../dist/config.js";
import { JeeroDatabase } from "../dist/db.js";

test("normalizes Mother site identifiers", () => {
  assert.equal(normalizeSiteIdentifier("https://example.com/subsite/?ignored=yes"), "example.com/subsite");
  assert.equal(normalizeSiteIdentifier("example.com"), "example.com");
});

async function identityConfig(t, siteUrl) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "jeero-mcp-identity-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const previous = { ...process.env };
  try {
    process.env.JEERO_DATA_DIR = dataDir;
    if (siteUrl === undefined) delete process.env.JEERO_SITE_URL;
    else process.env.JEERO_SITE_URL = siteUrl;
    return loadConfig();
  } finally {
    for (const key of ["JEERO_DATA_DIR", "JEERO_SITE_URL"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("new installations persist distinct UUID identifiers across restarts", async (t) => {
  const firstConfig = await identityConfig(t);
  const secondConfig = await identityConfig(t);
  const first = loadOrCreateSiteIdentity(firstConfig);
  const second = loadOrCreateSiteIdentity(secondConfig);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(first.siteIdentifier, uuid);
  assert.match(second.siteIdentifier, uuid);
  assert.notEqual(first.siteIdentifier, second.siteIdentifier);
  assert.notEqual(first.siteKey, second.siteKey);
  assert.deepEqual(JSON.parse(await readFile(firstConfig.siteIdentityPath, "utf8")), first);
  assert.deepEqual(
    loadOrCreateSiteIdentity({ ...firstConfig, siteIdentifier: secondConfig.siteIdentifier }),
    first,
  );
});

test("existing installations retain their hostname, key and identity file", async (t) => {
  const config = await identityConfig(t, "different-override");
  const legacy = {
    siteKey: "existing-site-key",
    siteIdentifier: "existing-computer.local",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const content = JSON.stringify(legacy, null, 2);
  await writeFile(config.siteIdentityPath, content);
  assert.deepEqual(loadOrCreateSiteIdentity(config), legacy);
  assert.equal(await readFile(config.siteIdentityPath, "utf8"), content);
});

test("new installations still support an explicit site identifier override", async (t) => {
  const config = await identityConfig(t, "https://example.com/subsite/");
  assert.equal(loadOrCreateSiteIdentity(config).siteIdentifier, "example.com/subsite");
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
