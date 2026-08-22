import type { ZodError, ZodTypeAny, z } from "zod";
import { type FieldError, invalidRequest, validationFailed } from "~/http/errors";

/**
 * Translates Zod issues into the contract's `details.fields[]` shape. `base`
 * prefixes the JSON Pointer so query and header failures read as `/query/first`
 * or `/headers/idempotency-key` while body failures read as `/title`.
 */
export function zodIssuesToFields(error: ZodError, base: string[] = []): FieldError[] {
  return error.issues.map((issue) => ({
    path: `/${[...base, ...issue.path].map(String).join("/")}`,
    code: issue.code,
    message: issue.message,
  }));
}

/** Parses a request body; a schema failure becomes `422 VALIDATION_FAILED`. */
export function parseBody<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw validationFailed(zodIssuesToFields(result.error));
  }
  return result.data;
}

/** Parses query parameters; a schema failure becomes `400 INVALID_REQUEST`
 * (malformed parameters), distinct from a body validation failure. */
export function parseQuery<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw invalidRequest("One or more query parameters are invalid.", {
      fields: zodIssuesToFields(result.error, ["query"]),
    });
  }
  return result.data;
}
