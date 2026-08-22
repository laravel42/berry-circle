import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger as honoLogger } from "hono/logger";
import { type RequestIdVariables, requestId } from "hono/request-id";
import { getDb } from "~/db/client";
import { ApiError } from "~/http/errors";
import { logger } from "~/logger";
import { makeCommentRoutes } from "~/routes/comments";
import { health } from "~/routes/health";
import { makeIssueRoutes } from "~/routes/issues";
import type { RouteDeps } from "~/routes/support";

export type AppDeps = RouteDeps;

type AppEnv = { Variables: RequestIdVariables };

/** Builds the error envelope defined by the M0 contract (ErrorEnvelope). */
function errorBody(code: string, message: string, requestId: string, details: unknown = null) {
  return { error: { code, message, requestId, details } };
}

export function createApp(deps: AppDeps = { db: getDb() }) {
  const app = new Hono<AppEnv>();

  app.use("*", requestId());
  app.use(
    "*",
    honoLogger((message, ...rest) => logger.info({ rest }, message)),
  );
  app.use("*", cors());

  app.route("/", health);
  app.route("/api/v1", makeIssueRoutes(deps));
  app.route("/api/v1", makeCommentRoutes(deps));

  app.notFound((c) => c.json(errorBody("NOT_FOUND", "Route not found", c.get("requestId")), 404));

  app.onError((err, c) => {
    const rid = c.get("requestId");

    if (err instanceof ApiError) {
      if (err.status >= 500) {
        logger.error({ err, status: err.status }, "request error");
      } else {
        logger.warn({ err, status: err.status }, "request error");
      }
      return c.json(err.toEnvelope(rid), err.status);
    }

    if (err instanceof HTTPException) {
      logger.warn({ err, status: err.status }, "request error");
      return c.json(errorBody("INVALID_REQUEST", err.message, rid), err.status);
    }

    logger.error({ err }, "unhandled error");
    return c.json(errorBody("INTERNAL", "Internal server error", rid), 500);
  });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
