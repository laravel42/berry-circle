import { z } from 'zod';

import { fieldError } from '../http/body.ts';
import type { FieldError } from '../http/errors.ts';

/**
 * Zod v4 boundary schemas for the password auth endpoints.
 *
 * The wire contract is `{ email, password }` for both sign-in and sign-up
 * (Requirements 1.8, 2.4, 2.5). A policy violation is reported as a 422
 * `VALIDATION_FAILED` whose `details.fields[].path` names the offending field
 * in JSON Pointer form (`/email`, `/password`) so it decodes against the same
 * `FieldError` contract every other mount already emits.
 *
 * These validate shape and policy only; they do not decide whether an email is
 * registered. Sign-in maps every credential failure to the uniform 401 so the
 * schema never distinguishes "unknown email" from "wrong password".
 */

/**
 * A single, deliberately permissive address check: exactly one `@`, a dot in
 * the domain, no whitespace. Fuller RFC validation belongs to delivery, not the
 * boundary; this only refuses input that is not plausibly an address. `trim`
 * runs first so surrounding whitespace never counts against `max(320)`.
 */
export const email = z
   .string()
   .trim()
   .max(320)
   .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);

/**
 * Length bounds only. The lower bound is the sole strength policy; the upper
 * bound keeps a single request cheap to hash and sits under the bounded-body
 * reader.
 */
export const password = z.string().min(12).max(128);

/** `POST /api/v1/auth/sign-in` body. */
export const signInBody = z.object({ email, password });

/**
 * `POST /api/v1/auth/sign-up` body. No confirm field: confirmation is a
 * client-side concern the frontend handles, and the wire shape stays
 * `{ email, password }` identical to sign-in.
 */
export const signUpBody = z.object({ email, password });

export type SignInBody = z.infer<typeof signInBody>;
export type SignUpBody = z.infer<typeof signUpBody>;

/**
 * Turns a Zod issue path into a JSON Pointer (`['email']` → `/email`) so the
 * validation envelope matches the `FieldError` contract. A top-level failure
 * with an empty path becomes `/`, the same root the shared body reader uses.
 */
function pointer(path: ReadonlyArray<PropertyKey>): string {
   if (path.length === 0) return '/';
   return path.map((segment) => `/${String(segment)}`).join('');
}

/**
 * Adapts a Zod parse failure to the shared `FieldError[]` shape, preserving
 * Zod's own issue `code` and message and naming each field by JSON Pointer.
 */
export function toFieldErrors(error: z.ZodError): FieldError[] {
   return error.issues.map((issue) => fieldError(pointer(issue.path), issue.code, issue.message));
}
