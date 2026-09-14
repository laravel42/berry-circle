import type { Context } from 'hono';
import type { z } from 'zod';
import { assertValid, fieldError } from './body.ts';
import { ApiError } from './errors.ts';

/**
 * A JSON body parsed by a Zod schema, for mounts that validate with Zod
 * rather than the Go-compatible `decodeBody`. The failure statuses match it:
 * 415 for another media type, 413 when too large, 400 for malformed JSON,
 * 422 with one field error per issue.
 */
export async function readJson<T extends z.ZodType>(
   context: Context,
   schema: T,
   maxBytes = 1_000_000
): Promise<z.output<T>> {
   const mediaType = (context.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
   if (mediaType !== 'application/json') {
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
   }
   const raw = await context.req.text();
   if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
   }
   let value: unknown;
   try {
      value = JSON.parse(raw);
   } catch {
      throw ApiError.badRequest('Request body must be valid JSON.');
   }
   const parsed = schema.safeParse(value);
   if (!parsed.success) {
      assertValid(
         parsed.error.issues.map((issue) =>
            fieldError('/' + issue.path.map(String).join('/'), issue.code, issue.message)
         )
      );
      throw ApiError.badRequest('Request body is invalid.');
   }
   return parsed.data;
}
