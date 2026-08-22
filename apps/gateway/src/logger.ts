import { pino } from "pino";
import { config } from "~/config";

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: config.SERVICE_NAME, env: config.NODE_ENV },
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "*.authorization", "*.apiKey"],
    censor: "[redacted]",
  },
});

export type { Logger } from "pino";
