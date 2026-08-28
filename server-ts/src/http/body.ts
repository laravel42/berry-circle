import type { Context } from 'hono';
import { ApiError, type FieldError } from './errors.ts';

/**
 * Request body decoding.
 *
 * Go's decoder is strict in ways a permissive JSON.parse is not, and each
 * strictness is observable: an unknown field is a 422 rather than a silently
 * ignored typo, and trailing content after the value is a 400. Clients were
 * written against that, so the strictness ports with the shape.
 */

const MAX_BODY_BYTES = 64 * 1024;

export class ValidationFailed extends ApiError {
   constructor(fields: FieldError[]) {
      super(422, 'VALIDATION_FAILED', 'The request is invalid.', { fields });
   }
}

export function fieldError(path: string, code: string, message: string): FieldError {
   return { path, code, message };
}

/** Throws unless every field passed; a no-op when `fields` is empty. */
export function assertValid(fields: FieldError[]): void {
   if (fields.length > 0) throw new ValidationFailed(fields);
}

const INVALID_JSON = ApiError.badRequest.bind(
   null,
   'Request body must contain one valid JSON value.'
);

function invalidValue(): ValidationFailed {
   return new ValidationFailed([
      fieldError('/', 'invalid_value', 'The request contains an unknown field or invalid value.'),
   ]);
}

/**
 * What a field may hold, so a wrong type is refused rather than coerced.
 *
 * Go decodes into a struct, so `{"name": 123}` fails in the decoder and never
 * reaches a handler. TypeScript has no such step: without a declared type,
 * `String(123)` would quietly store "123". These specs are that missing step.
 *
 * `null` means "absent" for every spec but `raw`, matching Go's pointer
 * fields — `*string` left nil by a JSON null is indistinguishable from one
 * that was never sent. `raw` is json.RawMessage, which Go reaches for exactly
 * when a handler must tell an explicit null from an omission.
 */
export type FieldSpec = 'string' | 'boolean' | 'number' | 'stringMap' | 'raw';

function matches(spec: FieldSpec, value: unknown): boolean {
   switch (spec) {
      case 'string':
         return typeof value === 'string';
      case 'boolean':
         return typeof value === 'boolean';
      case 'number':
         return typeof value === 'number' && Number.isFinite(value);
      case 'stringMap':
         return (
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value) &&
            Object.values(value).every((entry) => typeof entry === 'string')
         );
      case 'raw':
         return true;
   }
}

/**
 * Reads one JSON object, rejecting anything Go's decoder would reject.
 *
 * Returns the raw bytes alongside the value because idempotency fingerprints
 * are taken over exactly what arrived, not over a re-serialisation of it.
 */
export async function decodeBody<T>(
   context: Context,
   schema: Record<string, FieldSpec>
): Promise<{ value: T; raw: string }> {
   const mediaType = (context.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
   if (mediaType !== 'application/json') {
      throw new ApiError(
         415,
         'UNSUPPORTED_MEDIA_TYPE',
         'Content-Type must be application/json.'
      );
   }

   const raw = await context.req.text();
   // Bytes, not characters: a body of multi-byte characters is larger than
   // its length suggests, and the limit is a byte limit.
   if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
   }
   if (raw.trim() === '') throw INVALID_JSON();

   let parsed: unknown;
   try {
      parsed = JSON.parse(raw);
   } catch {
      // Go distinguishes an empty body from malformed content, and both from
      // trailing data after a complete value. JSON.parse collapses the last
      // two, so a body that parses as a prefix is not reachable here; what
      // remains is the malformed case, which Go answers 400.
      throw INVALID_JSON();
   }
   if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw invalidValue();
   }

   // DisallowUnknownFields. A rejected typo is the point: silently dropping
   // `reduceMotion` would leave the caller believing a setting was saved.
   // Go reports an unknown field and a wrong type with the same message, so
   // both land here.
   const value: Record<string, unknown> = {};
   for (const [key, entry] of Object.entries(parsed)) {
      const spec = schema[key];
      if (spec === undefined) throw invalidValue();
      if (entry === null && spec !== 'raw') continue; // a nil pointer is an omission
      if (!matches(spec, entry)) throw invalidValue();
      value[key] = entry;
   }
   return { value: value as T, raw };
}
