import fs from "node:fs";

import type { JeeroConfig } from "./config.js";

export interface MotherSubscriptionResponse {
  subscriptionId: string;
  metadata: Record<string, unknown>;
  fields: unknown[];
  status: Record<string, unknown>;
}

export interface MotherInboxItem {
  id: string;
  subscription_id?: string;
  action?: string;
  item?: string;
  data?: unknown;
  raw?: unknown;
  theater?: string;
  event?: unknown;
  payload?: unknown;
  [key: string]: unknown;
}

export interface MotherInboxRequest {
  subscriptionId: string;
  settings: Record<string, unknown>;
}

export class MotherClient {
  private readonly traceLogger: MotherTraceLogger | null;

  public constructor(
    private readonly config: JeeroConfig,
    private readonly siteKey: string,
    private readonly siteIdentifier: string,
  ) {
    this.traceLogger = config.motherTraceEnabled
      ? new MotherTraceLogger(config.motherTracePath)
      : null;
  }

  public async createSubscription(): Promise<{ subscriptionId: string; raw: unknown }> {
    const response = await this.request("POST", "/v1/subscriptions");
    const raw = await response.json();
    return {
      subscriptionId: extractSubscriptionId(raw),
      raw,
    };
  }

  public async getSubscription(
    subscriptionId: string,
    settings: Record<string, unknown>,
  ): Promise<MotherSubscriptionResponse> {
    const payload = withTimezone(settings, this.config.defaultTimezone);
    const query = new URLSearchParams({
      settings: JSON.stringify(payload),
    });
    const response = await this.request(
      "GET",
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}?${query.toString()}`,
    );
    const raw = await response.json();
    return parseSubscriptionResponse(subscriptionId, raw);
  }

  public async updateSubscription(
    subscriptionId: string,
    settings: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.request(
      "POST",
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        settings: withTimezone(settings, this.config.defaultTimezone),
      },
    );
    return response.json();
  }

  public async getInbox(
    subscriptionId: string,
    settings: Record<string, unknown>,
  ): Promise<MotherInboxItem[]> {
    const results = await this.getInboxBatch([
      {
        subscriptionId,
        settings,
      },
    ]);
    return results.get(subscriptionId) ?? [];
  }

  public async getInboxBatch(
    requests: MotherInboxRequest[],
  ): Promise<Map<string, MotherInboxItem[]>> {
    if (requests.length === 0) {
      return new Map();
    }

    const headers: Record<string, string> = {};
    if (this.config.noOfItemsPerPickup) {
      headers["no_of_items_per_pickup"] = String(this.config.noOfItemsPerPickup);
    }

    const payload = Object.fromEntries(
      requests.map((request) => [
        request.subscriptionId,
        withTimezone(request.settings, this.config.defaultTimezone),
      ]),
    );

    const response = await this.request(
      "POST",
      "/v1/inbox/big",
      payload,
      headers,
    );
    const raw = await response.json();
    const itemsBySubscription = extractInboxItemsBySubscription(
      raw,
      requests.map((request) => request.subscriptionId),
    );
    this.traceLogger?.logInboxLogItems(itemsBySubscription);
    return itemsBySubscription;
  }

  public async removeInboxItems(itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) {
      return;
    }

    const query = new URLSearchParams({
      inbox_id: JSON.stringify(itemIds),
    });
    await this.request("DELETE", `/v1/inbox?${query.toString()}`);
  }

  private async request(
    method: string,
    pathname: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const url = `${this.config.motherBaseUrl}${pathname}`;
    const headers: Record<string, string> = {
      site_key: this.siteKey,
      site_url: this.siteIdentifier,
      ...extraHeaders,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    };
    const requestBody = body === undefined ? undefined : JSON.stringify(body);

    if (shouldTraceRequest(method, pathname)) {
      this.traceLogger?.log({
        phase: "request",
        method,
        url,
        hasBody: body !== undefined,
        headerKeys: Object.keys(headers).sort(),
      });
    }

    const response = await fetch(url, {
      method,
      headers,
      body: requestBody,
    });

    const responseBody = await response.clone().text();
    if (shouldTraceRequest(method, pathname)) {
      this.traceLogger?.log({
        phase: "response",
        method,
        url,
        status: response.status,
        statusText: response.statusText,
        bodyOmitted: !shouldLogResponseBody(pathname),
        responseSize: responseBody.length,
      });
    }

    if (!response.ok) {
      throw new Error(
        `Mother request failed (${response.status} ${response.statusText}) for ${method} ${pathname}: ${responseBody}`,
      );
    }

    return response;
  }
}

class MotherTraceLogger {
  public constructor(private readonly filePath: string) {}

  public log(entry: Record<string, unknown>): void {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry,
    });
    fs.appendFileSync(this.filePath, `${line}\n`, "utf8");
  }

  public logInboxLogItems(itemsBySubscription: Map<string, MotherInboxItem[]>): void {
    for (const [subscriptionId, items] of itemsBySubscription.entries()) {
      for (const item of items) {
        if (!(item.item === "log" || item.action === "log")) {
          continue;
        }

        const message = extractInboxLogMessage(item);
        if (!message) {
          continue;
        }

        this.log({
          phase: "inbox_log_item",
          message,
        });
      }
    }
  }
}

function shouldLogResponseBody(pathname: string): boolean {
  return !pathname.startsWith("/v1/inbox");
}

function shouldTraceRequest(method: string, pathname: string): boolean {
  return !(method === "DELETE" && pathname.startsWith("/v1/inbox"));
}

function withTimezone(
  settings: Record<string, unknown>,
  timezone: string,
): Record<string, unknown> {
  return {
    ...settings,
    timezone: settings.timezone ?? timezone,
  };
}

function extractSubscriptionId(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }

  if (!raw || typeof raw !== "object") {
    throw new Error("Mother create subscription response is invalid.");
  }

  const candidateKeys = ["subscription_id", "subscriptionId", "id"];
  for (const key of candidateKeys) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  throw new Error("Mother create subscription response did not include a subscription ID.");
}

function parseSubscriptionResponse(
  fallbackSubscriptionId: string,
  raw: unknown,
): MotherSubscriptionResponse {
  const object = asObject(raw);

  return {
    subscriptionId:
      asOptionalString(object.subscription_id) ??
      asOptionalString(object.subscriptionId) ??
      asOptionalString(object.id) ??
      fallbackSubscriptionId,
    metadata:
      asOptionalObject(object.subscription) ??
      asOptionalObject(object.metadata) ??
      object,
    fields: asOptionalArray(object.fields) ?? [],
    status:
      asOptionalObject(object.status) ??
      pickObject(object, ["inactive", "interval", "next_delivery", "limit", "theater"]),
  };
}

function extractInboxItems(raw: unknown): MotherInboxItem[] {
  if (Array.isArray(raw)) {
    return raw.filter(isObject).map(normalizeInboxItem);
  }

  if (!isObject(raw)) {
    return [];
  }

  const candidate = raw.items ?? raw.inbox ?? raw.results;
  if (Array.isArray(candidate)) {
    return candidate.filter(isObject).map(normalizeInboxItem);
  }

  return [];
}

function extractInboxItemsBySubscription(
  raw: unknown,
  subscriptionIds: string[],
): Map<string, MotherInboxItem[]> {
  const empty = new Map<string, MotherInboxItem[]>();
  for (const subscriptionId of subscriptionIds) {
    empty.set(subscriptionId, []);
  }

  if (Array.isArray(raw) || !isObject(raw)) {
    const items = extractInboxItems(raw);
    if (subscriptionIds.length === 1) {
      empty.set(subscriptionIds[0], items);
      return empty;
    }

    for (const item of items) {
      const subscriptionId = item.subscription_id;
      if (!subscriptionId || !empty.has(subscriptionId)) {
        continue;
      }
      empty.get(subscriptionId)?.push(item);
    }
    return empty;
  }

  for (const subscriptionId of subscriptionIds) {
    const scopedRaw = raw[subscriptionId];
    if (scopedRaw === undefined) {
      continue;
    }

    empty.set(subscriptionId, extractInboxItems(scopedRaw));
  }

  return empty;
}

function extractInboxLogMessage(item: MotherInboxItem): string | null {
  if (item.data && typeof item.data === "object") {
    const message = (item.data as Record<string, unknown>).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  if (item.payload && typeof item.payload === "object") {
    const message = (item.payload as Record<string, unknown>).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  if (item.raw && typeof item.raw === "object") {
    const message = (item.raw as Record<string, unknown>).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return null;
}

function normalizeInboxItem(value: Record<string, unknown>): MotherInboxItem {
  return {
    ...value,
    id:
      asOptionalString(value.ID) ??
      asOptionalString(value.id) ??
      asOptionalString(value.inbox_id) ??
      "",
    subscription_id:
      asOptionalString(value.subscription_id) ?? asOptionalString(value.subscriptionId),
    item: asOptionalString(value.item),
    action: asOptionalString(value.action),
    theater: asOptionalString(value.theater),
    data: value.data,
    raw: value.raw,
  };
}

function pickObject(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) {
      output[key] = source[key];
    }
  }
  return output;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error("Expected object response from Mother.");
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalObject(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function asOptionalArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
