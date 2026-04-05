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

export class MotherClient {
  public constructor(
    private readonly config: JeeroConfig,
    private readonly siteKey: string,
    private readonly siteIdentifier: string,
  ) {}

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
    const headers: Record<string, string> = {};
    if (this.config.noOfItemsPerPickup) {
      headers["no_of_items_per_pickup"] = String(this.config.noOfItemsPerPickup);
    }

    const response = await this.request(
      "POST",
      "/v1/inbox/big",
      {
        [subscriptionId]: withTimezone(settings, this.config.defaultTimezone),
      },
      headers,
    );
    const raw = await response.json();
    return extractInboxItems(raw);
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
    const response = await fetch(`${this.config.motherBaseUrl}${pathname}`, {
      method,
      headers: {
        site_key: this.siteKey,
        site_url: this.siteIdentifier,
        ...extraHeaders,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Mother request failed (${response.status} ${response.statusText}): ${text}`);
    }

    return response;
  }
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
