import { McpServer } from "@modelcontextprotocol/server";
import fs from "node:fs";
import { z } from "zod";

import { JeeroDatabase } from "./db.js";
import type { JeeroConfig } from "./config.js";
import { loadOrCreateSiteIdentity } from "./config.js";
import {
  MotherClient,
  type MotherInboxItem,
  type MotherInboxRequest,
} from "./mother.js";
import type {
  EventsFilter,
  JeeroEvent,
  StoredSubscription,
  SubscriptionEnvelope,
  TicketSnapshotsFilter,
} from "./types.js";

const subscriptionSelectorSchema = z.object({
  subscription: z.string().min(1).optional(),
});

const createSubscriptionSchema = z.object({
  subscription_key: z.string().min(1),
  label: z.string().min(1),
  settings: z.record(z.string(), z.json()).optional(),
  is_default: z.boolean().optional(),
});

const getSubscriptionsSchema = z.object({
  theater: z.string().optional(),
  active_only: z.boolean().optional(),
});

const configSubscriptionSchema = z.object({
  subscription: z.string().min(1).optional(),
  settings: z.record(z.string(), z.json()),
});

const eventsFilterSchema = z.object({
  subscription: z.string().min(1).optional(),
  date: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.string().optional(),
  theater: z.string().optional(),
  category: z.string().min(1).optional(),
  query: z.string().optional(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

const eventLookupSchema = z.object({
  subscription: z.string().min(1).optional(),
  ref: z.string().min(1),
});

const logsFilterSchema = z.object({
  subscription: z.string().min(1).optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

const ticketSnapshotsFilterSchema = z.object({
  subscription: z.string().min(1).optional(),
  date: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  ref: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

const eventCategoriesFilterSchema = z.object({
  subscription: z.string().min(1).optional(),
  theater: z.string().optional(),
  date: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  query: z.string().optional(),
});

const syncSubscriptionSchema = z.object({
  subscription: z.string().min(1),
  force: z.boolean().optional(),
});

const syncSubscriptionsSchema = z.object({
  theater: z.string().optional(),
  force: z.boolean().optional(),
});

export function createServer(config: JeeroConfig): McpServer {
  const db = new JeeroDatabase(config.databasePath);
  const identity = loadOrCreateSiteIdentity(config);
  const mother = new MotherClient(config, identity.siteKey, identity.siteIdentifier);

  const activityLogger = config.motherTraceEnabled
    ? new ActivityTraceLogger(config.motherTracePath)
    : null;
  const app = new JeeroService(db, mother, activityLogger);
  const backgroundSync = app.startBackgroundSync();

  const server = new McpServer({
    name: "jeero-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "list_subscriptions",
    {
      description: "Return all locally configured Jeero subscriptions, optionally filtered by theater.",
      inputSchema: getSubscriptionsSchema.shape,
    },
    async (input) => {
      const parsed = getSubscriptionsSchema.parse(input);
      return toolResult(
        await app.listSubscriptions({
          theater: parsed.theater,
          activeOnly: parsed.active_only,
        }),
      );
    },
  );

  server.registerTool(
    "create_subscription",
    {
      description:
        "Create a new local Jeero subscription and return Mother’s configuration fields. Set settings.theater with config_subscription; its response contains the connector-specific fields.",
      inputSchema: createSubscriptionSchema.shape,
    },
    async (input) => {
      const parsed = createSubscriptionSchema.parse(input);
      return toolResult(
        await app.createSubscription({
          subscriptionKey: parsed.subscription_key,
          label: parsed.label,
          settings: parsed.settings ?? {},
          isDefault: parsed.is_default,
        }),
      );
    },
  );

  server.registerTool(
    "get_subscription",
    {
      description:
        "Return a local Jeero subscription by key, or the default subscription when omitted.",
      inputSchema: subscriptionSelectorSchema.shape,
    },
    async (input) => {
      const parsed = subscriptionSelectorSchema.parse(input);
      return toolResult(await app.getSubscriptionEnvelope(parsed.subscription));
    },
  );

  server.registerTool(
    "config_subscription",
    {
      description: "Update local Jeero subscription settings and synchronize them to Mother.",
      inputSchema: configSubscriptionSchema.shape,
    },
    async (input) => {
      const parsed = configSubscriptionSchema.parse(input);
      return toolResult(await app.updateSubscription(parsed.subscription, parsed.settings));
    },
  );

  server.registerTool(
    "set_default_subscription",
    {
      description: "Set the default local Jeero subscription used by tools when no key is provided.",
      inputSchema: z.object({ subscription: z.string().min(1) }).shape,
    },
    async (input) => {
      const parsed = z.object({ subscription: z.string().min(1) }).parse(input);
      return toolResult(await app.setDefaultSubscription(parsed.subscription));
    },
  );

  server.registerTool(
    "activate_subscription",
    {
      description: "Activate a local Jeero subscription so it participates in sync again.",
      inputSchema: z.object({ subscription: z.string().min(1) }).shape,
    },
    async (input) => {
      const parsed = z.object({ subscription: z.string().min(1) }).parse(input);
      return toolResult(await app.activateSubscription(parsed.subscription));
    },
  );

  server.registerTool(
    "deactivate_subscription",
    {
      description: "Deactivate a local Jeero subscription without deleting its stored data.",
      inputSchema: z.object({ subscription: z.string().min(1) }).shape,
    },
    async (input) => {
      const parsed = z.object({ subscription: z.string().min(1) }).parse(input);
      return toolResult(await app.deactivateSubscription(parsed.subscription));
    },
  );

  server.registerTool(
    "sync_subscription",
    {
      description: "Synchronize one local Jeero subscription from Mother.",
      inputSchema: syncSubscriptionSchema.shape,
    },
    async (input) => {
      const parsed = syncSubscriptionSchema.parse(input);
      return toolResult(await app.syncSubscription(parsed.subscription, parsed.force ?? false));
    },
  );

  server.registerTool(
    "sync_subscriptions",
    {
      description: "Synchronize all active local Jeero subscriptions, optionally filtered by theater.",
      inputSchema: syncSubscriptionsSchema.shape,
    },
    async (input) => {
      const parsed = syncSubscriptionsSchema.parse(input);
      return toolResult(
        await app.syncSubscriptions({
          theater: parsed.theater,
          force: parsed.force ?? false,
        }),
      );
    },
  );

  server.registerTool(
    "get_events",
    {
      description:
        "Return paginated locally stored Jeero events, syncing the relevant subscriptions from Mother at most once per minute.",
      inputSchema: eventsFilterSchema.shape,
    },
    async (input) => {
      const parsed = eventsFilterSchema.parse(input);
      return toolResult(await app.getEvents(parsed));
    },
  );

  server.registerTool(
    "get_event",
    {
      description:
        "Return the full locally stored Jeero event details for a single event identified by ref and optional subscription.",
      inputSchema: eventLookupSchema.shape,
    },
    async (input) => {
      const parsed = eventLookupSchema.parse(input);
      return toolResult(await app.getEvent(parsed.ref, parsed.subscription));
    },
  );

  server.registerTool(
    "get_logs",
    {
      description: "Return recently imported Jeero inbox log messages, optionally filtered by subscription.",
      inputSchema: logsFilterSchema.shape,
    },
    async (input) => {
      const parsed = logsFilterSchema.parse(input);
      return toolResult(await app.getLogs(parsed));
    },
  );

  server.registerTool(
    "list_event_categories",
    {
      description:
        "Return the available event categories from the local database, optionally filtered by subscription, theater, or date range.",
      inputSchema: eventCategoriesFilterSchema.shape,
    },
    async (input) => {
      const parsed = eventCategoriesFilterSchema.parse(input);
      return toolResult(await app.listEventCategories(parsed));
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

  let isClosed = false;
  const closeDb = () => {
    if (isClosed) {
      return;
    }
    isClosed = true;
    backgroundSync.stop();
    db.close();
  };

  const shutdown = () => {
    closeDb();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return server;
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
  private readonly syncInFlight = new Map<string, Promise<boolean>>();

  public constructor(
    private readonly db: JeeroDatabase,
    private readonly mother: MotherClient,
    private readonly activityLogger: ActivityTraceLogger | null,
  ) {}

  public startBackgroundSync(): { stop: () => void } {
    const run = async (): Promise<void> => {
      try {
        const subscriptions = this.db.listSubscriptions({ activeOnly: true });
        await this.syncSubscriptionsInternal(subscriptions, { force: true });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`Background sync failed: ${message}\n`);
      }
    };

    this.backgroundSyncTimer = setInterval(() => {
      void run();
    }, 60_000);
    this.backgroundSyncTimer.unref();

    return {
      stop: () => {
        if (this.backgroundSyncTimer) {
          clearInterval(this.backgroundSyncTimer);
          this.backgroundSyncTimer = null;
        }
      },
    };
  }

  public async listSubscriptions(filter?: {
    theater?: string;
    activeOnly?: boolean;
  }): Promise<{
    count: number;
    subscriptions: Array<Record<string, unknown>>;
  }> {
    const subscriptions = this.db.listSubscriptions(filter);
    return {
      count: subscriptions.length,
      subscriptions: subscriptions.map((subscription) => ({
        subscription_key: subscription.subscriptionKey,
        label: subscription.label,
        theater: subscription.theater,
        mother_subscription_id: subscription.motherSubscriptionId,
        is_default: subscription.isDefault,
        is_active: subscription.isActive,
        last_inbox_check_at: this.db.getSyncState(subscription.subscriptionKey, "last_inbox_check_at"),
        last_sync_ok_at: this.db.getSyncState(subscription.subscriptionKey, "last_sync_ok_at"),
        last_sync_error: this.db.getSyncState(subscription.subscriptionKey, "last_sync_error"),
        created_at: subscription.createdAt,
        updated_at: subscription.updatedAt,
      })),
    };
  }

  public async createSubscription(input: {
    subscriptionKey: string;
    label: string;
    settings: Record<string, unknown>;
    isDefault?: boolean;
  }): Promise<SubscriptionEnvelope> {
    const created = await this.mother.createSubscription();
    const subscription = this.db.createSubscription({
      subscriptionKey: input.subscriptionKey,
      label: input.label,
      theater: selectedTheater(input.settings),
      motherSubscriptionId: created.subscriptionId,
      settings: input.settings,
      isDefault: input.isDefault,
      isActive: true,
    });

    if (Object.keys(input.settings).length > 0) {
      await this.mother.updateSubscription(subscription.motherSubscriptionId, subscription.settings);
    }

    return this.getSubscriptionEnvelope(subscription.subscriptionKey);
  }

  public async getSubscriptionEnvelope(subscriptionKey?: string): Promise<SubscriptionEnvelope> {
    const subscription = this.resolveSubscription(subscriptionKey);
    const upstream = await this.mother.getSubscription(
      subscription.motherSubscriptionId,
      subscription.settings,
    );

    const normalized = this.db.updateSubscription({
      subscriptionKey: subscription.subscriptionKey,
      motherSubscriptionId: upstream.subscriptionId,
    });

    return toSubscriptionEnvelope(normalized, upstream);
  }

  public async updateSubscription(
    subscriptionKey: string | undefined,
    settings: Record<string, unknown>,
  ): Promise<SubscriptionEnvelope> {
    const current = this.resolveSubscription(subscriptionKey);
    const mergedSettings = {
      ...current.settings,
      ...settings,
    };

    const persisted = this.db.updateSubscription({
      subscriptionKey: current.subscriptionKey,
      settings: mergedSettings,
      theater: selectedTheater(mergedSettings) || current.theater,
    });

    await this.mother.updateSubscription(persisted.motherSubscriptionId, persisted.settings);
    const upstream = await this.mother.getSubscription(
      persisted.motherSubscriptionId,
      persisted.settings,
    );

    return toSubscriptionEnvelope(persisted, upstream);
  }

  public async setDefaultSubscription(subscriptionKey: string): Promise<Record<string, unknown>> {
    const updated = this.db.setDefaultSubscription(subscriptionKey);
    return {
      subscription_key: updated.subscriptionKey,
      label: updated.label,
      theater: updated.theater,
      is_default: updated.isDefault,
      is_active: updated.isActive,
    };
  }

  public async deactivateSubscription(subscriptionKey: string): Promise<Record<string, unknown>> {
    const updated = this.db.updateSubscription({
      subscriptionKey,
      isActive: false,
      isDefault: false,
    });

    return {
      subscription_key: updated.subscriptionKey,
      label: updated.label,
      theater: updated.theater,
      is_default: updated.isDefault,
      is_active: updated.isActive,
    };
  }

  public async activateSubscription(subscriptionKey: string): Promise<Record<string, unknown>> {
    const updated = this.db.updateSubscription({
      subscriptionKey,
      isActive: true,
    });

    return {
      subscription_key: updated.subscriptionKey,
      label: updated.label,
      theater: updated.theater,
      is_default: updated.isDefault,
      is_active: updated.isActive,
    };
  }

  public async syncSubscription(
    subscriptionKey: string,
    force: boolean,
  ): Promise<Record<string, unknown>> {
    const subscription = this.resolveSubscription(subscriptionKey);
    const refreshed = await this.syncInboxIfNeeded(subscription, { force });
    return this.buildSyncResult(subscription, refreshed);
  }

  public async syncSubscriptions(input: {
    theater?: string;
    force: boolean;
  }): Promise<{
    count: number;
    subscriptions: Array<Record<string, unknown>>;
  }> {
    const subscriptions = this.db.listSubscriptions({
      theater: input.theater,
      activeOnly: true,
    });

    const syncResults = await this.syncSubscriptionsInternal(subscriptions, {
      force: input.force,
    });
    const results = subscriptions.map((subscription) =>
      this.buildSyncResult(subscription, syncResults.get(subscription.subscriptionKey) ?? false),
    );

    return {
      count: results.length,
      subscriptions: results,
    };
  }

  public async getEvents(filter: EventsFilter): Promise<{
    refreshed: boolean;
    count: number;
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    sync: Array<Record<string, unknown>>;
    events: Array<Record<string, unknown>>;
  }> {
    const syncTargets = this.resolveSubscriptionsForQuery(filter.subscription, filter.theater);
    const perSubscriptionRefresh = await this.syncSubscriptionsInternal(syncTargets);
    const refreshed = Array.from(perSubscriptionRefresh.values()).some(Boolean);
    const syncResults = syncTargets.map((subscription) =>
      this.buildSyncResult(
        subscription,
        perSubscriptionRefresh.get(subscription.subscriptionKey) ?? false,
      ),
    );

    const pageResult = this.db.getEvents(filter);
    const events = pageResult.events.map((record) => ({
      subscription_key: record.subscriptionKey,
      ref: record.event.ref,
      start: record.event.start,
      end: record.event.end ?? null,
      status: record.event.status ?? null,
      tickets: record.event.tickets
        ? {
            total: record.event.tickets.total ?? null,
            available: record.event.tickets.available ?? null,
          }
        : null,
      production: {
        title: record.event.production.title,
        categories: record.event.production.categories ?? [],
      },
    }));

    return {
      refreshed,
      count: events.length,
      total: pageResult.total,
      page: pageResult.page,
      limit: pageResult.limit,
      totalPages: Math.ceil(pageResult.total / pageResult.limit),
      hasNextPage: pageResult.page * pageResult.limit < pageResult.total,
      hasPreviousPage: pageResult.page > 1,
      sync: syncResults,
      events,
    };
  }

  public async getEvent(ref: string, subscriptionKey?: string): Promise<Record<string, unknown>> {
    const subscription = subscriptionKey ? this.resolveSubscription(subscriptionKey) : undefined;
    if (subscription) {
      await this.syncInboxIfNeeded(subscription);
    }

    const matchingCount = this.db.countEventsByRef(ref, subscription?.subscriptionKey);
    if (matchingCount === 0) {
      throw new Error(`No locally stored event found for ref "${ref}".`);
    }

    if (!subscription && matchingCount > 1) {
      throw new Error(
        `Multiple events found for ref "${ref}". Pass the subscription to disambiguate which event to return.`,
      );
    }

    const record = this.db.getEventByRef(ref, subscription?.subscriptionKey);
    if (!record) {
      throw new Error(`No locally stored event found for ref "${ref}".`);
    }

    return {
      subscription_key: record.subscriptionKey,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      ...record.event,
    };
  }

  public async getLogs(filter: {
    subscription?: string;
    limit?: number;
  }): Promise<{
    count: number;
    logs: Array<Record<string, unknown>>;
  }> {
    const logs = this.db
      .getRecentLogs(filter.limit ?? 20, filter.subscription)
      .map((log) => ({
        inbox_id: log.inboxId,
        subscription_key: log.subscriptionKey,
        subscription_id: log.subscriptionId,
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
      subscription_key: snapshot.subscriptionKey,
      snapshot_date: snapshot.snapshotDate,
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

  public async listEventCategories(filter: {
    subscription?: string;
    theater?: string;
    date?: string;
    from?: string;
    to?: string;
    query?: string;
  }): Promise<{
    count: number;
    categories: Array<Record<string, unknown>>;
  }> {
    const categories = this.db.listEventCategories(filter).map((category) => ({
      name: category.name,
      events: category.events,
    }));

    return {
      count: categories.length,
      categories,
    };
  }

  private resolveSubscription(subscriptionKey?: string): StoredSubscription {
    if (subscriptionKey) {
      const subscription = this.db.getSubscriptionByKey(subscriptionKey);
      if (!subscription) {
        throw new Error(`Unknown subscription "${subscriptionKey}".`);
      }
      return subscription;
    }

    const defaultSubscription = this.db.getDefaultSubscription();
    if (defaultSubscription) {
      return defaultSubscription;
    }

    const activeSubscriptions = this.db.listSubscriptions({ activeOnly: true });
    if (activeSubscriptions.length === 1) {
      return activeSubscriptions[0];
    }

    if (activeSubscriptions.length === 0) {
      throw new Error("No subscriptions are configured. Create a subscription first.");
    }

    throw new Error("Multiple active subscriptions exist. Pass the subscription key explicitly.");
  }

  private resolveSubscriptionsForQuery(
    subscriptionKey?: string,
    theater?: string,
  ): StoredSubscription[] {
    if (subscriptionKey) {
      return [this.resolveSubscription(subscriptionKey)];
    }

    const subscriptions = this.db.listSubscriptions({
      theater,
      activeOnly: true,
    });

    if (subscriptions.length === 0) {
      return [];
    }

    if (theater) {
      return subscriptions;
    }

    const defaultSubscription = this.db.getDefaultSubscription();
    return defaultSubscription ? [defaultSubscription] : subscriptions;
  }

  private async syncInboxIfNeeded(
    subscription: StoredSubscription,
    options?: {
      force?: boolean;
    },
  ): Promise<boolean> {
    const existing = this.syncInFlight.get(subscription.subscriptionKey);
    if (existing) {
      return existing;
    }

    const work = this.runSyncInboxIfNeeded(subscription, options);
    this.syncInFlight.set(subscription.subscriptionKey, work);

    try {
      return await work;
    } finally {
      this.syncInFlight.delete(subscription.subscriptionKey);
    }
  }

  private async runSyncInboxIfNeeded(
    subscription: StoredSubscription,
    options?: {
      force?: boolean;
    },
  ): Promise<boolean> {
    const results = await this.syncSubscriptionsInternal([subscription], options);
    return results.get(subscription.subscriptionKey) ?? false;
  }

  private async syncSubscriptionsInternal(
    subscriptions: StoredSubscription[],
    options?: {
      force?: boolean;
    },
  ): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    if (subscriptions.length === 0) {
      return results;
    }

    const executable = subscriptions.filter((subscription) => subscription.isActive);
    const now = new Date();
    const toFetch: StoredSubscription[] = [];

    for (const subscription of executable) {
      const lastCheck = this.db.getSyncState(subscription.subscriptionKey, "last_inbox_check_at");
      if (!options?.force && lastCheck) {
        const diff = now.getTime() - new Date(lastCheck).getTime();
        if (diff < 60_000) {
          results.set(subscription.subscriptionKey, false);
          continue;
        }
      }

      toFetch.push(subscription);
    }

    if (toFetch.length === 0) {
      return results;
    }

    const requests: MotherInboxRequest[] = toFetch.map((subscription) => ({
      subscriptionId: subscription.motherSubscriptionId,
      settings: subscription.settings,
    }));

    this.logInboxActivity(
      toFetch.length === 1
        ? `Pick up items from inbox for subscription ${toFetch[0].subscriptionKey}.`
        : `Pick up items from inbox for ${toFetch.length} subscriptions.`,
    );

    let inboxItemsBySubscription: Map<string, MotherInboxItem[]>;
    try {
      inboxItemsBySubscription = await this.mother.getInboxBatch(requests);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      for (const subscription of toFetch) {
        this.db.setSyncState(subscription.subscriptionKey, "last_sync_error", message);
      }
      throw error;
    }

    const subscriptionByMotherId = new Map(
      toFetch.map((subscription) => [subscription.motherSubscriptionId, subscription]),
    );

    for (const subscription of toFetch) {
      const inboxItems = inboxItemsBySubscription.get(subscription.motherSubscriptionId) ?? [];
      if (inboxItems.length === 0) {
        this.logInboxActivity(`No items found in inbox for subscription ${subscription.subscriptionKey}.`);
      } else {
        this.logInboxActivity(
          `${inboxItems.length} items found in inbox for subscription ${subscription.subscriptionKey}.`,
        );
      }
      const processedIds: string[] = [];
      let processedCount = 0;

      for (const item of inboxItems) {
        const owner = item.subscription_id
          ? subscriptionByMotherId.get(item.subscription_id) ?? subscription
          : subscription;

        if (this.processLogItem(item, owner)) {
          processedIds.push(item.id);
          processedCount += 1;
          continue;
        }

        if (item.item === "log" || item.action === "log") {
          if (item.id) {
            processedIds.push(item.id);
          }
          continue;
        }

        const processedEvent = this.processEventItem(item);
        if (processedEvent.event) {
          const action = this.db.hasEvent(owner.subscriptionKey, processedEvent.event.ref)
            ? "Updating"
            : "Creating";
          this.db.upsertEvent(owner.subscriptionKey, processedEvent.event);
          this.logInboxActivity(
            `${action} ${owner.theater} event ${processedEvent.event.production.title} (${processedEvent.event.ref}) on ${processedEvent.event.start}.`,
          );
          processedIds.push(item.id);
          processedCount += 1;
          continue;
        }

        if (item.id) {
          processedIds.push(item.id);
        }
      }

      if (processedIds.length > 0) {
        await this.mother.removeInboxItems(processedIds);
      }

      this.db.setSyncState(subscription.subscriptionKey, "last_inbox_check_at", now.toISOString());
      this.db.setSyncState(subscription.subscriptionKey, "last_sync_ok_at", now.toISOString());
      this.db.setSyncState(subscription.subscriptionKey, "last_sync_error", "");
      this.logInboxActivity(
        `Processed ${processedCount} out of ${inboxItems.length} items for subscription ${subscription.subscriptionKey}.`,
      );
      results.set(subscription.subscriptionKey, true);
    }

    return results;
  }

  private logInboxActivity(message: string): void {
    this.activityLogger?.log(message);
  }

  private processEventItem(item: MotherInboxItem): {
    event: JeeroEvent | null;
    reason: string | null;
  } {
    const candidate = extractEventLike(item);
    if (!candidate) {
      return {
        event: null,
        reason: "Inbox item did not contain recognizable event data.",
      };
    }

    const event = validateEvent(candidate);
    if (!event) {
      return {
        event: null,
        reason: "Inbox item contained event-like data but failed validation.",
      };
    }

    return {
      event,
      reason: null,
    };
  }

  private processLogItem(item: MotherInboxItem, subscription: StoredSubscription): boolean {
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
      subscriptionKey: subscription.subscriptionKey,
      subscriptionId: item.subscription_id ?? subscription.motherSubscriptionId,
      action: typeof item.action === "string" ? item.action : "",
      message,
    });
    return true;
  }

  private buildSyncResult(
    subscription: StoredSubscription,
    refreshed: boolean,
  ): Record<string, unknown> {
    return {
      subscription_key: subscription.subscriptionKey,
      theater: subscription.theater,
      refreshed,
      last_inbox_check_at: this.db.getSyncState(subscription.subscriptionKey, "last_inbox_check_at"),
      last_sync_ok_at: this.db.getSyncState(subscription.subscriptionKey, "last_sync_ok_at"),
      last_sync_error:
        emptyToNull(this.db.getSyncState(subscription.subscriptionKey, "last_sync_error")),
    };
  }
}

function toSubscriptionEnvelope(
  subscription: StoredSubscription,
  upstream: {
    subscriptionId: string;
    metadata: Record<string, unknown>;
    fields: unknown[];
    status: Record<string, unknown>;
  },
): SubscriptionEnvelope {
  return {
    subscriptionKey: subscription.subscriptionKey,
    label: subscription.label,
    theater: subscription.theater,
    motherSubscriptionId: upstream.subscriptionId,
    settings: subscription.settings,
    isDefault: subscription.isDefault,
    isActive: subscription.isActive,
    metadata: upstream.metadata,
    fields: upstream.fields,
    status: upstream.status,
  };
}

function emptyToNull(value: string | null): string | null {
  return value && value.length > 0 ? value : null;
}

function selectedTheater(settings: Record<string, unknown>): string {
  return typeof settings.theater === "string" ? settings.theater : "";
}

class ActivityTraceLogger {
  public constructor(private readonly filePath: string) {}

  public log(message: string): void {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      phase: "activity",
      message,
    });
    fs.appendFileSync(this.filePath, `${line}\n`, "utf8");
  }
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
  const ref = asString(event.ref);
  const start = asString(event.start);
  if (
    ref === null ||
    start === null ||
    !production ||
    typeof production !== "object" ||
    typeof (production as Record<string, unknown>).title !== "string"
  ) {
    return null;
  }

  return {
    ref,
    start,
    end: asString(event.end) ?? undefined,
    tickets: isObject(event.tickets) ? (event.tickets as JeeroEvent["tickets"]) : undefined,
    prices: Array.isArray(event.prices) ? (event.prices as JeeroEvent["prices"]) : undefined,
    venue: isObject(event.venue) ? (event.venue as JeeroEvent["venue"]) : undefined,
    status: asString(event.status) ?? undefined,
    production: production as JeeroEvent["production"],
    custom: isObject(event.custom) ? (event.custom as Record<string, unknown>) : {},
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}
