import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

/**
 * Envelope-shaped API errors.
 *
 * `ApiError` carries the envelope as *data* (status/code/message/details) rather
 * than a pre-built `Response`, so the central `app.onError` boundary can render
 * it with the request-scoped `error.requestId` (and preserve the `X-Request-Id`
 * header) that the gateway-v1 contract requires. `code`s are the stable
 * `SCREAMING_SNAKE_CASE` strings from that contract.
 */

/** A single field-level validation error, per the contract's `details.fields`. */
export type FieldError = {
  path: string;
  code: string;
  message: string;
};

export type ErrorDetails = Record<string, unknown> | null;

export type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    requestId: string;
    details: ErrorDetails;
  };
};

export class ApiError extends HTTPException {
  readonly code: string;
  readonly details: ErrorDetails;

  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    details: ErrorDetails = null,
  ) {
    super(status, { message });
    this.code = code;
    this.details = details;
  }
}

/** Builds an envelope-shaped `ApiError`. Throw it; `app.onError` renders it. */
export function apiError(
  status: ContentfulStatusCode,
  code: string,
  message: string,
  details: ErrorDetails = null,
): ApiError {
  return new ApiError(status, code, message, details);
}

export const invalidRequest = (message = "The request is invalid.", details: ErrorDetails = null) =>
  apiError(400, "INVALID_REQUEST", message, details);

export const invalidCursor = (message = "The pagination cursor is invalid.") =>
  apiError(400, "INVALID_CURSOR", message);

export const unauthenticated = (message = "Authentication required.") =>
  apiError(401, "UNAUTHENTICATED", message);

export const forbidden = (message = "You do not have permission to perform this action.") =>
  apiError(403, "FORBIDDEN", message);

export const notFound = (message = "The requested resource was not found.") =>
  apiError(404, "NOT_FOUND", message);

export const conflict = (message: string, details: ErrorDetails = null) =>
  apiError(409, "CONFLICT", message, details);

export const invalidStateTransition = (from: string, to: string) =>
  apiError(
    409,
    "INVALID_STATE_TRANSITION",
    `Cannot transition an issue from "${from}" to "${to}".`,
    {
      from,
      to,
    },
  );

export const validationFailed = (fields: FieldError[], message = "The request is invalid.") =>
  apiError(422, "VALIDATION_FAILED", message, { fields });

export const dependencyUnavailable = (message = "A required dependency is unavailable.") =>
  apiError(503, "DEPENDENCY_UNAVAILABLE", message);

/** Maps a Zod error to the contract's `details.fields` validation shape. */
export function validationError(error: z.ZodError, message = "The request is invalid."): ApiError {
  const fields: FieldError[] = error.issues.map((issue) => ({
    path: `/${issue.path.join("/")}`,
    code: issue.code,
    message: issue.message,
  }));
  return apiError(422, "VALIDATION_FAILED", message, { fields });
}

/** Default stable error code for a bare HTTP status (non-`ApiError` throws). */
export function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "INVALID_REQUEST";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 422:
      return "VALIDATION_FAILED";
    case 429:
      return "RATE_LIMITED";
    case 502:
      return "DEPENDENCY_BAD_RESPONSE";
    case 503:
      return "DEPENDENCY_UNAVAILABLE";
    default:
      return "INTERNAL";
  }
}
