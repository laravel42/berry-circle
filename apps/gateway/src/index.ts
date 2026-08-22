import { createApp } from "~/app";
import { config } from "~/config";
import { logger } from "~/logger";

const app = createApp();

const server = Bun.serve({
  fetch: app.fetch,
  port: config.PORT,
  hostname: config.HOST,
});

logger.info({ port: server.port, hostname: server.hostname }, "berry-gateway listening");

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.stop(true);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
