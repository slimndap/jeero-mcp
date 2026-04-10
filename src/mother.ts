import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

export interface CachedImageResult {
  filePath: string;
  mimeType: string;
  sizeBytes: number;
  sourceUrl: string;
  cached: boolean;
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

  public async cacheEventImage(imageUrl: string): Promise<CachedImageResult> {
    const normalizedUrl = new URL(imageUrl).toString();
    fs.mkdirSync(this.config.imageCacheDir, { recursive: true });

    const cacheKey = crypto.createHash("sha256").update(normalizedUrl).digest("hex");
    const existingPath = findExistingCachedImagePath(this.config.imageCacheDir, cacheKey);
    if (existingPath) {
      const stats = fs.statSync(existingPath);
      return {
        filePath: existingPath,
        mimeType: inferMimeTypeFromPath(existingPath) ?? "application/octet-stream",
        sizeBytes: stats.size,
        sourceUrl: normalizedUrl,
        cached: true,
      };
    }

    const response = await fetch(normalizedUrl, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(
        `Event image request failed (${response.status} ${response.statusText}) for ${normalizedUrl}.`,
      );
    }

    const mimeType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!mimeType.startsWith("image/")) {
      throw new Error(`Event image URL did not return an image content type: ${mimeType || "unknown"}.`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const maxBytes = 10 * 1024 * 1024;
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Event image exceeds the 10 MB limit (${buffer.byteLength} bytes).`);
    }

    const extension = extensionForMimeType(mimeType);
    const localPath = path.join(this.config.imageCacheDir, `${cacheKey}${extension}`);
    fs.writeFileSync(localPath, buffer);

    return {
      filePath: localPath,
      mimeType,
      sizeBytes: buffer.byteLength,
      sourceUrl: normalizedUrl,
      cached: false,
    };
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

    this.traceLogger?.log({
      phase: "request",
      method,
      url,
      headers,
      body: requestBody,
    });

    const response = await fetch(url, {
      method,
      headers,
      body: requestBody,
    });

    const responseBody = await response.clone().text();
    this.traceLogger?.log({
      phase: "response",
      method,
      url,
      status: response.status,
      statusText: response.statusText,
      body: shouldLogResponseBody(pathname) ? responseBody : "[omitted]",
    });

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
}

function shouldLogResponseBody(pathname: string): boolean {
  return !pathname.startsWith("/v1/inbox");
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

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/svg+xml":
      return ".svg";
    case "image/avif":
      return ".avif";
    default:
      return ".img";
  }
}

function inferMimeTypeFromPath(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".avif":
      return "image/avif";
    default:
      return null;
  }
}

function findExistingCachedImagePath(cacheDir: string, cacheKey: string): string | null {
  const entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  const match = entries.find((entry) => entry.isFile() && entry.name.startsWith(`${cacheKey}.`));
  return match ? path.join(cacheDir, match.name) : null;
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
