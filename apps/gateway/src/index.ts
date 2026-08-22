import { createApp } from "~/app";
import { config } from "~/config";
import { closeDb } from "~/db/client";
import { logger } from "~/logger";

const app = createApp();

const server = Bun.serve({
  fetch: app.fetch,
  port: config.PORT,
  hostname: config.HOST,
});

logger.info({ port: server.port, hostname: server.hostname }, "berry-gateway listening");

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  await server.stop(); // no `true`: let in-flight requests drain
  await closeDb(); // release the DB pool if it was ever opened
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
