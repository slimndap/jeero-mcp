import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await startServer(config);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
