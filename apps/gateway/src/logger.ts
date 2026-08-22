import { pino } from "pino";
import { config } from "~/config";

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: "berry-gateway", env: config.NODE_ENV },
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie"],
    censor: "[redacted]",
  },
});
