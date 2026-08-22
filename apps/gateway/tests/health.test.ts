import { describe, expect, it } from "bun:test";
import { createApp } from "~/app";

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("berry-gateway");
    expect(typeof body.uptimeSeconds).toBe("number");
  });

  it("returns 404 JSON for unknown routes", async () => {
    const app = createApp();
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
