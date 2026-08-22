import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { ApiError, codeForStatus } from "~/http/errors";
import { logger } from "~/logger";
import { observability } from "~/observability";
import { auth } from "~/routes/auth";
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
  app.route("/api/v1/auth", auth);

  // 404s and errors share one envelope: { error: { code, message, requestId, details } }.
  // Rendering here (not via a pre-built Response) is what lets every error carry the
  // request-scoped `requestId` and keep the `X-Request-Id` header — both contract-required.
  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "Route not found",
          requestId: c.get("requestId"),
          details: null,
        },
      },
      404,
    ),
  );

  app.onError((err, c) => {
    const requestId = c.get("requestId");
    const log = c.get("logger") ?? logger;
    if (err instanceof ApiError) {
      log.warn({ err, status: err.status }, "request error");
      return c.json(
        { error: { code: err.code, message: err.message, requestId, details: err.details } },
        err.status,
      );
    }
    if (err instanceof HTTPException) {
      log.warn({ err, status: err.status }, "request error");
      return c.json(
        {
          error: {
            code: codeForStatus(err.status),
            message: err.message,
            requestId,
            details: null,
          },
        },
        err.status,
      );
    }
    log.error({ err }, "unhandled error");
    return c.json(
      { error: { code: "INTERNAL", message: "Internal server error", requestId, details: null } },
      500,
    );
  });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
