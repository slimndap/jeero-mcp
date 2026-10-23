import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { ConfigurationScreen } from "../dist/configuration.js";
import { JeeroDatabase } from "../dist/db.js";
import { SecretRedactor } from "../dist/secrets.js";

const OLD_KEY = "old-private-key-with-special-&/characters";
const NEW_KEY = "new-private-key-with-special-&/characters";
const OPAQUE_KEY = "password-with-an-unrecognisable-field-name";

async function fixture(t, { modern = false, urlSupport = false, onElicitation } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "jeero-private-"));
  const state = { updates: [], fail: false, failUpdate: false, invalidJson: false, logs: false };
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (state.fail || (state.failUpdate && req.method === "POST" && url.pathname === "/v1/subscriptions/mother-private")) {
      res.writeHead(403); return res.end(`Denied ${OLD_KEY} ${NEW_KEY} ${OPAQUE_KEY}`);
    }
    if (state.invalidJson) return res.end(`invalid JSON with ${NEW_KEY}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && url.pathname === "/v1/subscriptions") return res.end(JSON.stringify("mother-private"));
    if (req.method === "POST" && url.pathname === "/v1/subscriptions/mother-private") {
      let body = "";
      for await (const chunk of req) body += chunk;
      state.updates.push(JSON.parse(body).settings);
      return res.end("{}");
    }
    if (url.pathname === "/v1/inbox/big") {
      return res.end(JSON.stringify({ "mother-private": state.logs ? [{ id: "log-private", item: "log", data: {
        message: `Unexpected ${OLD_KEY} / ${encodeURIComponent(NEW_KEY)} / ${OPAQUE_KEY}`,
      } }] : [] }));
    }
    if (req.method === "DELETE") return res.end("{}");
    const settings = JSON.parse(url.searchParams.get("settings") ?? "{}");
    const fields = [{ name: "theater", label: "Ticketing solution", type: "select", choices: { "": "Choose", stager: "Stager" }, required: "1" }];
    if (settings.theater) fields.push(
      { name: "token", label: "API key", type: "text", required: true, value: OLD_KEY },
      { name: "opaque", label: "Connection credential", type: "password", required: true },
      { name: "max_events", label: "Maximum events", type: "number" },
      { name: "categories", label: "Categories", type: "checkbox", choices: { music: "Music", theatre: "Theatre", "1": "Other" } },
    );
    res.end(JSON.stringify({ subscription_id: "mother-private", subscription: { settings, token: OLD_KEY, cached_token: "generated-upstream-secret" }, fields }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const child = spawn(process.execPath, ["dist/index.js"], { cwd: process.cwd(), env: { ...process.env,
    JEERO_DATA_DIR: dataDir, JEERO_MOTHER_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, JEERO_LOG_MOTHER: "true",
  }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const pending = new Map();
  const transcript = [];
  const requests = [];
  let nextId = 1;
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  createInterface({ input: child.stdout }).on("line", async (line) => {
    const message = JSON.parse(line);
    transcript.push(message);
    if (message.method === "elicitation/create") {
      requests.push(message);
      try {
        const result = onElicitation ? await onElicitation(message.params) : { action: "cancel" };
        send({ id: message.id, result });
      } catch {
        send({ id: message.id, error: { code: -32603, message: "Client does not render URL elicitation" } });
      }
    } else if (pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const capabilities = urlSupport ? { elicitation: { url: {} } } : {};
  async function rpc(method, params = {}) {
    const id = nextId++;
    if (modern) params = { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "private-config-test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": capabilities,
    } };
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out on ${method}; stderr: ${stderr}`)), 5000);
      pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    });
    send({ id, method, params });
    return result;
  }
  t.after(async () => {
    const exit = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exit;
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  if (modern) {
    const response = await rpc("server/discover");
    assert.equal(response.error, undefined, JSON.stringify(response));
  } else {
    const response = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities,
      clientInfo: { name: "private-config-test", version: "1" } });
    assert.equal(response.error, undefined);
    send({ method: "notifications/initialized" });
  }
  const call = (name, args = {}, extra = {}) => rpc("tools/call", { name, arguments: args, ...extra });
  return { state, call, transcript, requests, dataDir, getStderr: () => stderr };
}

async function login(link) {
  const origin = new URL(link.url).origin;
  const response = await fetch(link.url, { method: "POST", redirect: "manual", headers: {
    origin, "content-type": "application/x-www-form-urlencoded",
  }, body: new URLSearchParams({ access_code: link.access_code }) });
  assert.equal(response.status, 303);
  return response.headers.get("set-cookie").split(";")[0];
}

async function save(link, cookie, settings) {
  const page = await fetch(link.url, { headers: { cookie } });
  const html = await page.text();
  const csrf = /name="csrf" value="([a-f0-9]+)"/.exec(html)?.[1];
  assert.ok(csrf, html);
  const body = new URLSearchParams({ csrf });
  for (const [key, value] of Object.entries(settings)) {
    for (const entry of Array.isArray(value) ? value : [value]) body.append(`setting:${key}`, entry);
  }
  return fetch(link.url, { method: "POST", headers: { cookie,
    origin: new URL(link.url).origin, "content-type": "application/x-www-form-urlencoded",
  }, body });
}

function assertPrivate(value) {
  const text = JSON.stringify(value);
  for (const key of [OLD_KEY, NEW_KEY, OPAQUE_KEY, "generated-upstream-secret", encodeURIComponent(NEW_KEY)]) {
    assert.ok(!text.includes(key), `Secret appeared in output: ${key}`);
  }
}

test("manual configuration saves outside MCP and keeps answers, logs and failures private", async (t) => {
  const f = await fixture(t);
  const created = await f.call("create_subscription", { subscription_key: "private", label: "Private test" });
  assert.equal(created.result.isError, undefined);
  assertPrivate(created);
  assert.equal(created.result.structuredContent.settings, undefined);
  const response = await f.call("config_subscription");
  const link = response.result.structuredContent;
  assert.match(link.url, /^http:\/\/127\.0\.0\.1:\d+\/configure\//);
  assert.equal(f.requests.length, 0);
  const initial = await fetch(link.url, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(initial.status, 200);
  assert.match(await initial.text(), /Access code/);
  const cookie = await login(link);
  assert.equal((await save(link, cookie, { theater: "stager" })).status, 200);
  assert.equal((await save(link, cookie, { theater: "stager", token: OLD_KEY, opaque: OPAQUE_KEY, categories: ["music"] })).status, 200);
  const savedPage = await save(link, cookie, { theater: "stager", token: NEW_KEY, opaque: "", categories: ["1"], max_events: "" });
  assert.equal(savedPage.status, 200);
  const html = await savedPage.text();
  assert.ok(!html.includes(NEW_KEY));
  assert.match(html, /Already saved/);
  assert.equal(f.state.updates.at(-1).token, NEW_KEY);
  assert.equal(f.state.updates.at(-1).opaque, OPAQUE_KEY);
  assert.deepEqual(f.state.updates.at(-1).categories, ["1"]);
  assert.equal((await f.call("config_subscription")).result.structuredContent.url.startsWith("http://127.0.0.1:"), true);
  const summary = await f.call("get_subscription");
  assert.equal(summary.result.structuredContent.configuration_complete, true);
  assert.equal(summary.result.structuredContent.connection_errors, 0);
  assert.ok(summary.result.structuredContent.configured_fields.includes("token"));
  assertPrivate(summary);
  f.state.failUpdate = true;
  const failedSave = await save(link, cookie, { theater: "stager", token: "rejected-replacement-key", opaque: "" });
  assert.equal(failedSave.status, 502);
  assertPrivate(await failedSave.text());
  f.state.failUpdate = false;
  const db = new JeeroDatabase(path.join(f.dataDir, "jeero.sqlite"));
  assert.equal(db.getDefaultSubscription().settings.token, NEW_KEY);
  db.upsertEvent("private", { ref: "private-event", start: "2026-10-24 20:00", production: {
    title: "Test production", description: `Echo ${NEW_KEY}`,
  }, tickets: { url: `https://tickets.example/?token=${encodeURIComponent(NEW_KEY)}` }, custom: { api_key: "generated-upstream-secret" } });
  db.close();
  assertPrivate(await f.call("get_event", { ref: "private-event", subscription: "private" }));
  assertPrivate(await f.call("get_events"));
  f.state.logs = true;
  await f.call("sync_subscription", { subscription: "private", force: true });
  const logs = await f.call("get_logs");
  assertPrivate(logs);
  assert.match(JSON.stringify(logs), /REDACTED/);
  f.state.fail = true;
  assert.equal((await f.call("get_subscription")).result.isError, true);
  assert.equal((await f.call("sync_subscription", { subscription: "private", force: true })).result.isError, true);
  f.state.fail = false;
  assertPrivate(await f.call("list_subscriptions"));
  f.state.invalidJson = true;
  assert.equal((await f.call("get_subscription")).result.isError, true);
  assertPrivate(f.transcript);
  assertPrivate(f.getStderr());
  const trace = await readFile(path.join(f.dataDir, "mother-trace.log"), "utf8");
  assertPrivate(trace);
  assert.ok(!trace.includes("settings="));
  const rejected = await f.call("config_subscription", { settings: { token: NEW_KEY } });
  assertPrivate(rejected);
  assert.ok(rejected.result?.isError || rejected.error);
});

test("legacy URL elicitation and a broken client both retain a usable manual link", async (t) => {
  const f = await fixture(t, { urlSupport: true, onElicitation: async () => { throw new Error("unsupported UI"); } });
  await f.call("create_subscription", { subscription_key: "private", label: "Private test" });
  const response = await f.call("config_subscription");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].params.mode, "url");
  assert.equal(f.requests[0].params.url, response.result.structuredContent.url);
  assert.match(f.requests[0].params.message, new RegExp(response.result.structuredContent.access_code));
  assert.equal((await fetch(response.result.structuredContent.url)).status, 200);
});

test("legacy URL elicitation reports the browser save without returning its keys", async (t) => {
  const f = await fixture(t, { urlSupport: true, onElicitation: async (params) => {
    const link = { url: params.url, access_code: /access code (\d+)/.exec(params.message)[1] };
    const cookie = await login(link);
    await save(link, cookie, { theater: "stager" });
    await save(link, cookie, { theater: "stager", token: NEW_KEY, opaque: OPAQUE_KEY });
    return { action: "accept" };
  } });
  await f.call("create_subscription", { subscription_key: "private", label: "Private test" });
  const response = await f.call("config_subscription");
  assert.equal(response.result.structuredContent.saved, true);
  assertPrivate(f.transcript);
});

test("modern URL elicitation resumes the same screen and does not repeat setup on retry", async (t) => {
  const f = await fixture(t, { modern: true, urlSupport: true });
  await f.call("create_subscription", { subscription_key: "private", label: "Private test" });
  const response = await f.call("config_subscription", { settings: { theater: "stager" } });
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.equal(response.result.resultType, "input_required", JSON.stringify(response));
  const request = response.result.inputRequests.configure;
  assert.equal(request.params.mode, "url");
  const link = { url: request.params.url, access_code: /access code (\d+)/.exec(request.params.message)[1] };
  const cookie = await login(link);
  await save(link, cookie, { theater: "stager", token: NEW_KEY, opaque: OPAQUE_KEY });
  const updateCount = f.state.updates.length;
  const resumed = await f.call("config_subscription", { settings: { theater: "stager" } }, {
    requestState: response.result.requestState, inputResponses: { configure: { action: "accept" } },
  });
  assert.equal(resumed.result.structuredContent.url, link.url);
  assert.equal(resumed.result.structuredContent.saved, true);
  assert.equal(f.state.updates.length, updateCount);
  const manual = await f.call("config_subscription", { manual: true });
  assert.equal(manual.result.resultType, "complete");
  assert.ok(manual.result.structuredContent.url);
  assertPrivate(f.transcript);
});

test("redaction covers encoded credentials, structured secret fields and upstream authorization messages", () => {
  const secrets = new SecretRedactor();
  secrets.remember({ theater: "stager", token: NEW_KEY, categories: ["1", "music"] });
  const output = secrets.clean({ token: "unknown-generated-key", log: `${NEW_KEY} ${encodeURIComponent(NEW_KEY)} password=unknown-password Bearer unknown-bearer`,
    url: "http://127.0.0.1:1234/configure/session", count: 1, category: "music" });
  assertPrivate(output);
  assert.ok(!JSON.stringify(output).includes("unknown-"));
  assert.equal(output.url, "http://127.0.0.1:1234/configure/session");
  assert.equal(output.category, "music");
  assert.equal(output.count, 1);
});

test("screen rejects wrong codes, CSRF, foreign origins, invalid choices, oversize and expired sessions", async (t) => {
  const f = await fixture(t);
  await f.call("create_subscription", { subscription_key: "private", label: "Private test" });
  const link = (await f.call("config_subscription")).result.structuredContent;
  const origin = new URL(link.url).origin;
  const rebindingStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(link.url, { headers: { host: "attacker.example" } }, (response) => {
      response.resume(); resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(rebindingStatus, 403);
  const invalid = await fetch(link.url, { method: "POST", headers: {
    origin: "https://attacker.example", "content-type": "application/x-www-form-urlencoded",
  }, body: new URLSearchParams({ access_code: link.access_code }) });
  assert.equal(invalid.status, 403);
  const cookie = await login(link);
  assert.equal((await fetch(link.url, { method: "POST", headers: { origin, cookie,
    "content-type": "application/x-www-form-urlencoded" }, body: "csrf=invalid" })).status, 403);
  assert.equal((await save(link, cookie, { theater: "attacker" })).status, 502);
  assert.equal(f.state.updates.length, 0);
  assert.equal((await fetch(link.url, { method: "POST", headers: { origin, cookie,
    "content-type": "application/x-www-form-urlencoded" }, body: "x=" + "a".repeat(65537) })).status, 413);
  const response = await fetch(link.url, { headers: { cookie } });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "same-origin");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const locked = (await f.call("config_subscription")).result.structuredContent;
  for (let i = 0; i < 5; i++) {
    assert.equal((await fetch(locked.url, { method: "POST", headers: { origin,
      "content-type": "application/x-www-form-urlencoded" }, body: "access_code=wrong" })).status, 403);
  }
  assert.equal((await fetch(locked.url)).status, 410);
  const now = Date.now;
  const screen = new ConfigurationScreen({});
  t.after(() => screen.close());
  const expired = await screen.open("private");
  try {
    Date.now = () => now() + 16 * 60_000;
    assert.equal((await fetch(expired.url)).status, 410);
  } finally { Date.now = now; }
});

test("existing stored keys are private immediately after a server restart", async (t) => {
  const f = await fixture(t);
  await f.call("create_subscription", { subscription_key: "private", label: "Private test" });
  const db = new JeeroDatabase(path.join(f.dataDir, "jeero.sqlite"));
  t.after(() => db.close());
  // Seed a legacy log before starting a second client against the same saved subscription.
  db.updateSubscription({ subscriptionKey: "private", settings: { theater: "stager", token: OLD_KEY } });
  db.upsertLog({ inboxId: "legacy-log", subscriptionKey: "private", subscriptionId: "mother-private", action: "log", message: `Legacy ${OLD_KEY}` });
  // A fresh fixture process would have its own directory: verify startup through a separate raw client below.
  const child = spawn(process.execPath, ["dist/index.js"], { env: { ...process.env, JEERO_DATA_DIR: f.dataDir }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill("SIGTERM"));
  const lines = createInterface({ input: child.stdout });
  const messages = [];
  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Restart test timed out")), 5000);
    lines.on("line", (line) => {
      const response = JSON.parse(line);
      messages.push(response);
      if (response.id === 1) {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_logs", arguments: {} } }) + "\n");
      }
      if (response.id === 2) { clearTimeout(timer); resolve(); }
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "restart-test", version: "1" } } }) + "\n");
  await finished;
  assertPrivate(messages);
  assert.match(JSON.stringify(messages), /REDACTED/);
});
