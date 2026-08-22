// SSE run-streaming endpoint (BERR-26).
//
// `GET /api/v1/runs/:runId/events` replays a run's retained events and then
// follows it live, relaying the Berry events that the OpenFang adapter projected
// into the store. Contract: `docs/api/gateway-v1.md`, "SSE contracts".
//
// Framing and lifecycle rules enforced here:
//   - 200 `text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`;
//   - a `retry: 3000` directive before any event;
//   - replay of events after the supplied cursor, then an open follow;
//   - `Last-Event-ID` (reconnect) or `?after=` (initial) cursor, never both;
//   - `409 CURSOR_EXPIRED` before opening when the cursor predates retention;
//   - a `: heartbeat` comment on idle (no id / no payload, never advances a cursor);
//   - close after a terminal run event;
//   - clean teardown on client disconnect.

import type { Context } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { RunEventStream } from "~/runs/event-store";
import { runEventStore } from "~/runs/event-store";
import {
  DEFAULT_HEARTBEAT_MS,
  HEARTBEAT_FRAME,
  RETRY_DIRECTIVE,
  formatEventFrame,
} from "~/runs/events";

export interface RunEventsRouteOptions {
  /** Event source; defaults to the process-wide store. */
  store?: RunEventStream;
  /** Idle interval before a heartbeat; overridable for tests. */
  heartbeatMs?: number;
}

// `requestId()` runs on the parent app and populates this variable; declaring it
// lets `c.get("requestId")` typecheck through the mounted sub-app.
type RunEventsEnv = { Variables: { requestId?: string } };

// Cursors are opaque to clients (we never parse them), but we still bound the
// input we accept as a lookup key.
const cursorSchema = z.string().min(1).max(512);

function errorResponse(
  c: Context<RunEventsEnv>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
) {
  return c.json(
    { error: { code, message, requestId: c.get("requestId") ?? null, details: null } },
    status,
  );
}

/** Collapse missing/empty cursor inputs to `undefined`. */
function normalizeCursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function runEventsRoutes(options: RunEventsRouteOptions = {}) {
  const store = options.store ?? runEventStore;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  return new Hono<RunEventsEnv>().get("/api/v1/runs/:runId/events", (c) => {
    const runId = c.req.param("runId");

    // A reconnecting client resumes with `Last-Event-ID`; an initial reader may
    // pass `?after=`. Supplying both is ambiguous and rejected.
    const lastEventId = normalizeCursor(c.req.header("Last-Event-ID"));
    const afterQuery = normalizeCursor(c.req.query("after"));
    if (lastEventId !== undefined && afterQuery !== undefined) {
      return errorResponse(
        c,
        400,
        "INVALID_REQUEST",
        "Provide either the Last-Event-ID header or the after cursor, not both.",
      );
    }
    const cursor = lastEventId ?? afterQuery;
    if (cursor !== undefined && !cursorSchema.safeParse(cursor).success) {
      return errorResponse(c, 400, "INVALID_REQUEST", "The event cursor is malformed.");
    }

    if (!store.hasRun(runId)) {
      return errorResponse(c, 404, "NOT_FOUND", "Run not found.");
    }

    const opened = store.open(runId, { afterCursor: cursor });
    if (!opened.ok) {
      if (opened.reason === "not_found") {
        return errorResponse(c, 404, "NOT_FOUND", "Run not found.");
      }
      return errorResponse(
        c,
        409,
        "CURSOR_EXPIRED",
        "The event cursor is older than the retention window; reconnect without a cursor and reconcile from the run resource.",
      );
    }
    const subscription = opened.subscription;

    // Tear down when the client disconnects. The subscription is registered
    // synchronously by `open`, so any event appended before the body starts
    // streaming is already buffered — no gap between backlog and follow.
    const signal = c.req.raw.signal;
    const onAbort = () => subscription.close();
    if (signal.aborted) {
      subscription.close();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const encoder = new TextEncoder();
    let retrySent = false;
    let streamClosed = false;
    const cleanup = () => {
      if (streamClosed) return;
      streamClosed = true;
      subscription.close();
      signal.removeEventListener("abort", onAbort);
    };

    const body = new ReadableStream<Uint8Array>({
      // Pull-based production honors the consumer's desired size. The store
      // independently caps its live subscriber buffer, so a stalled socket is
      // bounded at both layers.
      pull: async (controller) => {
        if (streamClosed) return;
        if (!retrySent) {
          retrySent = true;
          controller.enqueue(encoder.encode(RETRY_DIRECTIVE));
          return;
        }

        const item = await subscription.next(heartbeatMs);
        if (item.kind === "closed" || signal.aborted) {
          cleanup();
          controller.close();
          return;
        }
        if (item.kind === "idle") {
          controller.enqueue(encoder.encode(HEARTBEAT_FRAME));
          return;
        }
        controller.enqueue(encoder.encode(formatEventFrame(item.event)));
      },
      cancel: () => {
        cleanup();
      },
    });

    c.header("Content-Type", "text/event-stream; charset=utf-8");
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("Connection", "keep-alive");
    // Defeat proxy response buffering so events flush immediately.
    c.header("X-Accel-Buffering", "no");
    return c.body(body);
  });
}
