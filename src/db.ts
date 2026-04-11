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
  mother_subscription_id: string;
  settings_json: string;
  site_key: string;
  site_identifier: string;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  theater: string;
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
  subscription_id: string;
  theater: string;
  action: string;
  message: string;
  created_at: string;
  updated_at: string;
}

interface TicketSnapshotRow {
  snapshot_date: string;
  theater: string;
  ref: string;
  start: string | null;
  production_title: string;
  total_tickets: number;
  available_tickets: number;
  sold_tickets: number;
  created_at: string;
  updated_at: string;
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

  public getSubscription(): StoredSubscription | null {
    const row = this.db
      .prepare("SELECT * FROM subscription ORDER BY id ASC LIMIT 1")
      .get() as SubscriptionRow | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      motherSubscriptionId: row.mother_subscription_id,
      settings: JSON.parse(row.settings_json),
      siteKey: row.site_key,
      siteIdentifier: row.site_identifier,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  public upsertSubscription(input: {
    motherSubscriptionId: string;
    settings: Record<string, unknown>;
    siteKey: string;
    siteIdentifier: string;
  }): StoredSubscription {
    const existing = this.getSubscription();
    const now = new Date().toISOString();

    if (existing) {
      this.db
        .prepare(
          `UPDATE subscription
           SET mother_subscription_id = ?, settings_json = ?, site_key = ?, site_identifier = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.motherSubscriptionId,
          JSON.stringify(input.settings),
          input.siteKey,
          input.siteIdentifier,
          now,
          existing.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO subscription
             (mother_subscription_id, settings_json, site_key, site_identifier, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.motherSubscriptionId,
          JSON.stringify(input.settings),
          input.siteKey,
          input.siteIdentifier,
          now,
          now,
        );
    }

    const subscription = this.getSubscription();
    if (!subscription) {
      throw new Error("Failed to persist subscription.");
    }

    return subscription;
  }

  public getSyncState(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM sync_state WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  public setSyncState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  public upsertEvent(theater: string, event: JeeroEvent): void {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO events
           (theater, ref, start, end, status, tickets_json, prices_json, venue_json, production_json, custom_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(theater, ref) DO UPDATE SET
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
        theater,
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

    this.upsertTicketSnapshot(theater, event, now);
  }

  public getEvents(filter: EventsFilter): PaginatedEventsResult {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.date) {
      where.push("date(start) = date(?)");
      params.push(filter.date);
    } else {
      if (filter.from) {
        where.push("datetime(start) >= datetime(?)");
        params.push(normalizeRangeBoundary(filter.from, "start"));
      }
      if (filter.to) {
        where.push("datetime(start) <= datetime(?)");
        params.push(normalizeRangeBoundary(filter.to, "end"));
      }
    }

    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }

    if (filter.theater) {
      where.push("theater = ?");
      params.push(filter.theater);
    }

    if (filter.query) {
      where.push(
        "(json_extract(production_json, '$.title') LIKE ? OR json_extract(production_json, '$.description') LIKE ?)",
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
      "FROM events",
      whereClause,
    ]
      .filter(Boolean)
      .join(" ");

    const totalRow = this.db.prepare(countSql).get(...params) as { total: number };

    const sql = [
      "SELECT theater, ref, start, end, status, tickets_json, prices_json, venue_json, production_json, custom_json, created_at, updated_at",
      "FROM events",
      whereClause,
      "ORDER BY datetime(start) ASC",
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

  public getEventByRef(ref: string, theater?: string): EventRecord | null {
    const sql = theater
      ? `SELECT theater, ref, start, end, status, tickets_json, prices_json, venue_json, production_json, custom_json, created_at, updated_at
         FROM events
         WHERE ref = ? AND theater = ?
         ORDER BY datetime(start) ASC
         LIMIT 1`
      : `SELECT theater, ref, start, end, status, tickets_json, prices_json, venue_json, production_json, custom_json, created_at, updated_at
         FROM events
         WHERE ref = ?
         ORDER BY datetime(start) ASC
         LIMIT 1`;

    const row = (theater
      ? this.db.prepare(sql).get(ref, theater)
      : this.db.prepare(sql).get(ref)) as EventRow | undefined;

    return row ? mapEventRow(row) : null;
  }

  public countEventsByRef(ref: string, theater?: string): number {
    const sql = theater
      ? "SELECT COUNT(*) AS total FROM events WHERE ref = ? AND theater = ?"
      : "SELECT COUNT(*) AS total FROM events WHERE ref = ?";

    const row = (theater
      ? this.db.prepare(sql).get(ref, theater)
      : this.db.prepare(sql).get(ref)) as { total: number };

    return row.total;
  }

  public upsertLog(input: {
    inboxId: string;
    subscriptionId: string;
    theater: string;
    action: string;
    message: string;
  }): void {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO logs
           (inbox_id, subscription_id, theater, action, message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(inbox_id) DO UPDATE SET
           subscription_id = excluded.subscription_id,
           theater = excluded.theater,
           action = excluded.action,
           message = excluded.message,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.inboxId,
        input.subscriptionId,
        input.theater,
        input.action,
        input.message,
        now,
        now,
      );
  }

  public getRecentLogs(limit = 20, theater?: string): LogRecord[] {
    const sql = theater
      ? `SELECT inbox_id, subscription_id, theater, action, message, created_at, updated_at
         FROM logs
         WHERE theater = ?
         ORDER BY datetime(updated_at) DESC
         LIMIT ?`
      : `SELECT inbox_id, subscription_id, theater, action, message, created_at, updated_at
         FROM logs
         ORDER BY datetime(updated_at) DESC
         LIMIT ?`;

    const rows = (theater
      ? this.db.prepare(sql).all(theater, limit)
      : this.db.prepare(sql).all(limit)) as LogRow[];

    return rows.map((row) => ({
      inboxId: row.inbox_id,
      subscriptionId: row.subscription_id,
      theater: row.theater,
      action: row.action,
      message: row.message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  public getTicketSnapshots(filter: TicketSnapshotsFilter): TicketSnapshotRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.date) {
      where.push("snapshot_date = ?");
      params.push(filter.date);
    } else {
      if (filter.from) {
        where.push("snapshot_date >= ?");
        params.push(filter.from);
      }
      if (filter.to) {
        where.push("snapshot_date <= ?");
        params.push(filter.to);
      }
    }

    if (filter.theater) {
      where.push("theater = ?");
      params.push(filter.theater);
    }

    if (filter.ref) {
      where.push("ref = ?");
      params.push(filter.ref);
    }

    if (filter.query) {
      where.push("production_title LIKE ?");
      params.push(`%${filter.query}%`);
    }

    const sql = [
      "SELECT snapshot_date, theater, ref, start, production_title, total_tickets, available_tickets, sold_tickets, created_at, updated_at",
      "FROM ticket_snapshots",
      where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY snapshot_date DESC, datetime(start) ASC, theater ASC, ref ASC",
      filter.limit ? "LIMIT ?" : "",
    ]
      .filter(Boolean)
      .join(" ");

    if (filter.limit) {
      params.push(filter.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as TicketSnapshotRow[];
    return rows.map((row) => ({
      snapshotDate: row.snapshot_date,
      theater: row.theater,
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

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscription (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mother_subscription_id TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        site_key TEXT NOT NULL,
        site_identifier TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        updated_at TEXT NOT NULL,
        UNIQUE(theater, ref)
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inbox_id TEXT NOT NULL UNIQUE,
        subscription_id TEXT NOT NULL,
        theater TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ticket_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_date TEXT NOT NULL,
        theater TEXT NOT NULL,
        ref TEXT NOT NULL,
        start TEXT,
        production_title TEXT NOT NULL,
        total_tickets INTEGER NOT NULL,
        available_tickets INTEGER NOT NULL,
        sold_tickets INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(snapshot_date, theater, ref)
      );
    `);
  }

  private upsertTicketSnapshot(theater: string, event: JeeroEvent, now: string): void {
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
           (snapshot_date, theater, ref, start, production_title, total_tickets, available_tickets, sold_tickets, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(snapshot_date, theater, ref) DO UPDATE SET
           start = excluded.start,
           production_title = excluded.production_title,
           total_tickets = excluded.total_tickets,
           available_tickets = excluded.available_tickets,
           sold_tickets = excluded.sold_tickets,
           updated_at = excluded.updated_at`,
      )
      .run(
        snapshotDate,
        theater,
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
    theater: row.theater,
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
