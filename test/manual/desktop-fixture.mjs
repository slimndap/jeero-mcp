// Local-only fixture for real MCP host testing; never contacts Mother or a ticketing provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { JeeroDatabase } from "../../dist/db.js";

const root = process.env.JEERO_DESKTOP_TEST_ROOT;
assert.ok(root && path.basename(root).startsWith("jeero-desktop-test-"));
const directory = fs.mkdtempSync(path.join(root, "connection-"));
const trace = (direction, message) => fs.appendFileSync(path.join(directory, "mcp.jsonl"), JSON.stringify({ direction, message }) + "\n");
const db = new JeeroDatabase(path.join(directory, "jeero.sqlite"));
db.createSubscription({ subscriptionKey: "desktop-flow", label: "Jeero desktop flow TEST", theater: "stager",
  motherSubscriptionId: "desktop-test", settings: { theater: "stager" }, isDefault: true, isActive: true });
db.close();
let lastSettings = {};
const upstream = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  res.setHeader("content-type", "application/json");
  if (fs.existsSync(path.join(directory, "fail"))) {
    res.writeHead(403);
    return res.end(JSON.stringify({ error: `Rejected credential ${lastSettings.token ?? "fixture-generated-private-token"}` }));
  }
  if (req.method === "POST" && url.pathname === "/v1/subscriptions/desktop-test") {
    let body = "";
    for await (const chunk of req) body += chunk;
    lastSettings = JSON.parse(body).settings;
    fs.writeFileSync(path.join(directory, "status.json"), JSON.stringify({ saved: true,
      hasKey: Boolean(lastSettings.token), keyHash: createHash("sha256").update(lastSettings.token ?? "").digest("hex") }));
    return res.end("{}");
  }
  if (url.pathname === "/v1/inbox/big") return res.end(JSON.stringify({ "desktop-test": lastSettings.token ? [
    { id: "fixture-log", item: "log", data: { message: `Fixture upstream echoed ${lastSettings.token}` } },
  ] : [] }));
  if (req.method === "DELETE") return res.end("{}");
  const settings = JSON.parse(url.searchParams.get("settings") ?? "{}");
  return res.end(JSON.stringify({ subscription_id: "desktop-test", subscription: {
    settings, token: lastSettings.token, cached_token: "fixture-generated-private-token",
  }, fields: [
    { name: "theater", label: "Ticketing solution", type: "select", choices: { stager: "Stager (TEST)" }, required: true },
    { name: "token", label: "TEST API key (no real connection)", type: "password", required: true,
      instructions: "This fixture does not contact Mother or Stager. Use a fictitious test value only." },
    { name: "include_test_events", label: "Import fixture events", type: "checkbox", choices: { "1": "Include fixture events" } },
  ] }));
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const entry = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const child = spawn(process.execPath, [entry], { env: { ...process.env, JEERO_DATA_DIR: directory,
  JEERO_MOTHER_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, JEERO_LOG_MOTHER: "true" }, stdio: ["pipe", "pipe", "pipe"] });
createInterface({ input: process.stdin }).on("line", (line) => {
  trace("client", JSON.parse(line));
  child.stdin.write(line + "\n");
});
createInterface({ input: child.stdout }).on("line", (line) => {
  trace("server", JSON.parse(line));
  process.stdout.write(line + "\n");
});
child.stderr.on("data", (data) => fs.appendFileSync(path.join(directory, "stderr.log"), data));
process.stdin.on("end", () => child.stdin.end());
const stop = () => { child.kill("SIGTERM"); upstream.closeAllConnections(); upstream.close(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", () => { upstream.closeAllConnections(); upstream.close(); process.exit(0); });
