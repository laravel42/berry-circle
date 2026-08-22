import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger as honoLogger } from "hono/logger";
import { type RequestIdVariables, requestId } from "hono/request-id";
import { ApiError, codeForStatus } from "~/http/errors";
import { logger } from "~/logger";
import { auth } from "~/routes/auth";
import { health } from "~/routes/health";

type AppEnv = { Variables: RequestIdVariables };

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use("*", requestId());
  app.use(
    "*",
    honoLogger((message, ...rest) => logger.info({ rest }, message)),
  );
  app.use("*", cors());

  app.route("/", health);
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
    if (err instanceof ApiError) {
      logger.warn({ err, status: err.status }, "request error");
      return c.json(
        { error: { code: err.code, message: err.message, requestId, details: err.details } },
        err.status,
      );
    }
    if (err instanceof HTTPException) {
      logger.warn({ err, status: err.status }, "request error");
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
    logger.error({ err }, "unhandled error");
    return c.json(
      { error: { code: "INTERNAL", message: "Internal server error", requestId, details: null } },
      500,
    );
  });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
