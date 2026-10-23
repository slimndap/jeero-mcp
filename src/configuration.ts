import { randomBytes, randomInt } from "node:crypto";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { SubscriptionEnvelope } from "./types.js";
import { configurationLogo } from "./configuration-logo.js";

interface ConfigurationBackend {
  getSubscriptionEnvelope(key?: string): Promise<SubscriptionEnvelope>;
  updateSubscription(key: string | undefined, settings: Record<string, unknown>): Promise<SubscriptionEnvelope>;
}

interface Session {
  key: string;
  code: string;
  cookie: string;
  csrf: string;
  expires: number;
  attempts: number;
  saved: boolean;
  busy: boolean;
}

export class ConfigurationScreen {
  private server?: Server;
  private starting?: Promise<void>;
  private origin = "";
  private readonly sessions = new Map<string, Session>();

  public constructor(private readonly backend: ConfigurationBackend) {}

  public async open(key: string): Promise<{ url: string; access_code: string; expires_at: string }> {
    if (!this.starting) this.starting = this.start();
    await this.starting;
    for (const [id, session] of this.sessions) {
      if (session.expires <= Date.now()) this.sessions.delete(id);
    }
    const id = randomBytes(24).toString("hex");
    const session: Session = { key, code: String(randomInt(10000000, 100000000)),
      cookie: randomBytes(32).toString("hex"), csrf: randomBytes(32).toString("hex"),
      expires: Date.now() + 15 * 60_000, attempts: 0, saved: false, busy: false };
    this.sessions.set(id, session);
    return { url: `${this.origin}/configure/${id}`, access_code: session.code,
      expires_at: new Date(session.expires).toISOString() };
  }

  public isSaved(url: string): boolean {
    return this.sessions.get(url.split("/").pop() ?? "")?.saved ?? false;
  }

  public resume(key: string, url: unknown): { url: string; access_code: string; expires_at: string } | undefined {
    if (typeof url !== "string" || !url.startsWith(`${this.origin}/configure/`)) return;
    const id = url.slice(`${this.origin}/configure/`.length);
    if (!/^[a-f0-9]{48}$/.test(id)) return;
    const session = this.sessions.get(id);
    if (!session || session.key !== key || session.expires <= Date.now() || session.attempts >= 5) return;
    return { url, access_code: session.code, expires_at: new Date(session.expires).toISOString() };
  }

  public close(): void {
    this.server?.close();
    this.server?.closeAllConnections();
    this.sessions.clear();
  }

  private async start(): Promise<void> {
    const server = createServer((req, res) => { void this.handle(req, res); });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Configuration screen unavailable.");
    this.origin = `http://127.0.0.1:${address.port}`;
    server.unref();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    // no-referrer makes browsers send Origin: null on form POSTs, breaking origin checks.
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const fail = (status: number, message: string) => { res.writeHead(status); res.end(page(message)); };
    try {
      if (req.headers.host !== new URL(this.origin).host || (req.method === "POST" && req.headers["sec-fetch-site"] === "cross-site")) {
        return fail(403, "Open the configuration link directly from your chat app.");
      }
      const match = /^\/configure\/([a-f0-9]{48})$/.exec(req.url ?? "");
      const id = match?.[1];
      const session = id ? this.sessions.get(id) : undefined;
      if (!session || session.expires <= Date.now() || session.attempts >= 5) {
        if (id) this.sessions.delete(id);
        return fail(410, "This link has expired. Request a new configuration link in your chat app.");
      }
      const authenticated = (req.headers.cookie ?? "").split("; ").includes(`jeero_${id}=${session.cookie}`);
      if (req.method !== "GET" && req.method !== "POST") return fail(405, "Method not allowed.");
      let form: URLSearchParams | undefined;
      if (req.method === "POST") {
        if (req.headers.origin !== this.origin || req.headers["content-type"] !== "application/x-www-form-urlencoded") {
          return fail(403, "Invalid form origin.");
        }
        let body = "";
        for await (const chunk of req) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 65536) return fail(413, "Form is too large.");
        }
        form = new URLSearchParams(body);
      }
      if (!authenticated) {
        if (form) {
          session.attempts++;
          if (form.get("access_code") !== session.code) return fail(403, "Incorrect access code. Open the link again to retry.");
          res.setHeader("Set-Cookie", `jeero_${id}=${session.cookie}; HttpOnly; SameSite=Strict; Path=/configure/${id}; Max-Age=900`);
          res.writeHead(303, { Location: req.url! });
          return void res.end();
        }
        return void res.end(page(`<h1>Connect Jeero</h1><p>Enter the access code shown in your chat app. Keep this browser page private; do not ask your agent to inspect it.</p>
          <form method="post"><label>Access code<input name="access_code" inputmode="numeric" autocomplete="off" required autofocus></label><button>Continue</button></form>`));
      }
      if (session.busy) return fail(409, "A save is already in progress. Please wait and reload.");
      if (form && form.get("csrf") !== session.csrf) return fail(403, "Invalid form. Reload this page.");
      session.busy = true;
      try {
        let envelope = await this.backend.getSubscriptionEnvelope(session.key);
        if (form) {
          const settings = readSettings(envelope, form);
          envelope = await this.backend.updateSubscription(session.key, settings);
          session.saved = true;
        }
        res.end(render(envelope, session, Boolean(form)));
      } finally {
        session.busy = false;
      }
    } catch {
      fail(502, "Configuration could not be loaded or saved. Your keys are not shown here. Reload this page and try again.");
    }
  }
}

function fields(envelope: SubscriptionEnvelope): Array<Record<string, unknown>> {
  return envelope.fields.filter((field): field is Record<string, unknown> =>
    Boolean(field) && typeof field === "object" && !Array.isArray(field) && typeof (field as Record<string, unknown>).name === "string");
}

function choices(field: Record<string, unknown>): Array<[string, string]> {
  return field.choices && typeof field.choices === "object" && !Array.isArray(field.choices)
    ? Object.entries(field.choices).map(([key, label]) => [key, String(label)]) : [];
}

function privateField(field: Record<string, unknown>): boolean {
  return field.type === "password" || /key|token|secret|password|credential/i.test(String(field.name));
}

function readSettings(envelope: SubscriptionEnvelope, form: URLSearchParams): Record<string, unknown> {
  const settings: Record<string, unknown> = Object.create(null);
  for (const field of fields(envelope)) {
    const name = String(field.name);
    const options = choices(field);
    const values = form.getAll(`setting:${name}`);
    if (["tab", "message", "error"].includes(String(field.type))) continue;
    if (field.type === "checkbox") settings[name] = values;
    else if (values.length === 1) {
      if (privateField(field) && values[0] === "" && envelope.settings[name]) continue;
      settings[name] = field.type === "number" && values[0] !== "" ? Number(values[0]) : values[0];
      if (field.type === "number" && values[0] !== "" && !Number.isFinite(settings[name])) throw new Error("Invalid number.");
    } else {
      if ((field.required === true || field.required === 1 || field.required === "1") && !envelope.settings[name]) {
        throw new Error("Required field missing.");
      }
      continue;
    }
    if ((field.type === "checkbox" || field.type === "select") &&
      values.some((value) => !options.some(([key]) => key === value))) throw new Error("Invalid choice.");
    if ((field.required === true || field.required === 1 || field.required === "1") &&
      (settings[name] === "" || (Array.isArray(settings[name]) && values.length === 0))) throw new Error("Required field missing.");
  }
  return settings;
}

function render(envelope: SubscriptionEnvelope, session: Session, saved: boolean): string {
  const controls = fields(envelope).map((field, index) => {
    const name = String(field.name);
    const label = escape(field.label ?? name);
    const value = envelope.settings[name] ?? field.default_value ?? "";
    const options = choices(field);
    if (field.type === "tab") return `<h2>${label}</h2>`;
    if (field.type === "error" || field.type === "message") return `<p>${escape(field.value ?? field.message ?? field.label ?? "")}</p>`;
    const required = field.required === true || field.required === 1 || field.required === "1";
    const attributes = `id="f${index}" name="setting:${escape(name)}"${required && !(privateField(field) && value) ? " required" : ""}`;
    const help = field.instructions ? `<small>${escape(field.instructions)}</small>` : "";
    if (field.type === "checkbox") {
      const selected = Array.isArray(value) ? value.map(String) : [String(value)];
      return `<fieldset><legend>${label}</legend>${options.map(([key, title]) => `<label class="choice"><input type="checkbox" name="setting:${escape(name)}" value="${escape(key)}"${selected.includes(key) ? " checked" : ""}>${escape(title)}</label>`).join("")}${help}</fieldset>`;
    }
    let control: string;
    if (field.type === "select") control = `<select ${attributes}>${options.map(([key, title]) => `<option value="${escape(key)}"${String(value) === key ? " selected" : ""}>${escape(title)}</option>`).join("")}</select>`;
    else if (field.type === "textarea") control = `<textarea ${attributes}>${escape(value)}</textarea>`;
    else control = `<input ${attributes} type="${privateField(field) ? "password" : field.type === "number" ? "number" : field.type === "url" ? "url" : "text"}" autocomplete="off" value="${privateField(field) ? "" : escape(value)}"${privateField(field) && value ? ' placeholder="Already saved — leave empty to keep"' : ""}>`;
    return `<label for="f${index}">${label}${control}${help}</label>`;
  }).join("");
  return page(`<h1>${escape(envelope.label)}</h1><p>Configure your ticketing connection here. Keys go directly to Jeero and Mother, outside your chat.</p>
    ${saved ? '<p role="status">Settings saved. You can continue configuring below or return to your chat and ask Jeero to check the connection.</p>' : ""}
    <form method="post"><input type="hidden" name="csrf" value="${session.csrf}">${controls}<button>Save and continue</button></form>`);
}

function escape(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jeero configuration</title>
    <style>
      *{box-sizing:border-box}body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#fff;color:#212529;margin:0}
      header{background:#e8433f;overflow:hidden}.brand{max-width:960px;margin:auto;position:relative;height:88px;display:flex;align-items:center;padding:0 24px 0 184px;color:white;font-size:24px}
      .brand:before{content:"";position:absolute;width:112px;height:180px;top:-46px;left:20px;transform:rotate(-45deg);background:#ffd730}
      .brand svg{position:absolute;width:84px;height:64px;left:36px;top:12px;transform:rotate(35deg)}.brand span{position:relative}
      main{max-width:768px;margin:40px auto;padding:0 24px}h1{font-size:clamp(28px,5vw,40px);line-height:1.15;letter-spacing:-.025em;margin:0 0 20px;overflow-wrap:anywhere}h2{font-size:24px;margin:28px 0 16px}
      p{margin:0 0 24px}.eyebrow{color:#6c757d;font-size:14px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin-bottom:12px}
      form{border:1px solid #dee2e6;border-radius:8px;padding:24px;margin-top:28px;box-shadow:0 2px 4px #2125290d}
      label,small{display:block}label,fieldset{margin:0 0 20px}label,legend{font-weight:600}fieldset{padding:0;border:0;min-width:0}legend{padding:0;margin-bottom:8px}
      input,select,textarea,button{font:inherit;box-sizing:border-box;border:1px solid #adb5bd;border-radius:8px;width:100%;min-height:48px;padding:10px 14px}
      input,select,textarea{display:block;background:#fff;color:#212529;margin-top:8px}textarea{min-height:120px;resize:vertical}input::placeholder{color:#6c757d;opacity:1}
      input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible{outline:3px solid #212529;outline-offset:3px}
      input[type=checkbox]{width:20px;height:20px;min-height:0;margin:2px 0 0;accent-color:#b92f2c;flex:none}.choice{display:flex;align-items:flex-start;gap:10px;margin:12px 0;font-weight:400}
      small{font-size:14px;font-weight:400;color:#626970;margin-top:8px;overflow-wrap:anywhere}button{background:#0d6efd;border-color:#0d6efd;color:white;cursor:pointer;font-weight:600}button:hover{background:#0b5ed7;border-color:#0b5ed7}
      [role=status]{padding:16px 20px;border:1px solid #a3cfbb;border-radius:8px;background:#d1e7dd;color:#0a3622}
      footer{max-width:768px;margin:0 auto;padding:0 24px 32px;color:#626970;font-size:14px}
      @media(max-width:600px){.brand{height:80px;padding-left:168px}.brand svg{left:28px}.brand:before{left:12px}main{margin:32px auto}form{padding:20px;margin-top:24px}}
    </style></head><body><header><div class="brand">${configurationLogo}<span>Jeero</span></div></header><main><p class="eyebrow">Ticketing connection</p>${body}</main><footer>Jeero · A service by Slim &amp; Dapper</footer></body></html>`;
}
