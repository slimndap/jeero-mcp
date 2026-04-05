import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface JeeroConfig {
  motherBaseUrl: string;
  dataDir: string;
  databasePath: string;
  siteIdentityPath: string;
  siteIdentifier: string;
  noOfItemsPerPickup?: number;
  defaultTimezone: string;
}

interface SiteIdentityFile {
  siteKey: string;
  siteIdentifier: string;
  createdAt: string;
}

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".jeero-mcp");
const DEFAULT_MOTHER_BASE_URL = "https://api.jeero.ooo";

export function ensureDataDir(dataDir = process.env.JEERO_DATA_DIR ?? DEFAULT_DATA_DIR): string {
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

export function normalizeSiteIdentifier(value: string): string {
  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value) ? value : `http://${value}`;
  const url = new URL(candidate);
  const normalized = `${url.host}${url.pathname}`.replace(/\/+$/, "");
  return normalized || url.host;
}

export function loadConfig(): JeeroConfig {
  const motherBaseUrl = process.env.JEERO_MOTHER_BASE_URL?.trim() || DEFAULT_MOTHER_BASE_URL;

  const dataDir = ensureDataDir();
  const siteIdentifier = normalizeSiteIdentifier(
    process.env.JEERO_SITE_URL?.trim() || os.hostname(),
  );

  return {
    motherBaseUrl: motherBaseUrl.replace(/\/+$/, ""),
    dataDir,
    databasePath: path.join(dataDir, "jeero.sqlite"),
    siteIdentityPath: path.join(dataDir, "site-identity.json"),
    siteIdentifier,
    noOfItemsPerPickup: process.env.JEERO_NO_OF_ITEMS_PER_PICKUP
      ? Number(process.env.JEERO_NO_OF_ITEMS_PER_PICKUP)
      : undefined,
    defaultTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

export function loadOrCreateSiteIdentity(config: JeeroConfig): SiteIdentityFile {
  if (fs.existsSync(config.siteIdentityPath)) {
    const parsed = JSON.parse(fs.readFileSync(config.siteIdentityPath, "utf8")) as SiteIdentityFile;
    return {
      ...parsed,
      siteIdentifier: normalizeSiteIdentifier(parsed.siteIdentifier),
    };
  }

  const identity: SiteIdentityFile = {
    siteKey: crypto.randomUUID(),
    siteIdentifier: config.siteIdentifier,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(config.siteIdentityPath, JSON.stringify(identity, null, 2));
  return identity;
}
