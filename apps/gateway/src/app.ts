import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { logger } from "~/logger";
import { observability } from "~/observability";
import { health } from "~/routes/health";
import { metrics } from "~/routes/metrics";
import type { AppEnv } from "~/types";

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use("*", requestId());
  app.use("*", observability());
  // Expose the correlation headers so browser clients can read them cross-origin.
  app.use("*", cors({ exposeHeaders: ["x-request-id", "x-trace-id"] }));

  app.route("/", health);
  app.route("/", metrics);

  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404));

  app.onError((err, c) => {
    const log = c.get("logger") ?? logger;
    if (err instanceof HTTPException) {
      log.warn({ err, status: err.status }, "request error");
      return err.getResponse();
    }
    log.error({ err }, "unhandled error");
    return c.json({ error: { code: "INTERNAL", message: "Internal server error" } }, 500);
  });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
