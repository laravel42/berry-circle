import type { z } from 'zod';

/** Parses a response body, naming what failed rather than returning a blank. */
export function parseResponse<T extends z.ZodTypeAny>(schema: T, json: unknown, what: string): z.infer<T> {
   const parsed = schema.safeParse(json);
   if (!parsed.success) throw new Error(`${what} response was not recognized`);
   return parsed.data;
}
