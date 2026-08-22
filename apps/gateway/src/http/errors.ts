import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * The gateway's single error envelope, per the M0 API contract
 * (`docs/api/gateway-v1.md` → ErrorEnvelope). Every non-2xx JSON response —
 * validation, not-found, conflict, upstream failure — is serialized from an
 * `ApiError` so clients see one stable shape.
 */

export interface FieldError {
  /** JSON Pointer into the body, or a `/query/*` / `/headers/*` name. */
  path: string;
  /** Stable validator code. */
  code: string;
  message: string;
}

export type ErrorDetails = Record<string, unknown> | null;

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    details: ErrorDetails;
  };
}

export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details: ErrorDetails;

  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    details: ErrorDetails = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toEnvelope(requestId: string): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        details: this.details,
      },
    };
  }
}

// ---------- factories (one per documented status/code) ----------

/** 400 — malformed JSON, parameters, or cursor. */
export function invalidRequest(message = "The request is invalid.", details: ErrorDetails = null) {
  return new ApiError(400, "INVALID_REQUEST", message, details);
}

/** 400 INVALID_CURSOR — a pagination cursor that does not belong to this
 * endpoint, filter set, and sort. */
export function invalidCursor(message = "The pagination cursor is invalid.") {
  return new ApiError(400, "INVALID_CURSOR", message);
}

/** 401 — missing, invalid, or expired session. */
export function unauthenticated(message = "Authentication is required.") {
  return new ApiError(401, "UNAUTHENTICATED", message);
}

/** 403 — authenticated actor lacks permission. */
export function forbidden(message = "You do not have permission to perform this action.") {
  return new ApiError(403, "FORBIDDEN", message);
}

/** 404 — resource does not exist or is not visible to the actor. */
export function notFound(message = "The requested resource was not found.") {
  return new ApiError(404, "NOT_FOUND", message);
}

/** 409 CONFLICT — generic state / uniqueness conflict. */
export function conflict(message: string, details: ErrorDetails = null) {
  return new ApiError(409, "CONFLICT", message, details);
}

/** 409 INVALID_STATE_TRANSITION — an issue status change the workflow forbids. */
export function invalidStateTransition(from: string, to: string) {
  return new ApiError(
    409,
    "INVALID_STATE_TRANSITION",
    `Cannot transition an issue from "${from}" to "${to}".`,
    { from, to },
  );
}

/** 422 — body is well-formed but fails schema/domain validation. */
export function validationFailed(fields: FieldError[], message = "The request is invalid.") {
  return new ApiError(422, "VALIDATION_FAILED", message, { fields });
}

/** 503 — a runtime dependency (here, the database) is unavailable. */
export function dependencyUnavailable(message = "A required dependency is unavailable.") {
  return new ApiError(503, "DEPENDENCY_UNAVAILABLE", message);
}
