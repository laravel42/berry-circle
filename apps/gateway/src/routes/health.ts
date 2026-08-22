import { Hono } from "hono";

const startedAtMs = Date.now();
const startedAt = new Date(startedAtMs).toISOString();

export const health = new Hono().get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "berry-gateway",
    version: process.env.npm_package_version ?? "0.1.0",
    startedAt,
    uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
  });
});
