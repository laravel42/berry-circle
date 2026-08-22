import type { Logger } from "pino";

/**
 * Hono environment for the gateway app. `requestId` is contributed globally by
 * `hono/request-id`'s module augmentation; the observability middleware adds the
 * request-scoped trace id and child logger on top.
 */
export type AppEnv = {
  Variables: {
    traceId: string;
    logger: Logger;
  };
};
