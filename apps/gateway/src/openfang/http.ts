/**
 * HTTP transport for the OpenFang adapter (BERR-20).
 *
 * Owns the cross-cutting transport concerns from the consumption contract:
 * bearer auth, per-request timeout via `AbortController`, `x-request-id`
 * capture, error normalization, and the retry policy. It knows nothing about
 * the contract's payload shapes — response validation lives in the client.
 *
 * Retry policy (see `docs/api/openfang-gateway-consumption.md` §Error, retry,
 * and idempotency policy) is keyed on an idempotency class per request:
 *   - `read`             safe GETs — retry `429` (honoring `Retry-After`) and
 *                        `5xx`/network failures with bounded exponential backoff.
 *   - `idempotent-write` memory PUT/DELETE at a deterministic key — same policy;
 *                        replaying is safe because it overwrites/removes one key.
 *   - `unsafe`           create/execute/dispatch/patch/kill — never retried, so
 *                        an ambiguous failure preserves state for reconciliation.
 */

import { OpenFangError } from "~/openfang/errors";

export type IdempotencyClass = "read" | "idempotent-write" | "unsafe";

export interface RetryConfig {
  /** Max retry attempts for retryable classes (0 disables retries). */
  maxRetries: number;
  /** First backoff delay; doubles each attempt. */
  baseDelayMs: number;
  /** Ceiling for the exponential backoff delay. */
  maxDelayMs: number;
  /** Fractional jitter added on top of each delay (0–1). */
  jitter: number;
  /** Cap on an honored `Retry-After`, so a pathological value can't stall. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  jitter: 0.25,
  maxRetryAfterMs: 60_000,
};

/** Minimal logger surface; the gateway's Pino instance satisfies it. */
export interface AdapterLogger {
  warn(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

/**
 * The subset of `fetch` the transport needs. Narrower than `typeof fetch` (no
 * `preconnect`) so tests can supply a plain function; the global `fetch` is
 * assignable to it.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TransportContext {
  /** Base URL with any trailing slash already stripped. */
  baseUrl: string;
  apiKey?: string;
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  logger?: AdapterLogger;
  /** Default timeout for a non-streaming request. */
  timeoutMs: number;
  /** Default timeout covering the whole lifetime of a stream. */
  streamTimeoutMs: number;
  retry: RetryConfig;
}

export interface RequestSpec {
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Expected success status; a mismatch is normalized as an error. */
  expectStatus?: number;
  idempotency?: IdempotencyClass;
  accept?: string;
  timeoutMs?: number;
  /** External cancellation; abort rejects with the signal's reason. */
  signal?: AbortSignal;
}

export interface StreamHandle {
  response: Response;
  /** The response body, already narrowed to non-null. */
  body: ReadableStream<Uint8Array>;
  requestId: string | null;
  /** Clears the stream timeout and abort wiring; call once the body is drained. */
  dispose: () => void;
  /** Aborts if the whole-stream timeout or external cancellation fires. */
  signal: AbortSignal;
}

export class HttpTransport {
  constructor(private readonly ctx: TransportContext) {}

  /** Perform a non-streaming request, returning parsed JSON and the request id. */
  async request(spec: RequestSpec): Promise<{ data: unknown; requestId: string | null }> {
    const idempotency = spec.idempotency ?? "unsafe";
    const url = this.buildUrl(spec);
    const maxRetries = idempotency === "unsafe" ? 0 : this.ctx.retry.maxRetries;
    const expected = spec.expectStatus ?? 200;

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timeoutMs = spec.timeoutMs ?? this.ctx.timeoutMs;
      const state = this.arm(controller, timeoutMs, spec.signal);
      try {
        let response: Response;
        try {
          response = await this.ctx.fetchImpl(url, {
            method: spec.method,
            headers: this.buildHeaders(spec),
            body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
            signal: controller.signal,
          });
        } catch (cause) {
          if (spec.signal?.aborted && !state.timedOut) throw spec.signal.reason;
          const err = this.transportError(spec, timeoutMs, state.timedOut, cause);
          if (attempt < maxRetries) {
            await this.backoff(spec, attempt, err);
            continue;
          }
          throw err;
        }

        const requestId = response.headers.get("x-request-id");
        if (response.status === expected) {
          try {
            return { data: await response.json(), requestId };
          } catch (cause) {
            throw new OpenFangError(
              "UPSTREAM_INVALID_RESPONSE",
              `OpenFang ${spec.method} ${spec.path} returned invalid JSON`,
              { status: response.status, requestId, cause },
            );
          }
        }

        const bodyText = await safeText(response);
        const retryAfterMs =
          response.status === 429
            ? this.parseRetryAfter(response.headers.get("retry-after"))
            : undefined;
        const err = OpenFangError.fromResponse(spec.method, spec.path, response.status, bodyText, {
          requestId,
          retryAfterMs,
        });
        if (attempt < maxRetries && isRetryableStatus(response.status)) {
          await this.backoff(spec, attempt, err, retryAfterMs);
          continue;
        }
        throw err;
      } finally {
        state.dispose();
      }
    }
  }

  /**
   * Open a streaming (`text/event-stream`) request. Stream dispatch is `unsafe`,
   * so it is never retried; a pre-stream non-2xx is normalized and thrown, and a
   * `200` returns the live body with its timeout still armed for the SSE reader.
   */
  async openStream(spec: RequestSpec): Promise<StreamHandle> {
    const url = this.buildUrl(spec);
    const timeoutMs = spec.timeoutMs ?? this.ctx.streamTimeoutMs;
    const controller = new AbortController();
    const state = this.arm(controller, timeoutMs, spec.signal);
    const expected = spec.expectStatus ?? 200;

    let response: Response;
    try {
      response = await this.ctx.fetchImpl(url, {
        method: spec.method,
        headers: this.buildHeaders(spec),
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal: controller.signal,
      });
    } catch (cause) {
      state.dispose();
      if (spec.signal?.aborted && !state.timedOut) throw spec.signal.reason;
      throw this.transportError(spec, timeoutMs, state.timedOut, cause);
    }

    const requestId = response.headers.get("x-request-id");
    if (response.status !== expected) {
      const bodyText = await safeText(response);
      state.dispose();
      throw OpenFangError.fromResponse(spec.method, spec.path, response.status, bodyText, {
        requestId,
      });
    }
    if (!response.body) {
      state.dispose();
      throw new OpenFangError(
        "UPSTREAM_INVALID_RESPONSE",
        `OpenFang ${spec.method} ${spec.path} returned no stream body`,
        { status: response.status, requestId },
      );
    }
    return {
      response,
      body: response.body,
      requestId,
      dispose: state.dispose,
      signal: controller.signal,
    };
  }

  /** Arm a per-attempt timeout and wire external cancellation to the controller. */
  private arm(controller: AbortController, timeoutMs: number, external?: AbortSignal) {
    const state = { timedOut: false };
    const timer = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", onAbort, { once: true });
    }
    return {
      get timedOut() {
        return state.timedOut;
      },
      dispose() {
        clearTimeout(timer);
        external?.removeEventListener("abort", onAbort);
      },
    };
  }

  private transportError(
    spec: RequestSpec,
    timeoutMs: number,
    timedOut: boolean,
    cause: unknown,
  ): OpenFangError {
    if (timedOut) {
      return new OpenFangError(
        "UPSTREAM_TIMEOUT",
        `OpenFang ${spec.method} ${spec.path} timed out after ${timeoutMs} ms`,
        { cause },
      );
    }
    return new OpenFangError(
      "UPSTREAM_UNAVAILABLE",
      `OpenFang ${spec.method} ${spec.path} transport failure`,
      { cause },
    );
  }

  private async backoff(
    spec: RequestSpec,
    attempt: number,
    err: OpenFangError,
    retryAfterMs?: number,
  ): Promise<void> {
    const delay = retryAfterMs !== undefined ? retryAfterMs : this.computeBackoff(attempt);
    this.ctx.logger?.warn(
      {
        method: spec.method,
        path: spec.path,
        attempt: attempt + 1,
        delayMs: Math.round(delay),
        code: err.code,
        status: err.status,
        requestId: err.requestId,
      },
      "retrying OpenFang request",
    );
    await this.ctx.sleep(delay);
  }

  private computeBackoff(attempt: number): number {
    const { baseDelayMs, maxDelayMs, jitter } = this.ctx.retry;
    const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    return capped + capped * jitter * Math.random();
  }

  private parseRetryAfter(header: string | null): number {
    const fallback = this.computeBackoff(0);
    if (!header) return fallback;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(this.ctx.retry.maxRetryAfterMs, seconds * 1_000);
    }
    const date = Date.parse(header);
    if (!Number.isNaN(date)) {
      const delta = date - Date.now();
      return Math.min(this.ctx.retry.maxRetryAfterMs, Math.max(0, delta));
    }
    return fallback;
  }

  private buildHeaders(spec: RequestSpec): Headers {
    const headers = new Headers();
    headers.set("Accept", spec.accept ?? "application/json");
    if (this.ctx.apiKey) headers.set("Authorization", `Bearer ${this.ctx.apiKey}`);
    if (spec.body !== undefined) headers.set("Content-Type", "application/json");
    return headers;
  }

  private buildUrl(spec: RequestSpec): string {
    const url = new URL(`${this.ctx.baseUrl}${spec.path}`);
    if (spec.query) {
      for (const [key, value] of Object.entries(spec.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

/** `429` and `5xx` are retryable for the classes that opt in via `maxRetries`. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Read an error body without letting a failed read mask the original status. */
async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
