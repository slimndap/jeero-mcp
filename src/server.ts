import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { JeeroDatabase } from "./db.js";
import type { JeeroConfig } from "./config.js";
import { loadOrCreateSiteIdentity } from "./config.js";
import { MotherClient, type MotherInboxItem } from "./mother.js";
import type { EventsFilter, JeeroEvent, StoredSubscription, SubscriptionEnvelope } from "./types.js";

const configSubscriptionSchema = z.object({
  settings: z.record(z.unknown()),
});

const eventsFilterSchema = z.object({
  date: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.string().optional(),
  theater: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

export async function startServer(config: JeeroConfig): Promise<void> {
  const db = new JeeroDatabase(config.databasePath);
  const identity = loadOrCreateSiteIdentity(config);
  const mother = new MotherClient(config, identity.siteKey, identity.siteIdentifier);

  const app = new JeeroService(db, mother, identity.siteKey, identity.siteIdentifier);

  const server = new McpServer({
    name: "jeero-agent-plugin",
    version: "0.1.0",
  });

  server.registerTool(
    "get_subscription",
    {
      description: "Return the local Jeero subscription, creating it on first use.",
      inputSchema: {},
    },
    async () => toolResult(await app.getSubscriptionEnvelope()),
  );

  server.registerTool(
    "config_subscription",
    {
      description: "Update local Jeero subscription settings and synchronize them to Mother.",
      inputSchema: configSubscriptionSchema.shape,
    },
    async (input) => {
      const parsed = configSubscriptionSchema.parse(input);
      return toolResult(await app.updateSubscription(parsed.settings));
    },
  );

  server.registerTool(
    "get_events",
    {
      description: "Return locally stored Jeero events, lazily syncing from Mother at most once per minute.",
      inputSchema: eventsFilterSchema.shape,
    },
    async (input) => {
      const parsed = eventsFilterSchema.parse(input);
      return toolResult(await app.getEvents(parsed));
    },
  );

  const transport = new StdioServerTransport();
  const closeDb = () => db.close();
  process.once("SIGINT", closeDb);
  process.once("SIGTERM", closeDb);
  await server.connect(transport);
}

function toolResult<T extends Record<string, unknown>>(payload: T): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: T;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

class JeeroService {
  public constructor(
    private readonly db: JeeroDatabase,
    private readonly mother: MotherClient,
    private readonly siteKey: string,
    private readonly siteIdentifier: string,
  ) {}

  public async getSubscriptionEnvelope(): Promise<SubscriptionEnvelope> {
    const subscription = await this.ensureSubscription();
    const upstream = await this.mother.getSubscription(
      subscription.motherSubscriptionId,
      subscription.settings,
    );

    const normalized = this.db.upsertSubscription({
      motherSubscriptionId: upstream.subscriptionId,
      settings: subscription.settings,
      siteKey: this.siteKey,
      siteIdentifier: this.siteIdentifier,
    });

    return {
      motherSubscriptionId: normalized.motherSubscriptionId,
      settings: normalized.settings,
      metadata: upstream.metadata,
      fields: upstream.fields,
      status: upstream.status,
    };
  }

  public async updateSubscription(
    settings: Record<string, unknown>,
  ): Promise<SubscriptionEnvelope> {
    const current = await this.ensureSubscription();
    const mergedSettings = {
      ...current.settings,
      ...settings,
    };

    const persisted = this.db.upsertSubscription({
      motherSubscriptionId: current.motherSubscriptionId,
      settings: mergedSettings,
      siteKey: this.siteKey,
      siteIdentifier: this.siteIdentifier,
    });

    await this.mother.updateSubscription(persisted.motherSubscriptionId, persisted.settings);
    const upstream = await this.mother.getSubscription(
      persisted.motherSubscriptionId,
      persisted.settings,
    );

    return {
      motherSubscriptionId: persisted.motherSubscriptionId,
      settings: persisted.settings,
      metadata: upstream.metadata,
      fields: upstream.fields,
      status: upstream.status,
    };
  }

  public async getEvents(filter: EventsFilter): Promise<{
    refreshed: boolean;
    lastInboxCheckAt: string | null;
    count: number;
    events: Array<Record<string, unknown>>;
  }> {
    const refreshed = await this.syncInboxIfNeeded();

    const events = this.db.getEvents(filter).map((record) => ({
      theater: record.theater,
      updated_at: record.updatedAt,
      ...record.event,
    }));
    const lastInboxCheckAt = this.db.getSyncState("last_inbox_check_at");

    return {
      refreshed,
      lastInboxCheckAt,
      count: events.length,
      events,
    };
  }

  private async ensureSubscription(): Promise<StoredSubscription> {
    const existing = this.db.getSubscription();
    if (existing) {
      return existing;
    }

    const created = await this.mother.createSubscription();
    return this.db.upsertSubscription({
      motherSubscriptionId: created.subscriptionId,
      settings: {},
      siteKey: this.siteKey,
      siteIdentifier: this.siteIdentifier,
    });
  }

  private async syncInboxIfNeeded(): Promise<boolean> {
    const subscription = await this.ensureSubscription();
    const lastCheck = this.db.getSyncState("last_inbox_check_at");
    const now = new Date();

    if (lastCheck) {
      const diff = now.getTime() - new Date(lastCheck).getTime();
      if (diff < 60_000) {
        return false;
      }
    }

    const inboxItems = await this.mother.getInbox(
      subscription.motherSubscriptionId,
      subscription.settings,
    );
    const processedIds: string[] = [];

    for (const item of inboxItems) {
      const processed = this.processInboxItem(item);
      if (!processed) {
        continue;
      }

      this.db.upsertEvent(processed.theater, processed.event);
      processedIds.push(item.id);
    }

    if (processedIds.length > 0) {
      await this.mother.removeInboxItems(processedIds);
    }

    this.db.setSyncState("last_inbox_check_at", now.toISOString());
    return true;
  }

  private processInboxItem(item: MotherInboxItem): { theater: string; event: JeeroEvent } | null {
    const candidate = extractEventLike(item);
    if (!candidate) {
      return null;
    }

    const event = validateEvent(candidate);
    if (!event) {
      return null;
    }

    const theater = inferTheater(item, event);
    if (!theater) {
      return null;
    }

    return { theater, event };
  }
}

function inferTheater(item: MotherInboxItem, event: JeeroEvent): string | null {
  const direct = typeof item.theater === "string" ? item.theater : null;
  const customTheater =
    typeof event.custom?.theater === "string" ? (event.custom.theater as string) : null;
  const venueTitle = typeof event.venue?.title === "string" ? event.venue.title : null;
  return direct ?? customTheater ?? venueTitle ?? null;
}

function extractEventLike(item: MotherInboxItem): unknown {
  if (item.event) {
    return item.event;
  }

  if (item.payload && typeof item.payload === "object") {
    const payload = item.payload as Record<string, unknown>;
    return payload.event ?? payload;
  }

  return null;
}

function validateEvent(value: unknown): JeeroEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const event = value as Record<string, unknown>;
  const production = event.production;
  if (
    typeof event.ref !== "string" ||
    typeof event.start !== "string" ||
    !production ||
    typeof production !== "object" ||
    typeof (production as Record<string, unknown>).ref !== "string" ||
    typeof (production as Record<string, unknown>).title !== "string"
  ) {
    return null;
  }

  return {
    ref: event.ref,
    start: event.start,
    end: typeof event.end === "string" ? event.end : undefined,
    tickets: isObject(event.tickets) ? (event.tickets as JeeroEvent["tickets"]) : undefined,
    prices: Array.isArray(event.prices) ? (event.prices as JeeroEvent["prices"]) : undefined,
    venue: isObject(event.venue) ? (event.venue as JeeroEvent["venue"]) : undefined,
    status: typeof event.status === "string" ? event.status : undefined,
    production: production as JeeroEvent["production"],
    custom: isObject(event.custom) ? (event.custom as Record<string, unknown>) : {},
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
