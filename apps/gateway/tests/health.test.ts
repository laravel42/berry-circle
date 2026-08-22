import { describe, expect, it } from "bun:test";
import { HTTPException } from "hono/http-exception";
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

describe("app.onError", () => {
  it("preserves the thrown HTTPException status instead of collapsing to 500", async () => {
    const app = createApp();
    app.get("/boom", () => {
      throw new HTTPException(400, { message: "bad input" });
    });

    const res = await app.request("/boom");
    expect(res.status).toBe(400);
  });

  it("collapses non-HTTP errors to 500 without leaking internals", async () => {
    const app = createApp();
    app.get("/crash", () => {
      throw new Error("internal detail");
    });

    const res = await app.request("/crash");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("internal detail");
  });
});
