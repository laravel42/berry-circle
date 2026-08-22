import { afterEach, describe, expect, it } from "bun:test";
import { createApp } from "~/app";
import { logger } from "~/logger";
import {
  type RequestContext,
  formatTraceparent,
  getTraceHeaders,
  parseTraceparent,
  runWithContext,
  tracedFetch,
} from "~/observability";

function fakeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: "11111111-1111-4111-8111-111111111111",
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: "01",
    logger,
    ...overrides,
  };
}

describe("traceparent parsing", () => {
  it("parses a well-formed traceparent", () => {
    const parsed = parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    expect(parsed).toEqual({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      flags: "01",
    });
  });

  it("rejects malformed and all-zero traceparents", () => {
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent("not-a-traceparent")).toBeNull();
    expect(parseTraceparent("00-abc-def-01")).toBeNull();
    // all-zero (invalid) trace id
    expect(parseTraceparent(`00-${"0".repeat(32)}-b7ad6b7169203331-01`)).toBeNull();
  });

  it("round-trips through formatTraceparent", () => {
    const value = formatTraceparent("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331");
    expect(value).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    expect(parseTraceparent(value)?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
  });
});

describe("getTraceHeaders", () => {
  it("returns propagation headers from the active context", () => {
    const ctx = fakeContext();
    const headers = runWithContext(ctx, () => getTraceHeaders());
    expect(headers["x-request-id"]).toBe(ctx.requestId);
    expect(headers.traceparent).toBe(`00-${ctx.traceId}-${ctx.spanId}-01`);
  });

  it("returns an empty object outside a request scope", () => {
    expect(getTraceHeaders()).toEqual({});
  });
});

describe("GET /metrics", () => {
  it("exposes Prometheus metrics after handling a request", async () => {
    const app = createApp();
    await app.request("/health");

    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const body = await res.text();
    expect(body).toContain("http_server_request_duration");
    expect(body).toContain("http_server_active_requests");
    // Resource attributes surface as the target_info metric.
    expect(body).toContain("berry-gateway");
  });
});

describe("request instrumentation", () => {
  it("sets x-request-id and x-trace-id response headers", async () => {
    const app = createApp();
    const res = await app.request("/health");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(res.headers.get("x-trace-id")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("continues an inbound trace id", async () => {
    const app = createApp();
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const res = await app.request("/health", {
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });
    expect(res.headers.get("x-trace-id")).toBe(traceId);
  });
});

describe("tracedFetch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("injects trace headers and records the outbound metric", async () => {
    let captured: Headers | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const ctx = fakeContext();
    const res = await runWithContext(ctx, () =>
      tracedFetch(
        "http://openfang.test/api/agents",
        { method: "GET" },
        { route: "GET /api/agents" },
      ),
    );

    expect(res.status).toBe(200);
    expect(captured?.get("x-request-id")).toBe(ctx.requestId);
    expect(captured?.get("traceparent")).toBe(`00-${ctx.traceId}-${ctx.spanId}-01`);
  });

  it("does not overwrite caller-supplied headers", async () => {
    let captured: Headers | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const ctx = fakeContext();
    await runWithContext(ctx, () =>
      tracedFetch(
        "http://openfang.test/api/agents",
        { method: "GET", headers: { "x-request-id": "caller-owned" } },
        { route: "GET /api/agents" },
      ),
    );

    expect(captured?.get("x-request-id")).toBe("caller-owned");
  });
});
