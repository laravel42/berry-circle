import { describe, expect, it } from "bun:test";
import { OpenFangError } from "~/openfang/errors";

describe("OpenFangError.codeForStatus", () => {
  it("maps documented statuses to stable codes", () => {
    expect(OpenFangError.codeForStatus(400)).toBe("UPSTREAM_BAD_REQUEST");
    expect(OpenFangError.codeForStatus(401)).toBe("UPSTREAM_UNAUTHORIZED");
    expect(OpenFangError.codeForStatus(403)).toBe("UPSTREAM_FORBIDDEN");
    expect(OpenFangError.codeForStatus(404)).toBe("UPSTREAM_NOT_FOUND");
    expect(OpenFangError.codeForStatus(413)).toBe("UPSTREAM_PAYLOAD_TOO_LARGE");
    expect(OpenFangError.codeForStatus(429)).toBe("UPSTREAM_RATE_LIMITED");
    expect(OpenFangError.codeForStatus(500)).toBe("UPSTREAM_SERVER_ERROR");
    expect(OpenFangError.codeForStatus(503)).toBe("UPSTREAM_SERVER_ERROR");
  });

  it("treats other 4xx (e.g. 422) as a bad request", () => {
    expect(OpenFangError.codeForStatus(422)).toBe("UPSTREAM_BAD_REQUEST");
  });
});

describe("OpenFangError.fromResponse", () => {
  it("extracts the upstream { error } message", () => {
    const err = OpenFangError.fromResponse(
      "GET",
      "/api/agents/x",
      404,
      JSON.stringify({ error: "agent not found" }),
      { requestId: "req-1" },
    );
    expect(err.code).toBe("UPSTREAM_NOT_FOUND");
    expect(err.status).toBe(404);
    expect(err.requestId).toBe("req-1");
    expect(err.upstreamMessage).toBe("agent not found");
    expect(err.message).toContain("agent not found");
  });

  it("falls back to a truncated body for a framework rejection", () => {
    const err = OpenFangError.fromResponse(
      "POST",
      "/api/agents",
      400,
      "Failed to parse the request body",
    );
    expect(err.code).toBe("UPSTREAM_BAD_REQUEST");
    expect(err.upstreamMessage).toBeUndefined();
    expect(err.message).toContain("Failed to parse the request body");
  });

  it("carries retryAfterMs for a 429", () => {
    const err = OpenFangError.fromResponse(
      "GET",
      "/api/usage",
      429,
      JSON.stringify({ error: "Rate limit exceeded" }),
      {
        retryAfterMs: 60_000,
      },
    );
    expect(err.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(err.retryAfterMs).toBe(60_000);
  });
});

describe("OpenFangError.gatewayStatus", () => {
  it("propagates a not-found and rate limit, times out to 504, else 502", () => {
    expect(new OpenFangError("UPSTREAM_NOT_FOUND", "x").gatewayStatus).toBe(404);
    expect(new OpenFangError("UPSTREAM_RATE_LIMITED", "x").gatewayStatus).toBe(429);
    expect(new OpenFangError("UPSTREAM_TIMEOUT", "x").gatewayStatus).toBe(504);
    expect(new OpenFangError("INVALID_REQUEST", "x").gatewayStatus).toBe(400);
    expect(new OpenFangError("UPSTREAM_SERVER_ERROR", "x").gatewayStatus).toBe(502);
    expect(new OpenFangError("UPSTREAM_UNAUTHORIZED", "x").gatewayStatus).toBe(502);
  });
});

describe("OpenFangError.toErrorEnvelope", () => {
  it("produces Berry's stable error envelope", () => {
    const envelope = new OpenFangError("UPSTREAM_SERVER_ERROR", "boom").toErrorEnvelope();
    expect(envelope).toEqual({ error: { code: "UPSTREAM_SERVER_ERROR", message: "boom" } });
  });
});
