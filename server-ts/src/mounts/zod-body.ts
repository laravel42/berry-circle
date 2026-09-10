import type { Context } from 'hono';
import type { z } from 'zod';
import { assertValid, fieldError } from '../http/body.ts';
import { ApiError } from '../http/errors.ts';

const MAX_BYTES = 1 << 20;

/**
 * One JSON body, parsed into a typed value at the boundary.
 *
 * Unknown fields are the schema's business: every schema here is
 * `z.strictObject`, so a typo is refused rather than silently ignored.
 */
export async function readJson<T>(context: Context, schema: z.ZodType<T>): Promise<T> {
   const raw = await context.req.text();
   if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
   }
   let parsed: unknown;
   try {
      parsed = JSON.parse(raw.trim() === '' ? '{}' : raw);
   } catch {
      throw new ApiError(400, 'INVALID_BODY', 'Request body is not valid JSON.');
   }
   const result = schema.safeParse(parsed);
   if (!result.success) {
      assertValid(
         result.error.issues.map((issue) =>
            fieldError(`/${issue.path.map(String).join('/')}`, issue.code, issue.message)
         )
      );
      throw new ApiError(400, 'INVALID_BODY', 'Request body is not valid JSON.');
   }
   return result.data;
}
