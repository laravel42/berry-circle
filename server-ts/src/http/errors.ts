/**
 * Berry's only JSON error representation.
 *
 * The shape is a public contract: `frontend/lib/api.ts` parses exactly
 * `{ error: { code, message, requestId, details } }` and reads the
 * `x-request-id` response header. The shape is fixed down to the details —
 * same keys, same order, same `details: null` rather than an omitted field.
 */

/** A stable validation detail using JSON Pointer-style paths. */
export interface FieldError {
   path: string;
   code: string;
   message: string;
}

/** The contract shape for field-level failures. */
export interface ValidationDetails {
   fields: FieldError[];
}

export interface ErrorBody {
   code: string;
   message: string;
   requestId: string;
   details: unknown;
}

export interface ErrorEnvelope {
   error: ErrorBody;
}

/**
 * Codes are SCREAMING_SNAKE and must start with a letter.
 *
 * A code that does not match is not reported as given: Go downgrades the whole
 * response to a 500 INTERNAL rather than emit an envelope a client cannot
 * switch on, because a typo'd code is a bug in Berry and should look like one.
 */
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;

export function buildErrorEnvelope(
   status: number,
   code: string,
   message: string,
   details: unknown,
   requestId: string
): { status: number; body: ErrorEnvelope } {
   if (!ERROR_CODE.test(code)) {
      return {
         status: 500,
         body: {
            error: {
               code: 'INTERNAL',
               message: 'Internal server error.',
               requestId,
               details: null,
            },
         },
      };
   }
   return {
      status,
      body: {
         error: {
            code,
            message,
            requestId,
            // Go's `any` field marshals a missing value as null, and the
            // frontend's zod schema expects the key to be present.
            details: details ?? null,
         },
      },
   };
}

/**
 * An error carrying its own public envelope.
 *
 * Go threads status and code through explicit `WriteError` calls; the
 * equivalent here is a typed error a handler can throw and one place that
 * turns it into a response, so a route cannot half-write a body and then fail.
 */
export class ApiError extends Error {
   readonly status: number;
   readonly code: string;
   readonly details: unknown;

   constructor(status: number, code: string, message: string, details: unknown = null) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.details = details;
   }

   static badRequest(message: string, details: unknown = null): ApiError {
      return new ApiError(400, 'INVALID_REQUEST', message, details);
   }

   /**
    * Deliberately constant, and deliberately these exact words: every failed
    * credential looks identical, so nothing distinguishes "no token" from
    * "expired" from "malformed" — and the string is what the Go server sends
    * today, captured from a live 401.
    */
   static unauthorized(): ApiError {
      return new ApiError(401, 'UNAUTHENTICATED', 'Authentication required.');
   }

   static forbidden(): ApiError {
      return new ApiError(403, 'FORBIDDEN', 'You do not have access to this workspace.');
   }

   static notFound(resource: string): ApiError {
      return new ApiError(404, 'NOT_FOUND', `${resource} not found.`);
   }

   static routeNotFound(): ApiError {
      return new ApiError(404, 'NOT_FOUND', 'Route not found.');
   }

   static internal(): ApiError {
      return new ApiError(500, 'INTERNAL', 'Internal server error.');
   }
}

/**
 * An ApiError carrying extra response headers.
 *
 * Some endpoints set a header before doing the work, so it lands on the
 * failure as well as the success — `Cache-Control: no-store` on anything that
 * handles a secret, most of all.
 */
export class DecoratedApiError extends ApiError {
   readonly headers: Readonly<Record<string, string>>;

   constructor(error: ApiError, headers: Record<string, string>) {
      super(error.status, error.code, error.message, error.details);
      this.headers = headers;
   }
}
