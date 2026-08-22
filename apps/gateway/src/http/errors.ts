import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

/**
 * Envelope-shaped API errors.
 *
 * The central handler in `src/app.ts` returns `err.getResponse()` for any
 * thrown `HTTPException`, so these helpers attach a response whose body is the
 * canonical `{ error: { code, message } }` envelope. Throwing them keeps error
 * shaping consistent with `app.notFound`/`app.onError` instead of scattering
 * `c.json({ error: ... })` through handlers. `code`s are the stable
 * `SCREAMING_SNAKE_CASE` strings from the gateway-v1 contract.
 */

type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

/** Builds an `HTTPException` carrying the standard error envelope. */
export function apiError(
  status: ContentfulStatusCode,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): HTTPException {
  const body: ErrorBody = { error: { code, message, ...(details ? { details } : {}) } };
  return new HTTPException(status, {
    res: Response.json(body, { status }),
  });
}

export const invalidRequest = (message = "The request is invalid.") =>
  apiError(400, "INVALID_REQUEST", message);

export const unauthenticated = (message = "Authentication required.") =>
  apiError(401, "UNAUTHENTICATED", message);

export const forbidden = (message = "You do not have permission to perform this action.") =>
  apiError(403, "FORBIDDEN", message);

/** Maps a Zod error to the contract's `details.fields` validation shape. */
export function validationError(
  error: z.ZodError,
  message = "The request is invalid.",
): HTTPException {
  const fields = error.issues.map((issue) => ({
    path: `/${issue.path.join("/")}`,
    code: issue.code,
    message: issue.message,
  }));
  return apiError(422, "VALIDATION_FAILED", message, { fields });
}
