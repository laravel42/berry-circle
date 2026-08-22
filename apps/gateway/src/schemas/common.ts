import { z } from "zod";

/**
 * Primitives, actor references, pagination, and the error envelope shared by
 * every gateway resource DTO.
 *
 * These schemas encode the *public* wire contract (`docs/api/gateway-v1.md`),
 * not the Postgres storage shape. Field naming is `camelCase`; identifiers are
 * UUID strings; timestamps are UTC RFC 3339 (`...Z`). Parse untrusted input at
 * the boundary, then trust the inferred type inside (see the coding playbook).
 */

// ---------- id and timestamp aliases ----------

/** RFC 4122 UUID string. */
export const uuidSchema = z.string().uuid();
export type Uuid = z.infer<typeof uuidSchema>;

/**
 * RFC 3339 date-time in UTC. `.datetime()` defaults to rejecting timezone
 * offsets, so this enforces the contract's `...Z` form and rejects local-offset
 * timestamps.
 */
export const timestampSchema = z.string().datetime();
export type Timestamp = z.infer<typeof timestampSchema>;

/** Opaque, URL-safe pagination cursor. Clients MUST NOT parse or construct it. */
export const cursorSchema = z.string().min(1);
export type Cursor = z.infer<typeof cursorSchema>;

/**
 * Absolute HTTP(S) URL. Plain `z.string().url()` also accepts `javascript:`,
 * `data:`, `file:`, and `ftp:` URLs; since these values (avatars) are embedded
 * in responses and SSE payloads that reach the browser, the scheme is
 * restricted to `http`/`https` to close that injection vector.
 */
export const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:$/.test(new URL(value).protocol), {
    message: "Must be an absolute http(s) URL.",
  });

// ---------- actors ----------

/** Discriminator selecting the namespace an actor id lives in. */
export const actorTypeSchema = z.enum(["user", "agent"]);
export type ActorType = z.infer<typeof actorTypeSchema>;

/**
 * An assignee or author as returned in responses. `name`/`avatarUrl` are the
 * display values captured at response time; ids stay stable even after the
 * actor is deleted.
 */
export const actorRefSchema = z.object({
  type: actorTypeSchema,
  id: uuidSchema,
  name: z.string(),
  avatarUrl: httpUrlSchema.nullable(),
});
export type ActorRef = z.infer<typeof actorRefSchema>;

/**
 * Assignment *input*: clients supply only `type` + `id`; the gateway resolves
 * the display fields. Used by issue create/update, distinct from {@link actorRefSchema}.
 */
export const assigneeInputSchema = z.object({
  type: actorTypeSchema,
  id: uuidSchema,
});
export type AssigneeInput = z.infer<typeof assigneeInputSchema>;

// ---------- pagination ----------

/** Query parameters accepted by every collection endpoint. */
export const paginationQuerySchema = z.object({
  first: z.coerce.number().int().min(1).max(100).default(50),
  after: cursorSchema.optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: cursorSchema.nullable(),
});
export type PageInfo = z.infer<typeof pageInfoSchema>;

/**
 * Builds the connection (paged collection) schema for a node type. Every
 * collection endpoint returns `{ nodes, pageInfo }` with `nodes` in the
 * endpoint's documented stable sort order.
 */
export function connectionSchema<T extends z.ZodTypeAny>(node: T) {
  return z.object({
    nodes: z.array(node),
    pageInfo: pageInfoSchema,
  });
}
export type Connection<T> = {
  nodes: T[];
  pageInfo: PageInfo;
};

/**
 * Parses a comma-separated query value (e.g. `status=todo,inProgress`) into a
 * validated, non-empty array of enum members. An empty list or any unknown
 * member is a validation error.
 */
export function commaSeparated<T extends z.ZodEnum<[string, ...string[]]>>(schema: T) {
  return z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .pipe(z.array(schema).min(1));
}

/** Refinement predicate: at least one key is present (for PATCH subset bodies). */
export const hasAtLeastOneKey = (value: object): boolean => Object.keys(value).length > 0;

/**
 * `Idempotency-Key` request header for mutating create/dispatch endpoints: an
 * opaque, client-generated string of 16–128 characters. Shared here so every
 * idempotent route validates the header identically.
 */
export const idempotencyKeySchema = z.string().min(16).max(128);
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

// ---------- errors ----------

/**
 * Stable, machine-readable error codes defined by the contract: the default
 * per-status codes plus the domain-specific codes. Exported for constructing
 * and asserting errors; the wire envelope itself keeps `code` as a plain string
 * so consumers tolerate codes added in future additive releases.
 */
export const ERROR_CODES = [
  "INVALID_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "DEPENDENCY_BAD_RESPONSE",
  "DEPENDENCY_UNAVAILABLE",
  "INTERNAL",
  "INVALID_CURSOR",
  "CURSOR_EXPIRED",
  "INVALID_STATE_TRANSITION",
  "ACTIVE_RUN_EXISTS",
  "IDEMPOTENCY_CONFLICT",
  "RUN_TERMINAL",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** A single field-level validation error inside `error.details.fields`. */
export const fieldErrorSchema = z.object({
  /** JSON Pointer, or a query/header name prefixed with `/query/` or `/headers/`. */
  path: z.string(),
  /** Stable validator code. */
  code: z.string(),
  message: z.string(),
});
export type FieldError = z.infer<typeof fieldErrorSchema>;

/**
 * Structured, client-safe error context. `fields` carries validation errors;
 * other domain codes attach their own keys (e.g. `from`/`to`, `runId`), so this
 * stays open via `.passthrough()`. The whole object may be `null`.
 */
export const errorDetailsSchema = z
  .object({
    fields: z.array(fieldErrorSchema).optional(),
  })
  .passthrough()
  .nullable();
export type ErrorDetails = z.infer<typeof errorDetailsSchema>;

/** The single envelope used by every non-2xx JSON response. */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    requestId: z.string(),
    details: errorDetailsSchema,
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
