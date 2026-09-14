import type { z } from 'zod';
import { assertValid, fieldError } from '../http/body.ts';
import { ApiError } from '../http/errors.ts';
import { Conflict, Forbidden, NotFound } from '../identity/errors.ts';
import { InvalidTransition } from '../core/issues.ts';

/** Body parsing for the work-tracking routes: one JSON value, validated once. */
const MAX_BODY_BYTES = 1 << 20;

export async function parseJsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
   const raw = await request.text();
   if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
   }
   let parsed: unknown;
   try {
      parsed = raw.trim() === '' ? {} : JSON.parse(raw);
   } catch {
      throw new ApiError(400, 'INVALID_REQUEST', 'The request body is not valid JSON.');
   }
   const result = schema.safeParse(parsed);
   if (result.success) return result.data;
   assertValid(
      result.error.issues.map((issue) =>
         fieldError(`/${issue.path.map(String).join('/')}`, issue.code, issue.message)
      )
   );
   throw new ApiError(422, 'VALIDATION_FAILED', 'The request is invalid.');
}

export function rethrowAs(resource: string): (error: unknown) => never {
   return (error: unknown) => {
      if (error instanceof NotFound) throw ApiError.notFound(resource);
      if (error instanceof Forbidden) {
         throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
      }
      throw error;
   };
}

/** The code a batch reports for one item it could not apply. */
export function failureCode(error: unknown): string {
   if (error instanceof ApiError) return error.code;
   if (error instanceof NotFound) return 'NOT_FOUND';
   if (error instanceof Forbidden) return 'FORBIDDEN';
   if (error instanceof InvalidTransition) return 'INVALID_STATE_TRANSITION';
   if (error instanceof Conflict) return 'CONFLICT';
   throw error;
}
