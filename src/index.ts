import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

function main(): void {
  const config = loadConfig();
  serveStdio(() => createServer(config), {
    onerror: (error) => {
      process.stderr.write(`${error.stack ?? error.message}\n`);
    },
  });
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
