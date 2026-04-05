import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { JeeroDatabase } from "./db.js";
import type { JeeroConfig } from "./config.js";
import { loadOrCreateSiteIdentity } from "./config.js";
import { MotherClient, type MotherInboxItem } from "./mother.js";
import type {
  EventsFilter,
  JeeroEvent,
  StoredSubscription,
  SubscriptionEnvelope,
  TicketSnapshotsFilter,
} from "./types.js";

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

const logsFilterSchema = z.object({
  theater: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

const ticketSnapshotsFilterSchema = z.object({
  date: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  theater: z.string().optional(),
  ref: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

export async function startServer(config: JeeroConfig): Promise<void> {
  const db = new JeeroDatabase(config.databasePath);
  const identity = loadOrCreateSiteIdentity(config);
  const mother = new MotherClient(config, identity.siteKey, identity.siteIdentifier);

  const app = new JeeroService(db, mother, identity.siteKey, identity.siteIdentifier);
  const backgroundSync = app.startBackgroundSync();

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

  server.registerTool(
    "get_logs",
    {
      description: "Return recently imported Jeero inbox log messages, optionally filtered by theater.",
      inputSchema: logsFilterSchema.shape,
    },
    async (input) => {
      const parsed = logsFilterSchema.parse(input);
      return toolResult(await app.getLogs(parsed));
    },
  );

  server.registerTool(
    "get_ticket_snapshots",
    {
      description:
        "Return daily historical ticket snapshots based on event ticket totals and availability.",
      inputSchema: ticketSnapshotsFilterSchema.shape,
    },
    async (input) => {
      const parsed = ticketSnapshotsFilterSchema.parse(input);
      return toolResult(await app.getTicketSnapshots(parsed));
    },
  );

  const transport = new StdioServerTransport();
  const closeDb = () => {
    backgroundSync.stop();
    db.close();
  };
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
  private backgroundSyncTimer: NodeJS.Timeout | null = null;
  private syncInFlight: Promise<boolean> | null = null;

  public constructor(
    private readonly db: JeeroDatabase,
    private readonly mother: MotherClient,
    private readonly siteKey: string,
    private readonly siteIdentifier: string,
  ) {}

  public startBackgroundSync(): { stop: () => void } {
    const run = async (): Promise<void> => {
      try {
        await this.syncInboxIfNeeded({ force: true, skipSubscriptionCreation: true });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`Background sync failed: ${message}\n`);
      }
    };

    this.backgroundSyncTimer = setInterval(() => {
      void run();
    }, 60_000);

    return {
      stop: () => {
        if (this.backgroundSyncTimer) {
          clearInterval(this.backgroundSyncTimer);
          this.backgroundSyncTimer = null;
        }
      },
    };
  }

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
    logs: Array<Record<string, unknown>>;
  }> {
    const refreshed = await this.syncInboxIfNeeded();

    const events = this.db.getEvents(filter).map((record) => ({
      theater: record.theater,
      updated_at: record.updatedAt,
      ...record.event,
    }));
    const logs = this.db.getRecentLogs(20, filter.theater).map((log) => ({
      inbox_id: log.inboxId,
      subscription_id: log.subscriptionId,
      theater: log.theater,
      action: log.action,
      message: log.message,
      updated_at: log.updatedAt,
    }));
    const lastInboxCheckAt = this.db.getSyncState("last_inbox_check_at");

    return {
      refreshed,
      lastInboxCheckAt,
      count: events.length,
      events,
      logs,
    };
  }

  public async getLogs(filter: {
    theater?: string;
    limit?: number;
  }): Promise<{
    count: number;
    logs: Array<Record<string, unknown>>;
  }> {
    const logs = this.db.getRecentLogs(filter.limit ?? 20, filter.theater).map((log) => ({
      inbox_id: log.inboxId,
      subscription_id: log.subscriptionId,
      theater: log.theater,
      action: log.action,
      message: log.message,
      updated_at: log.updatedAt,
    }));

    return {
      count: logs.length,
      logs,
    };
  }

  public async getTicketSnapshots(filter: TicketSnapshotsFilter): Promise<{
    count: number;
    snapshots: Array<Record<string, unknown>>;
  }> {
    const snapshots = this.db.getTicketSnapshots(filter).map((snapshot) => ({
      snapshot_date: snapshot.snapshotDate,
      theater: snapshot.theater,
      ref: snapshot.ref,
      start: snapshot.start,
      production_title: snapshot.productionTitle,
      total_tickets: snapshot.totalTickets,
      available_tickets: snapshot.availableTickets,
      sold_tickets: snapshot.soldTickets,
      updated_at: snapshot.updatedAt,
    }));

    return {
      count: snapshots.length,
      snapshots,
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

  private async syncInboxIfNeeded(options?: {
    force?: boolean;
    skipSubscriptionCreation?: boolean;
  }): Promise<boolean> {
    if (this.syncInFlight) {
      return this.syncInFlight;
    }

    const work = this.runSyncInboxIfNeeded(options);
    this.syncInFlight = work;

    try {
      return await work;
    } finally {
      this.syncInFlight = null;
    }
  }

  private async runSyncInboxIfNeeded(options?: {
    force?: boolean;
    skipSubscriptionCreation?: boolean;
  }): Promise<boolean> {
    const subscription = options?.skipSubscriptionCreation
      ? this.db.getSubscription()
      : await this.ensureSubscription();
    if (!subscription) {
      return false;
    }

    const lastCheck = this.db.getSyncState("last_inbox_check_at");
    const now = new Date();

    if (!options?.force && lastCheck) {
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
      if (this.processLogItem(item, subscription.motherSubscriptionId)) {
        processedIds.push(item.id);
        continue;
      }

      const processedEvent = this.processEventItem(item);
      if (processedEvent) {
        this.db.upsertEvent(processedEvent.theater, processedEvent.event);
        processedIds.push(item.id);
        continue;
      }

      if (item.id) {
        processedIds.push(item.id);
      }
    }

    if (processedIds.length > 0) {
      await this.mother.removeInboxItems(processedIds);
    }

    this.db.setSyncState("last_inbox_check_at", now.toISOString());
    return true;
  }

  private processEventItem(item: MotherInboxItem): { theater: string; event: JeeroEvent } | null {
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

  private processLogItem(item: MotherInboxItem, fallbackSubscriptionId: string): boolean {
    const isLogItem = item.item === "log" || item.action === "log";
    if (!isLogItem || !item.id) {
      return false;
    }

    const message = extractLogMessage(item.data);
    if (!message) {
      return false;
    }

    this.db.upsertLog({
      inboxId: item.id,
      subscriptionId: item.subscription_id ?? fallbackSubscriptionId,
      theater: typeof item.theater === "string" ? item.theater : "",
      action: typeof item.action === "string" ? item.action : "",
      message,
    });
    return true;
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
  if (item.item === "log" || item.action === "log") {
    return null;
  }

  if (item.event) {
    return item.event;
  }

  if (item.item === "event" && item.data && typeof item.data === "object") {
    return item.data;
  }

  if (item.payload && typeof item.payload === "object") {
    const payload = item.payload as Record<string, unknown>;
    return payload.event ?? payload;
  }

  return null;
}

function extractLogMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const message = (data as Record<string, unknown>).message;
  return typeof message === "string" && message.length > 0 ? message : null;
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
