import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "pino";

/**
 * Per-request observability context. It is established once by the gateway's
 * request middleware and carried across `await` boundaries via
 * {@link AsyncLocalStorage}, so any downstream code — notably the OpenFang
 * adapter — can read the active trace without threading it through call sites.
 */
export interface RequestContext {
  /** Berry-facing correlation id (also emitted as the `x-request-id` header). */
  requestId: string;
  /** W3C trace id (32 lowercase hex chars) shared across the distributed trace. */
  traceId: string;
  /** W3C span id (16 lowercase hex chars) for this gateway request. */
  spanId: string;
  /** W3C trace flags byte (e.g. `01` when sampled). */
  traceFlags: string;
  /** Request-scoped child logger bound with `requestId` + `traceId`. */
  logger: Logger;
}

const storage = new AsyncLocalStorage<RequestContext>();

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const byte of buf) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** Generate a fresh W3C trace id (16 random bytes as hex). */
export function generateTraceId(): string {
  return randomHex(16);
}

/** Generate a fresh W3C span id (8 random bytes as hex). */
export function generateSpanId(): string {
  return randomHex(8);
}

export interface ParsedTraceparent {
  traceId: string;
  spanId: string;
  flags: string;
}

/**
 * Parse a W3C `traceparent` header, returning `null` when it is absent,
 * malformed, or carries the all-zero (invalid) trace/span ids.
 */
export function parseTraceparent(value: string | null | undefined): ParsedTraceparent | null {
  if (!value) return null;
  const match = TRACEPARENT_RE.exec(value.trim().toLowerCase());
  if (!match) return null;
  const [, traceId, spanId, flags] = match;
  if (traceId === INVALID_TRACE_ID || spanId === INVALID_SPAN_ID) return null;
  return { traceId, spanId, flags };
}

/** Format a W3C `traceparent` header value. */
export function formatTraceparent(traceId: string, spanId: string, flags = "01"): string {
  return `00-${traceId}-${spanId}-${flags}`;
}

/** Run `fn` with `ctx` as the active request context. */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Read the active request context, or `undefined` outside a request scope. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Trace-propagation headers for an outbound call from the gateway. The OpenFang
 * adapter should merge these into every upstream request so the substrate can
 * correlate its work with the originating Berry request. Returns `{}` when
 * called outside a request scope (e.g. startup or a background job).
 */
export function getTraceHeaders(): Record<string, string> {
  const ctx = storage.getStore();
  if (!ctx) return {};
  return {
    "x-request-id": ctx.requestId,
    traceparent: formatTraceparent(ctx.traceId, ctx.spanId, ctx.traceFlags),
  };
}
