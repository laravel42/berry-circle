/**
 * Error normalization for the OpenFang adapter (BERR-20).
 *
 * The upstream surface returns handler errors as `{ "error": string }`, but
 * Axum framework rejections (bad/missing JSON) and transport failures do not
 * fit that shape. Per the consumption contract
 * (`docs/api/openfang-gateway-consumption.md`) the adapter MUST normalize every
 * non-2xx response — and every transport failure — into one stable error type
 * so the gateway never leaks raw upstream shapes to its clients.
 */

/** Stable, `SCREAMING_SNAKE_CASE` error codes. Treat these as API contract. */
export type OpenFangErrorCode =
  | "INVALID_REQUEST"
  | "UPSTREAM_BAD_REQUEST"
  | "UPSTREAM_UNAUTHORIZED"
  | "UPSTREAM_FORBIDDEN"
  | "UPSTREAM_NOT_FOUND"
  | "UPSTREAM_PAYLOAD_TOO_LARGE"
  | "UPSTREAM_RATE_LIMITED"
  | "UPSTREAM_SERVER_ERROR"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_INVALID_RESPONSE"
  | "STREAM_INTERRUPTED";

export interface OpenFangErrorOptions {
  /** Upstream HTTP status, when the failure came from a response. */
  status?: number;
  /** `x-request-id` echoed by upstream; recorded for diagnostics. */
  requestId?: string | null;
  /** Parsed `Retry-After`, in milliseconds, for a `429`. */
  retryAfterMs?: number;
  /** Message extracted from the upstream `{ error }` body, if any. */
  upstreamMessage?: string;
  /** Underlying cause (network error, ZodError, JSON parse failure). */
  cause?: unknown;
}

/**
 * The single error type thrown by the adapter. Carries a stable `code`, the
 * upstream status when known, and enough diagnostic context (`requestId`,
 * `retryAfterMs`) for the gateway to log and reconcile without re-parsing.
 */
export class OpenFangError extends Error {
  readonly code: OpenFangErrorCode;
  readonly status?: number;
  readonly requestId?: string | null;
  readonly retryAfterMs?: number;
  readonly upstreamMessage?: string;

  constructor(code: OpenFangErrorCode, message: string, options: OpenFangErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "OpenFangError";
    this.code = code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs;
    this.upstreamMessage = options.upstreamMessage;
  }

  /**
   * Suggested status for the gateway to surface to its own clients. Advisory:
   * the route layer owns the final public mapping. Upstream failures are
   * integration faults, so most collapse to `502`; a genuine not-found and a
   * rate limit are propagated, and a timeout becomes `504`.
   */
  get gatewayStatus(): number {
    switch (this.code) {
      case "INVALID_REQUEST":
        return 400;
      case "UPSTREAM_NOT_FOUND":
        return 404;
      case "UPSTREAM_RATE_LIMITED":
        return 429;
      case "UPSTREAM_TIMEOUT":
        return 504;
      default:
        return 502;
    }
  }

  /**
   * Berry's stable, client-safe error envelope, matching the gateway's central
   * handler. The message is a generic per-`code` string — the detailed
   * `this.message` (which folds in truncated raw upstream body text) stays for
   * logs/diagnostics only, so upstream internals never reach a browser client if
   * the route layer returns this envelope verbatim.
   */
  toErrorEnvelope(): { error: { code: OpenFangErrorCode; message: string } } {
    return { error: { code: this.code, message: publicMessageForCode(this.code) } };
  }

  /** Map an upstream HTTP status to a stable code. */
  static codeForStatus(status: number): OpenFangErrorCode {
    switch (status) {
      case 400:
        return "UPSTREAM_BAD_REQUEST";
      case 401:
        return "UPSTREAM_UNAUTHORIZED";
      case 403:
        return "UPSTREAM_FORBIDDEN";
      case 404:
        return "UPSTREAM_NOT_FOUND";
      case 413:
        return "UPSTREAM_PAYLOAD_TOO_LARGE";
      case 429:
        return "UPSTREAM_RATE_LIMITED";
      default:
        return status >= 500 ? "UPSTREAM_SERVER_ERROR" : "UPSTREAM_BAD_REQUEST";
    }
  }

  /**
   * Build an error from a non-2xx response. `body` is the raw response text;
   * upstream handler errors are `{ "error": string }` but framework rejections
   * are plain text, so we extract the handler message when present and fall back
   * to a truncated body otherwise.
   */
  static fromResponse(
    method: string,
    path: string,
    status: number,
    body: string,
    context: { requestId?: string | null; retryAfterMs?: number } = {},
  ): OpenFangError {
    const code = OpenFangError.codeForStatus(status);
    const upstreamMessage = extractUpstreamMessage(body);
    const detail = upstreamMessage ?? truncate(body);
    const message = `OpenFang ${method} ${path} failed with ${status}${
      detail ? `: ${detail}` : ""
    }`;
    return new OpenFangError(code, message, {
      status,
      requestId: context.requestId,
      retryAfterMs: context.retryAfterMs,
      upstreamMessage,
    });
  }
}

/** Generic, client-safe message per code — carries no raw upstream detail. */
export function publicMessageForCode(code: OpenFangErrorCode): string {
  switch (code) {
    case "INVALID_REQUEST":
      return "The request to the upstream service was invalid.";
    case "UPSTREAM_BAD_REQUEST":
      return "The upstream service rejected the request.";
    case "UPSTREAM_UNAUTHORIZED":
      return "The gateway is not authorized to call the upstream service.";
    case "UPSTREAM_FORBIDDEN":
      return "The upstream service refused the request.";
    case "UPSTREAM_NOT_FOUND":
      return "The requested upstream resource was not found.";
    case "UPSTREAM_PAYLOAD_TOO_LARGE":
      return "The request payload was too large for the upstream service.";
    case "UPSTREAM_RATE_LIMITED":
      return "The upstream service is rate limiting requests.";
    case "UPSTREAM_SERVER_ERROR":
      return "The upstream service reported an error.";
    case "UPSTREAM_UNAVAILABLE":
      return "The upstream service is unavailable.";
    case "UPSTREAM_TIMEOUT":
      return "The upstream service timed out.";
    case "UPSTREAM_INVALID_RESPONSE":
      return "The upstream service returned an unexpected response.";
    case "STREAM_INTERRUPTED":
      return "The upstream stream was interrupted.";
  }
}

/** Pull the handler `{ "error": string }` message out of a response body. */
function extractUpstreamMessage(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && "error" in parsed) {
      const value = (parsed as { error: unknown }).error;
      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch {
    // Framework rejection or non-JSON body; caller falls back to the raw text.
  }
  return undefined;
}

/** Clip an untrusted body so it is safe to fold into an error message. */
function truncate(body: string, max = 500): string {
  const trimmed = body.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
