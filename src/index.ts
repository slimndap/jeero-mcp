import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

function main(): void {
  const config = loadConfig();
  serveStdio(() => createServer(config), {
    onerror: () => {
      process.stderr.write("Jeero MCP connection error. Check the client configuration and try again.\n");
    },
  });
}

try {
  main();
} catch {
  process.stderr.write("Jeero could not start. Check the local data directory and configuration.\n");
  process.exit(1);
}
