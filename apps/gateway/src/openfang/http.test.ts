import { describe, expect, it } from "bun:test";
import { OpenFangClient } from "~/openfang/client";
import type { OpenFangError, OpenFangErrorCode } from "~/openfang/errors";
import { DEFAULT_RETRY, HttpTransport } from "~/openfang/http";
import {
  jsonResponse,
  queue,
  recordingFetch,
  recordingSleep,
  textResponse,
} from "~/openfang/test-support";

const BASE = "http://openfang.test";

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

async function captureError(action: () => Promise<unknown>): Promise<OpenFangError> {
  try {
    await action();
  } catch (error) {
    return error as OpenFangError;
  }
  throw new Error("expected the call to reject");
}

describe("transport — auth and headers", () => {
  it("sends bearer auth and a JSON accept header", async () => {
    const { fetch, calls } = recordingFetch(queue(jsonResponse(200, [])));
    const client = new OpenFangClient({ baseUrl: BASE, apiKey: "secret-key", fetch });
    await client.listAgents();
    expect(header(calls[0].init, "authorization")).toBe("Bearer secret-key");
    expect(header(calls[0].init, "accept")).toBe("application/json");
    expect(header(calls[0].init, "content-type")).toBeNull();
  });

  it("omits Authorization when no api key is configured", async () => {
    const { fetch, calls } = recordingFetch(queue(jsonResponse(200, [])));
    await new OpenFangClient({ baseUrl: BASE, fetch }).listAgents();
    expect(header(calls[0].init, "authorization")).toBeNull();
  });

  it("sets content-type and serializes the body on write requests", async () => {
    const { fetch, calls } = recordingFetch(
      queue(jsonResponse(201, { agent_id: "a1", name: "builder" })),
    );
    const client = new OpenFangClient({ baseUrl: BASE, fetch });
    await client.spawnAgent({ manifest_toml: 'name = "builder"' });
    expect(calls[0].init.method).toBe("POST");
    expect(header(calls[0].init, "content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ manifest_toml: 'name = "builder"' });
  });
});

describe("transport — error normalization", () => {
  it("maps each documented status to a stable code", async () => {
    const cases: Array<[number, OpenFangErrorCode]> = [
      [400, "UPSTREAM_BAD_REQUEST"],
      [401, "UPSTREAM_UNAUTHORIZED"],
      [403, "UPSTREAM_FORBIDDEN"],
      [404, "UPSTREAM_NOT_FOUND"],
      [413, "UPSTREAM_PAYLOAD_TOO_LARGE"],
      [429, "UPSTREAM_RATE_LIMITED"],
      [500, "UPSTREAM_SERVER_ERROR"],
    ];
    for (const [status, code] of cases) {
      const { fetch } = recordingFetch(queue(jsonResponse(status, { error: "x" })));
      const client = new OpenFangClient({ baseUrl: BASE, fetch, retry: { maxRetries: 0 } });
      const err = await captureError(() => client.listAgents());
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
    }
  });

  it("captures the x-request-id and upstream message in the error", async () => {
    const { fetch } = recordingFetch(
      queue(jsonResponse(404, { error: "agent not found" }, { "x-request-id": "req-9" })),
    );
    const client = new OpenFangClient({ baseUrl: BASE, fetch });
    const err = await captureError(() => client.getAgent("missing"));
    expect(err.code).toBe("UPSTREAM_NOT_FOUND");
    expect(err.requestId).toBe("req-9");
    expect(err.upstreamMessage).toBe("agent not found");
  });

  it("normalizes an invalid JSON success body", async () => {
    const { fetch } = recordingFetch(queue(textResponse(200, "not json")));
    const client = new OpenFangClient({ baseUrl: BASE, fetch });
    const err = await captureError(() => client.listAgents());
    expect(err.code).toBe("UPSTREAM_INVALID_RESPONSE");
  });
});

describe("transport — retry policy", () => {
  it("retries a read on 500 with backoff, then succeeds", async () => {
    const { sleep, delays } = recordingSleep();
    const { fetch, calls } = recordingFetch(
      queue(jsonResponse(500, { error: "boom" }), jsonResponse(200, [])),
    );
    const client = new OpenFangClient({ baseUrl: BASE, fetch, sleep });
    expect(await client.listAgents()).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(delays).toHaveLength(1);
  });

  it("retries a read on a network failure, then succeeds", async () => {
    const { sleep, delays } = recordingSleep();
    const { fetch, calls } = recordingFetch(
      queue(new TypeError("network down"), jsonResponse(200, [])),
    );
    const client = new OpenFangClient({ baseUrl: BASE, fetch, sleep });
    expect(await client.listAgents()).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(delays).toHaveLength(1);
  });

  it("gives up after maxRetries on a persistent 500", async () => {
    const { sleep, delays } = recordingSleep();
    const { fetch, calls } = recordingFetch(
      queue(
        jsonResponse(500, { error: "1" }),
        jsonResponse(500, { error: "2" }),
        jsonResponse(500, { error: "3" }),
      ),
    );
    const client = new OpenFangClient({ baseUrl: BASE, fetch, sleep, retry: { maxRetries: 2 } });
    const err = await captureError(() => client.listAgents());
    expect(err.code).toBe("UPSTREAM_SERVER_ERROR");
    expect(calls).toHaveLength(3); // initial + 2 retries
    expect(delays).toHaveLength(2);
  });

  it("honors Retry-After on a 429 for a read", async () => {
    const { sleep, delays } = recordingSleep();
    const { fetch, calls } = recordingFetch(
      queue(
        jsonResponse(429, { error: "Rate limit exceeded" }, { "retry-after": "1" }),
        jsonResponse(200, []),
      ),
    );
    const client = new OpenFangClient({ baseUrl: BASE, fetch, sleep });
    await client.listAgents();
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([1_000]);
  });

  it("does not retry an unsafe dispatch on 500", async () => {
    const { sleep, delays } = recordingSleep();
    const { fetch, calls } = recordingFetch(
      queue(jsonResponse(500, { error: "spawn failed" }), jsonResponse(201, {})),
    );
    const client = new OpenFangClient({ baseUrl: BASE, fetch, sleep });
    const err = await captureError(() => client.spawnAgent({ manifest_toml: 'name = "x"' }));
    expect(err.code).toBe("UPSTREAM_SERVER_ERROR");
    expect(calls).toHaveLength(1);
    expect(delays).toHaveLength(0);
  });

  it("does not retry an unsafe dispatch on 429 but surfaces retryAfterMs", async () => {
    const { fetch, calls } = recordingFetch(
      queue(jsonResponse(429, { error: "Rate limit exceeded" }, { "retry-after": "1" })),
    );
    const client = new OpenFangClient({ baseUrl: BASE, fetch });
    const err = await captureError(() => client.stopAgent("a1"));
    expect(err.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(err.retryAfterMs).toBe(1_000);
    expect(calls).toHaveLength(1);
  });

  it("retries an idempotent memory write on 500", async () => {
    const { sleep, delays } = recordingSleep();
    const { fetch, calls } = recordingFetch(
      queue(
        jsonResponse(500, { error: "storage" }),
        jsonResponse(200, { status: "stored", key: "k" }),
      ),
    );
    const client = new OpenFangClient({ baseUrl: BASE, fetch, sleep });
    const result = await client.putMemory("a1", "k", { tone: "brief" });
    expect(result.status).toBe("stored");
    expect(calls).toHaveLength(2);
    expect(delays).toHaveLength(1);
  });

  it("does not auto-retry deleteMemory (contract: deletes need reconciliation)", async () => {
    const { sleep, delays } = recordingSleep();
    const { fetch, calls } = recordingFetch(queue(jsonResponse(500, { error: "storage" })));
    const client = new OpenFangClient({ baseUrl: BASE, fetch, sleep });
    const err = await captureError(() => client.deleteMemory("a1", "k"));
    expect(err.code).toBe("UPSTREAM_SERVER_ERROR");
    expect(calls).toHaveLength(1);
    expect(delays).toHaveLength(0);
  });
});

describe("transport — backoff cancellation", () => {
  it("aborts promptly during backoff instead of stalling for the full delay", async () => {
    // First attempt 500 → transport would sleep a long backoff before retry;
    // aborting the caller's signal mid-sleep must reject at once, not wait it out.
    const { fetch, calls } = recordingFetch(queue(jsonResponse(500, { error: "boom" })));
    const transport = new HttpTransport({
      baseUrl: BASE,
      fetchImpl: fetch,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      timeoutMs: 30_000,
      streamTimeoutMs: 120_000,
      retry: { ...DEFAULT_RETRY, baseDelayMs: 10_000, jitter: 0 },
    });
    const controller = new AbortController();
    const reason = new Error("client gone");
    setTimeout(() => controller.abort(reason), 15);

    let caught: unknown;
    try {
      await transport.request({
        method: "GET",
        path: "/api/agents",
        idempotency: "read",
        signal: controller.signal,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason); // the abort reason, not a 10s-later server error
    expect(calls).toHaveLength(1); // never reached the second attempt
  });
});

describe("transport — timeout", () => {
  it("aborts a slow request and normalizes to UPSTREAM_TIMEOUT", async () => {
    const { fetch } = recordingFetch(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const client = new OpenFangClient({
      baseUrl: BASE,
      fetch,
      timeoutMs: 20,
      retry: { maxRetries: 0 },
    });
    const err = await captureError(() => client.listAgents());
    expect(err.code).toBe("UPSTREAM_TIMEOUT");
  });
});
