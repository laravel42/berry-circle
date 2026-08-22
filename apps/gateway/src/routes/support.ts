import type { InferSelectModel } from "drizzle-orm";
import type { Context } from "hono";
import type { ActorKey, ActorRef } from "~/api/actors";
import { refKey } from "~/api/actors";
import type { BerryDb } from "~/db/client";
import type { issues } from "~/db/schema";
import { invalidRequest } from "~/http/errors";

/** Dependencies injected into a route factory. `db` is nullable so `createApp`
 * stays constructible with no database (health/unit contexts); handlers call
 * `requireDb` before any storage access. */
export interface RouteDeps {
  db: BerryDb | null;
}

/** Reads and parses a JSON body, mapping a parse failure to `400 INVALID_REQUEST`
 * (malformed JSON) rather than a validation error. */
export async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw invalidRequest("The request body is not valid JSON.");
  }
}

type IssueRow = InferSelectModel<typeof issues>;

/** The current (denormalized) assignee of an issue as an actor key, or null. */
export function assigneeKey(row: IssueRow): ActorKey | null {
  return row.assigneeType && row.assigneeId ? { type: row.assigneeType, id: row.assigneeId } : null;
}

/** The creator of an issue as an actor key. Only user creators are stored
 * (`issues.created_by` is a users FK); agent-created issues carry a null
 * creator until the schema gains a polymorphic creator column. */
export function createdByKey(row: IssueRow): ActorKey | null {
  return row.createdBy ? { type: "user", id: row.createdBy } : null;
}

/** Looks up a resolved ref from a batch map for an optional key. */
export function refFor(refs: Map<string, ActorRef>, key: ActorKey | null): ActorRef | null {
  return key ? (refs.get(refKey(key)) ?? null) : null;
}

/** Escapes LIKE/ILIKE wildcards in user-supplied search text (default `\` escape). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
