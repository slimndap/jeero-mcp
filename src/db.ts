import Database from "better-sqlite3";

import type {
  EventRecord,
  EventsFilter,
  JeeroEvent,
  LogRecord,
  PaginatedEventsResult,
  StoredSubscription,
  TicketSnapshotRecord,
  TicketSnapshotsFilter,
} from "./types.js";

interface SubscriptionRow {
  id: number;
  subscription_key: string;
  label: string;
  theater: string;
  mother_subscription_id: string;
  settings_json: string;
  is_default: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  subscription_key: string;
  ref: string;
  start: string;
  end: string | null;
  status: string | null;
  tickets_json: string | null;
  prices_json: string | null;
  venue_json: string | null;
  production_json: string;
  custom_json: string | null;
  created_at: string;
  updated_at: string;
}

interface LogRow {
  inbox_id: string;
  subscription_key: string;
  subscription_id: string;
  action: string;
  message: string;
  created_at: string;
  updated_at: string;
}

interface TicketSnapshotRow {
  subscription_key: string;
  snapshot_date: string;
  ref: string;
  start: string | null;
  production_title: string;
  total_tickets: number;
  available_tickets: number;
  sold_tickets: number;
  created_at: string;
  updated_at: string;
}

interface CategoryRow {
  name: string;
  events: number;
}

export class JeeroDatabase {
  private readonly db: Database.Database;

  public constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  public close(): void {
    this.db.close();
  }

  public listSubscriptions(options?: {
    theater?: string;
    activeOnly?: boolean;
  }): StoredSubscription[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (options?.theater) {
      where.push("theater = ?");
      params.push(options.theater);
    }

    if (options?.activeOnly) {
      where.push("is_active = 1");
    }

    const sql = [
      "SELECT *",
      "FROM subscriptions",
      where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY is_default DESC, theater ASC, label ASC, subscription_key ASC",
    ]
      .filter(Boolean)
      .join(" ");

    return (this.db.prepare(sql).all(...params) as SubscriptionRow[]).map(mapSubscriptionRow);
  }

  public getSubscriptionByKey(subscriptionKey: string): StoredSubscription | null {
    const row = this.db
      .prepare("SELECT * FROM subscriptions WHERE subscription_key = ? LIMIT 1")
      .get(subscriptionKey) as SubscriptionRow | undefined;

    return row ? mapSubscriptionRow(row) : null;
  }

  public getDefaultSubscription(): StoredSubscription | null {
    const row = this.db
      .prepare("SELECT * FROM subscriptions WHERE is_default = 1 LIMIT 1")
      .get() as SubscriptionRow | undefined;

    return row ? mapSubscriptionRow(row) : null;
  }

  public getActiveSubscriptionCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS total FROM subscriptions WHERE is_active = 1")
      .get() as { total: number };
    return row.total;
  }

  public createSubscription(input: {
    subscriptionKey: string;
    label: string;
    theater: string;
    motherSubscriptionId: string;
    settings: Record<string, unknown>;
    isDefault?: boolean;
    isActive?: boolean;
  }): StoredSubscription {
    const now = new Date().toISOString();
    const shouldBeDefault = input.isDefault ?? this.getDefaultSubscription() === null;
    const isActive = input.isActive ?? true;

    const transaction = this.db.transaction(() => {
      if (shouldBeDefault) {
        this.db.prepare("UPDATE subscriptions SET is_default = 0 WHERE is_default = 1").run();
      }

      this.db
        .prepare(
          `INSERT INTO subscriptions
             (subscription_key, label, theater, mother_subscription_id, settings_json, is_default, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.subscriptionKey,
          input.label,
          input.theater,
          input.motherSubscriptionId,
          JSON.stringify(input.settings),
          shouldBeDefault ? 1 : 0,
          isActive ? 1 : 0,
          now,
          now,
        );
    });

    transaction();
    const subscription = this.getSubscriptionByKey(input.subscriptionKey);
    if (!subscription) {
      throw new Error(`Failed to create subscription "${input.subscriptionKey}".`);
    }

    return subscription;
  }

  public updateSubscription(input: {
    subscriptionKey: string;
    label?: string;
    theater?: string;
    motherSubscriptionId?: string;
    settings?: Record<string, unknown>;
    isDefault?: boolean;
    isActive?: boolean;
  }): StoredSubscription {
    const existing = this.getSubscriptionByKey(input.subscriptionKey);
    if (!existing) {
      throw new Error(`Unknown subscription "${input.subscriptionKey}".`);
    }

    const next = {
      label: input.label ?? existing.label,
      theater: input.theater ?? existing.theater,
      motherSubscriptionId: input.motherSubscriptionId ?? existing.motherSubscriptionId,
      settings: input.settings ?? existing.settings,
      isDefault: input.isDefault ?? existing.isDefault,
      isActive: input.isActive ?? existing.isActive,
    };
    const now = new Date().toISOString();

    const transaction = this.db.transaction(() => {
      if (next.isDefault) {
        this.db.prepare("UPDATE subscriptions SET is_default = 0 WHERE is_default = 1").run();
      }

      this.db
        .prepare(
          `UPDATE subscriptions
           SET label = ?, theater = ?, mother_subscription_id = ?, settings_json = ?, is_default = ?, is_active = ?, updated_at = ?
           WHERE subscription_key = ?`,
        )
        .run(
          next.label,
          next.theater,
          next.motherSubscriptionId,
          JSON.stringify(next.settings),
          next.isDefault ? 1 : 0,
          next.isActive ? 1 : 0,
          now,
          input.subscriptionKey,
        );
    });

    transaction();
    const updated = this.getSubscriptionByKey(input.subscriptionKey);
    if (!updated) {
      throw new Error(`Failed to update subscription "${input.subscriptionKey}".`);
    }

    return updated;
  }

  public setDefaultSubscription(subscriptionKey: string): StoredSubscription {
    return this.updateSubscription({
      subscriptionKey,
      isDefault: true,
    });
  }

  public getSyncState(subscriptionKey: string, key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM subscription_sync_state WHERE subscription_key = ? AND key = ?")
      .get(subscriptionKey, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  public setSyncState(subscriptionKey: string, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO subscription_sync_state (subscription_key, key, value)
         VALUES (?, ?, ?)
         ON CONFLICT(subscription_key, key) DO UPDATE SET value = excluded.value`,
      )
      .run(subscriptionKey, key, value);
  }

  public upsertEvent(subscriptionKey: string, event: JeeroEvent): void {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO events
           (subscription_key, ref, start, end, status, tickets_json, prices_json, venue_json, production_json, custom_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(subscription_key, ref) DO UPDATE SET
           start = excluded.start,
           end = excluded.end,
           status = excluded.status,
           tickets_json = excluded.tickets_json,
           prices_json = excluded.prices_json,
           venue_json = excluded.venue_json,
           production_json = excluded.production_json,
           custom_json = excluded.custom_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        subscriptionKey,
        event.ref,
        event.start,
        event.end ?? null,
        event.status ?? null,
        jsonOrNull(event.tickets),
        jsonOrNull(event.prices),
        jsonOrNull(event.venue),
        JSON.stringify(event.production),
        jsonOrNull(event.custom),
        now,
        now,
      );

    this.upsertTicketSnapshot(subscriptionKey, event, now);
  }

  public getEvents(filter: EventsFilter): PaginatedEventsResult {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.subscription) {
      where.push("e.subscription_key = ?");
      params.push(filter.subscription);
    }

    if (filter.theater) {
      where.push("s.theater = ?");
      params.push(filter.theater);
    }

    if (filter.date) {
      where.push("date(e.start) = date(?)");
      params.push(filter.date);
    } else {
      if (filter.from) {
        where.push("datetime(e.start) >= datetime(?)");
        params.push(normalizeRangeBoundary(filter.from, "start"));
      }
      if (filter.to) {
        where.push("datetime(e.start) <= datetime(?)");
        params.push(normalizeRangeBoundary(filter.to, "end"));
      }
    }

    if (filter.status) {
      where.push("e.status = ?");
      params.push(filter.status);
    }

    if (filter.category) {
      where.push(
        "EXISTS (SELECT 1 FROM json_each(json_extract(e.production_json, '$.categories')) WHERE json_each.value = ?)",
      );
      params.push(filter.category);
    }

    if (filter.query) {
      where.push(
        "(json_extract(e.production_json, '$.title') LIKE ? OR json_extract(e.production_json, '$.description') LIKE ?)",
      );
      const like = `%${filter.query}%`;
      params.push(like, like);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = filter.limit ?? 100;
    const page = filter.page ?? 1;
    const offset = (page - 1) * limit;

    const countSql = [
      "SELECT COUNT(*) as total",
      "FROM events e",
      "INNER JOIN subscriptions s ON s.subscription_key = e.subscription_key",
      whereClause,
    ]
      .filter(Boolean)
      .join(" ");

    const totalRow = this.db.prepare(countSql).get(...params) as { total: number };

    const sql = [
      "SELECT e.subscription_key, e.ref, e.start, e.end, e.status, e.tickets_json, e.prices_json, e.venue_json, e.production_json, e.custom_json, e.created_at, e.updated_at",
      "FROM events e",
      "INNER JOIN subscriptions s ON s.subscription_key = e.subscription_key",
      whereClause,
      "ORDER BY datetime(e.start) ASC",
      "LIMIT ? OFFSET ?",
    ]
      .filter(Boolean)
      .join(" ");

    const rows = this.db.prepare(sql).all(...params, limit, offset) as EventRow[];
    return {
      total: totalRow.total,
      page,
      limit,
      events: rows.map(mapEventRow),
    };
  }

  public getEventByRef(ref: string, subscriptionKey?: string): EventRecord | null {
    const sql = subscriptionKey
      ? `SELECT subscription_key, ref, start, end, status, tickets_json, prices_json, venue_json, production_json, custom_json, created_at, updated_at
         FROM events
         WHERE ref = ? AND subscription_key = ?
         ORDER BY datetime(start) ASC
         LIMIT 1`
      : `SELECT subscription_key, ref, start, end, status, tickets_json, prices_json, venue_json, production_json, custom_json, created_at, updated_at
         FROM events
         WHERE ref = ?
         ORDER BY datetime(start) ASC
         LIMIT 1`;

    const row = (subscriptionKey
      ? this.db.prepare(sql).get(ref, subscriptionKey)
      : this.db.prepare(sql).get(ref)) as EventRow | undefined;

    return row ? mapEventRow(row) : null;
  }

  public countEventsByRef(ref: string, subscriptionKey?: string): number {
    const sql = subscriptionKey
      ? "SELECT COUNT(*) AS total FROM events WHERE ref = ? AND subscription_key = ?"
      : "SELECT COUNT(*) AS total FROM events WHERE ref = ?";

    const row = (subscriptionKey
      ? this.db.prepare(sql).get(ref, subscriptionKey)
      : this.db.prepare(sql).get(ref)) as { total: number };

    return row.total;
  }

  public hasEvent(subscriptionKey: string, ref: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM events WHERE subscription_key = ? AND ref = ? LIMIT 1")
      .get(subscriptionKey, ref) as { found: number } | undefined;

    return Boolean(row?.found);
  }

  public upsertLog(input: {
    inboxId: string;
    subscriptionKey: string;
    subscriptionId: string;
    action: string;
    message: string;
  }): void {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO logs
           (inbox_id, subscription_key, subscription_id, action, message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(inbox_id) DO UPDATE SET
           subscription_key = excluded.subscription_key,
           subscription_id = excluded.subscription_id,
           action = excluded.action,
           message = excluded.message,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.inboxId,
        input.subscriptionKey,
        input.subscriptionId,
        input.action,
        input.message,
        now,
        now,
      );
  }

  public getRecentLogs(limit = 20, subscriptionKey?: string): LogRecord[] {
    const sql = subscriptionKey
      ? `SELECT inbox_id, subscription_key, subscription_id, action, message, created_at, updated_at
         FROM logs
         WHERE subscription_key = ?
         ORDER BY datetime(updated_at) DESC
         LIMIT ?`
      : `SELECT inbox_id, subscription_key, subscription_id, action, message, created_at, updated_at
         FROM logs
         ORDER BY datetime(updated_at) DESC
         LIMIT ?`;

    const rows = (subscriptionKey
      ? this.db.prepare(sql).all(subscriptionKey, limit)
      : this.db.prepare(sql).all(limit)) as LogRow[];

    return rows.map((row) => ({
      inboxId: row.inbox_id,
      subscriptionKey: row.subscription_key,
      subscriptionId: row.subscription_id,
      action: row.action,
      message: row.message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  public getTicketSnapshots(filter: TicketSnapshotsFilter): TicketSnapshotRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.subscription) {
      where.push("ts.subscription_key = ?");
      params.push(filter.subscription);
    }

    if (filter.date) {
      where.push("ts.snapshot_date = ?");
      params.push(filter.date);
    } else {
      if (filter.from) {
        where.push("ts.snapshot_date >= ?");
        params.push(filter.from);
      }
      if (filter.to) {
        where.push("ts.snapshot_date <= ?");
        params.push(filter.to);
      }
    }

    if (filter.ref) {
      where.push("ts.ref = ?");
      params.push(filter.ref);
    }

    if (filter.query) {
      where.push("ts.production_title LIKE ?");
      params.push(`%${filter.query}%`);
    }

    const sql = [
      "SELECT ts.subscription_key, ts.snapshot_date, ts.ref, ts.start, ts.production_title, ts.total_tickets, ts.available_tickets, ts.sold_tickets, ts.created_at, ts.updated_at",
      "FROM ticket_snapshots ts",
      where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY ts.snapshot_date DESC, datetime(ts.start) ASC, ts.subscription_key ASC, ts.ref ASC",
      filter.limit ? "LIMIT ?" : "",
    ]
      .filter(Boolean)
      .join(" ");

    if (filter.limit) {
      params.push(filter.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as TicketSnapshotRow[];
    return rows.map((row) => ({
      subscriptionKey: row.subscription_key,
      snapshotDate: row.snapshot_date,
      ref: row.ref,
      start: row.start ?? undefined,
      productionTitle: row.production_title,
      totalTickets: row.total_tickets,
      availableTickets: row.available_tickets,
      soldTickets: row.sold_tickets,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  public listEventCategories(filter: {
    subscription?: string;
    theater?: string;
    from?: string;
    to?: string;
    date?: string;
    query?: string;
  }): Array<{ name: string; events: number }> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.subscription) {
      where.push("e.subscription_key = ?");
      params.push(filter.subscription);
    }

    if (filter.theater) {
      where.push("s.theater = ?");
      params.push(filter.theater);
    }

    if (filter.date) {
      where.push("date(e.start) = date(?)");
      params.push(filter.date);
    } else {
      if (filter.from) {
        where.push("datetime(e.start) >= datetime(?)");
        params.push(normalizeRangeBoundary(filter.from, "start"));
      }
      if (filter.to) {
        where.push("datetime(e.start) <= datetime(?)");
        params.push(normalizeRangeBoundary(filter.to, "end"));
      }
    }

    if (filter.query) {
      where.push("category.value LIKE ?");
      params.push(`%${filter.query}%`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const sql = [
      "SELECT category.value AS name, COUNT(*) AS events",
      "FROM events e",
      "INNER JOIN subscriptions s ON s.subscription_key = e.subscription_key",
      "INNER JOIN json_each(json_extract(e.production_json, '$.categories')) AS category",
      whereClause,
      "GROUP BY category.value",
      "ORDER BY COUNT(*) DESC, category.value ASC",
    ]
      .filter(Boolean)
      .join(" ");

    return (this.db.prepare(sql).all(...params) as CategoryRow[]).map((row) => ({
      name: row.name,
      events: row.events,
    }));
  }

  private migrate(): void {
    const hasLegacySubscription = this.tableHasColumn("subscription", "mother_subscription_id");
    const hasLegacySyncState = this.tableHasColumn("sync_state", "value");
    const hasLegacyEvents = this.tableHasColumn("events", "theater");
    const hasLegacyLogs = this.tableHasColumn("logs", "theater");
    const hasLegacySnapshots = this.tableHasColumn("ticket_snapshots", "theater");
    const hasNewEvents = this.tableHasColumn("events", "subscription_key");
    const hasNewLogs = this.tableHasColumn("logs", "subscription_key");
    const hasNewSnapshots = this.tableHasColumn("ticket_snapshots", "subscription_key");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscription_key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        theater TEXT NOT NULL,
        mother_subscription_id TEXT NOT NULL UNIQUE,
        settings_json TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_default_idx
      ON subscriptions (is_default)
      WHERE is_default = 1;

      CREATE TABLE IF NOT EXISTS subscription_sync_state (
        subscription_key TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY(subscription_key, key),
        FOREIGN KEY(subscription_key) REFERENCES subscriptions(subscription_key)
      );
    `);

    if (hasLegacySubscription) {
      this.db.exec(`
        INSERT OR IGNORE INTO subscriptions
          (subscription_key, label, theater, mother_subscription_id, settings_json, is_default, is_active, created_at, updated_at)
        SELECT
          'default',
          'Default subscription',
          '',
          mother_subscription_id,
          settings_json,
          1,
          1,
          created_at,
          updated_at
        FROM subscription
        LIMIT 1;
      `);
    }

    if (hasLegacySyncState) {
      this.db.exec(`
        INSERT OR IGNORE INTO subscription_sync_state (subscription_key, key, value)
        SELECT 'default', key, value
        FROM sync_state;
      `);
    }

    if (hasLegacyEvents && !hasNewEvents) {
      this.db.exec(`
        CREATE TABLE events_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subscription_key TEXT NOT NULL,
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
          updated_at TEXT NOT NULL,
          UNIQUE(subscription_key, ref),
          FOREIGN KEY(subscription_key) REFERENCES subscriptions(subscription_key)
        );

        INSERT OR IGNORE INTO events_new
          (id, subscription_key, ref, start, end, status, tickets_json, prices_json, venue_json, production_json, custom_json, created_at, updated_at)
        SELECT id, 'default', ref, start, end, status, tickets_json, prices_json, venue_json, production_json, custom_json, created_at, updated_at
        FROM events;

        DROP TABLE events;
        ALTER TABLE events_new RENAME TO events;
      `);
    } else if (!hasLegacyEvents && !hasNewEvents) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subscription_key TEXT NOT NULL,
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
          updated_at TEXT NOT NULL,
          UNIQUE(subscription_key, ref),
          FOREIGN KEY(subscription_key) REFERENCES subscriptions(subscription_key)
        );
      `);
    }

    if (hasLegacyLogs && !hasNewLogs) {
      this.db.exec(`
        CREATE TABLE logs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          inbox_id TEXT NOT NULL UNIQUE,
          subscription_key TEXT NOT NULL,
          subscription_id TEXT NOT NULL,
          action TEXT NOT NULL DEFAULT '',
          message TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(subscription_key) REFERENCES subscriptions(subscription_key)
        );

        INSERT OR IGNORE INTO logs_new
          (id, inbox_id, subscription_key, subscription_id, action, message, created_at, updated_at)
        SELECT id, inbox_id, 'default', subscription_id, action, message, created_at, updated_at
        FROM logs;

        DROP TABLE logs;
        ALTER TABLE logs_new RENAME TO logs;
      `);
    } else if (!hasLegacyLogs && !hasNewLogs) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          inbox_id TEXT NOT NULL UNIQUE,
          subscription_key TEXT NOT NULL,
          subscription_id TEXT NOT NULL,
          action TEXT NOT NULL DEFAULT '',
          message TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(subscription_key) REFERENCES subscriptions(subscription_key)
        );
      `);
    }

    if (hasLegacySnapshots && !hasNewSnapshots) {
      this.db.exec(`
        CREATE TABLE ticket_snapshots_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subscription_key TEXT NOT NULL,
          snapshot_date TEXT NOT NULL,
          ref TEXT NOT NULL,
          start TEXT,
          production_title TEXT NOT NULL,
          total_tickets INTEGER NOT NULL,
          available_tickets INTEGER NOT NULL,
          sold_tickets INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(subscription_key, snapshot_date, ref),
          FOREIGN KEY(subscription_key) REFERENCES subscriptions(subscription_key)
        );

        INSERT OR IGNORE INTO ticket_snapshots_new
          (id, subscription_key, snapshot_date, ref, start, production_title, total_tickets, available_tickets, sold_tickets, created_at, updated_at)
        SELECT id, 'default', snapshot_date, ref, start, production_title, total_tickets, available_tickets, sold_tickets, created_at, updated_at
        FROM ticket_snapshots;

        DROP TABLE ticket_snapshots;
        ALTER TABLE ticket_snapshots_new RENAME TO ticket_snapshots;
      `);
    } else if (!hasLegacySnapshots && !hasNewSnapshots) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ticket_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subscription_key TEXT NOT NULL,
          snapshot_date TEXT NOT NULL,
          ref TEXT NOT NULL,
          start TEXT,
          production_title TEXT NOT NULL,
          total_tickets INTEGER NOT NULL,
          available_tickets INTEGER NOT NULL,
          sold_tickets INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(subscription_key, snapshot_date, ref),
          FOREIGN KEY(subscription_key) REFERENCES subscriptions(subscription_key)
        );
      `);
    }

    this.db.exec(`
      DROP TABLE IF EXISTS subscription;
      DROP TABLE IF EXISTS sync_state;
    `);
  }

  private tableHasColumn(tableName: string, columnName: string): boolean {
    const tableExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { name: string } | undefined;

    if (!tableExists) {
      return false;
    }

    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>;
    return columns.some((column) => column.name === columnName);
  }

  private upsertTicketSnapshot(subscriptionKey: string, event: JeeroEvent, now: string): void {
    const totalTickets = asInteger(event.tickets?.total);
    const availableTickets = asInteger(event.tickets?.available);
    if (totalTickets === null || availableTickets === null) {
      return;
    }

    const soldTickets = Math.max(0, totalTickets - availableTickets);
    const snapshotDate = new Date(now).toLocaleDateString("en-CA", {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });

    this.db
      .prepare(
        `INSERT INTO ticket_snapshots
           (subscription_key, snapshot_date, ref, start, production_title, total_tickets, available_tickets, sold_tickets, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(subscription_key, snapshot_date, ref) DO UPDATE SET
           start = excluded.start,
           production_title = excluded.production_title,
           total_tickets = excluded.total_tickets,
           available_tickets = excluded.available_tickets,
           sold_tickets = excluded.sold_tickets,
           updated_at = excluded.updated_at`,
      )
      .run(
        subscriptionKey,
        snapshotDate,
        event.ref,
        event.start ?? null,
        event.production.title,
        totalTickets,
        availableTickets,
        soldTickets,
        now,
        now,
      );
  }
}

function mapSubscriptionRow(row: SubscriptionRow): StoredSubscription {
  return {
    id: row.id,
    subscriptionKey: row.subscription_key,
    label: row.label,
    theater: row.theater,
    motherSubscriptionId: row.mother_subscription_id,
    settings: JSON.parse(row.settings_json),
    isDefault: row.is_default === 1,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return JSON.stringify(value);
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) {
    return undefined;
  }

  return JSON.parse(value) as T;
}

function mapEventRow(row: EventRow): EventRecord {
  return {
    subscriptionKey: row.subscription_key,
    event: {
      ref: row.ref,
      start: row.start,
      end: row.end ?? undefined,
      status: row.status ?? undefined,
      tickets: parseJson<JeeroEvent["tickets"]>(row.tickets_json),
      prices: parseJson<JeeroEvent["prices"]>(row.prices_json),
      venue: parseJson<JeeroEvent["venue"]>(row.venue_json),
      production: JSON.parse(row.production_json),
      custom: parseJson<JeeroEvent["custom"]>(row.custom_json) ?? {},
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  return null;
}

function normalizeRangeBoundary(value: string, boundary: "start" | "end"): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return boundary === "start" ? `${value} 00:00:00` : `${value} 23:59:59`;
  }

  return value;
}
