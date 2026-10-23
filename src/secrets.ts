// All free-text settings stay private, including connectors that call a key simply "token" or "url".
export class SecretRedactor {
  private readonly values = new Set<string>();

  public remember(value: unknown): void {
    if (typeof value === "string" && value) {
      for (const variant of [value, encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2),
        JSON.stringify(value).slice(1, -1), Buffer.from(value).toString("base64")]) {
        this.values.add(variant);
      }
    } else if (Array.isArray(value)) {
      // Form arrays contain checkbox choices, not free-text credentials.
      value.filter((item) => item && typeof item === "object").forEach((item) => this.remember(item));
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key !== "theater" && key !== "timezone") this.remember(item);
      }
    }
  }

  public clean<T>(value: T): T {
    const secrets = [...this.values].sort((a, b) => b.length - a.length);
    const clean = (item: unknown): unknown => {
      if (typeof item === "string") {
        for (const secret of secrets) {
          item = (item as string).split(secret).join("[REDACTED]");
        }
        return (item as string).replace(
          /((?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token|token|site[_-]?key)["']?\s*[:=]\s*["']?)[^&\s"'<>,}]+/gi,
          "$1[REDACTED]",
        ).replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, "$1 [REDACTED]");
      }
      if (Array.isArray(item)) return item.map(clean);
      if (item && typeof item === "object") {
        return Object.fromEntries(Object.entries(item).map(([key, entry]) => [
          clean(key), /api.?key|password|secret|token|authorization|credential|site_key/i.test(key)
            ? "[REDACTED]" : clean(entry),
        ]));
      }
      return item;
    };
    return clean(value) as T;
  }
}
