import { createApp } from "~/app";
import { config } from "~/config";
import { closeDb } from "~/db/client";
import { logger } from "~/logger";

// Fail loudly on a misconfigured production deploy instead of turning every
// DB-backed request into an opaque 500 (getDb throws) at runtime.
if (config.NODE_ENV === "production" && !config.DATABASE_URL) {
  logger.fatal("DATABASE_URL is required in production; refusing to start.");
  process.exit(1);
}
// The passwordless-login flag is hard-ignored in production, but surface the
// misconfiguration rather than silently dropping it.
if (config.NODE_ENV === "production" && config.AUTH_ALLOW_PASSWORDLESS_LOGIN) {
  logger.warn("AUTH_ALLOW_PASSWORDLESS_LOGIN is ignored under NODE_ENV=production.");
}

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
