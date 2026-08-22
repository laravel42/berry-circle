import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger as honoLogger } from "hono/logger";
import { requestId } from "hono/request-id";
import { logger } from "~/logger";
import { health } from "~/routes/health";

export function createApp() {
  const app = new Hono();

  app.use("*", requestId());
  app.use(
    "*",
    honoLogger((message, ...rest) => logger.info({ rest }, message)),
  );
  app.use("*", cors());

  app.route("/", health);

  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      logger.warn({ err, status: err.status }, "request error");
      return err.getResponse();
    }
    logger.error({ err }, "unhandled error");
    return c.json({ error: { code: "INTERNAL", message: "Internal server error" } }, 500);
  });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
