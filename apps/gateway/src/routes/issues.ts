import { type SQL, and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type ActorKey, resolveRef, resolveRefs } from "~/api/actors";
import { createIssueSchema, serializeIssue, updateIssueSchema } from "~/api/dto";
import { ISSUE_PRIORITIES, ISSUE_STATUSES, statusToApi, statusToDb } from "~/api/enums";
import { findIssueByRef } from "~/api/lookups";
import { assertTransition } from "~/api/workflow";
import { assignments, boards, issues, users } from "~/db/schema";
import { requireActor, requireDb } from "~/http/context";
import { notFound } from "~/http/errors";
import {
  buildConnection,
  decodeCursor,
  pageArgsSchema,
  scopeKey,
  timestampIdKeySchema,
} from "~/http/pagination";
import { parseBody, parseQuery } from "~/http/validation";
import {
  type RouteDeps,
  assigneeKey,
  createdByKey,
  escapeLike,
  readJsonBody,
  refFor,
} from "~/routes/support";

const ISSUES_SORT = "updatedAt:desc,id:desc";

/** A comma-separated list of enum values, e.g. `status=todo,inProgress`. */
function csvEnum<T extends readonly [string, ...string[]]>(values: T) {
  const set = new Set<string>(values);
  return z.string().transform((raw, ctx) => {
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    for (const part of parts) {
      if (!set.has(part)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid value: ${part}` });
        return z.NEVER;
      }
    }
    return parts as T[number][];
  });
}

const issueListQuerySchema = pageArgsSchema
  .extend({
    boardId: z.string().uuid(),
    status: csvEnum(ISSUE_STATUSES).optional(),
    priority: csvEnum(ISSUE_PRIORITIES).optional(),
    assigneeType: z.enum(["user", "agent"]).optional(),
    assigneeId: z.string().uuid().optional(),
    query: z.string().min(1).max(200).optional(),
  })
  .refine((q) => (q.assigneeType === undefined) === (q.assigneeId === undefined), {
    message: "assigneeType and assigneeId must be provided together.",
    path: ["assigneeType"],
  });

export function makeIssueRoutes(deps: RouteDeps): Hono {
  const router = new Hono();

  // GET /issues — filtered, cursor-paginated list ordered by (updatedAt, id) DESC.
  router.get("/issues", async (c) => {
    const db = requireDb(deps.db);
    const q = parseQuery(issueListQuerySchema, c.req.query());

    const [board] = await db
      .select({ id: boards.id })
      .from(boards)
      .where(eq(boards.id, q.boardId))
      .limit(1);
    if (!board) throw notFound("Board not found.");

    const scope = scopeKey("issues", ISSUES_SORT, {
      boardId: q.boardId,
      status: q.status,
      priority: q.priority,
      assigneeType: q.assigneeType,
      assigneeId: q.assigneeId,
      query: q.query,
    });

    const conditions: (SQL | undefined)[] = [eq(issues.boardId, q.boardId)];
    if (q.status?.length) conditions.push(inArray(issues.status, q.status.map(statusToDb)));
    if (q.priority?.length) conditions.push(inArray(issues.priority, q.priority));
    if (q.assigneeType && q.assigneeId) {
      conditions.push(eq(issues.assigneeType, q.assigneeType));
      conditions.push(eq(issues.assigneeId, q.assigneeId));
    }
    if (q.query) {
      const like = `%${escapeLike(q.query)}%`;
      conditions.push(
        or(ilike(issues.title, like), ilike(sql`${boards.slug} || '-' || ${issues.number}`, like)),
      );
    }
    if (q.after) {
      const [updatedAt, id] = decodeCursor(scope, q.after, timestampIdKeySchema);
      // Keyset seek at millisecond precision. JS Dates and API timestamps are
      // ms-precise while the stored value carries sub-ms microseconds; both
      // sides are truncated to ms so the boundary row is neither re-emitted nor
      // silently skipped. The cursor timestamp is bound as a string (raw-binding
      // a Date via `sql` fails in postgres-js).
      conditions.push(
        sql`(date_trunc('milliseconds', ${issues.updatedAt}), ${issues.id}) < (${String(updatedAt)}::timestamptz, ${id}::uuid)`,
      );
    }

    const rows = await db
      .select({ issue: issues, boardSlug: boards.slug })
      .from(issues)
      .innerJoin(boards, eq(issues.boardId, boards.id))
      .where(and(...conditions))
      .orderBy(sql`date_trunc('milliseconds', ${issues.updatedAt}) desc`, desc(issues.id))
      .limit(q.first + 1);

    const keys: ActorKey[] = [];
    for (const row of rows) {
      const ak = assigneeKey(row.issue);
      if (ak) keys.push(ak);
      const ck = createdByKey(row.issue);
      if (ck) keys.push(ck);
    }
    const refs = await resolveRefs(db, keys);

    const connection = buildConnection(
      rows,
      q.first,
      scope,
      (row) =>
        serializeIssue(
          row.issue,
          row.boardSlug,
          refFor(refs, assigneeKey(row.issue)),
          refFor(refs, createdByKey(row.issue)),
        ),
      (row) => [row.issue.updatedAt.toISOString(), row.issue.id],
    );
    return c.json(connection);
  });

  // POST /issues — create; server-allocates the board-scoped number.
  router.post("/issues", async (c) => {
    const db = requireDb(deps.db);
    const actor = await requireActor(c, db);
    const input = parseBody(createIssueSchema, await readJsonBody(c));

    const created = await db.transaction(async (tx) => {
      const [board] = await tx
        .select({ id: boards.id, slug: boards.slug })
        .from(boards)
        .where(eq(boards.id, input.boardId))
        .limit(1);
      if (!board) throw notFound("Board not found.");

      if (input.assignee && input.assignee.type === "user") {
        const [assignee] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, input.assignee.id))
          .limit(1);
        if (!assignee) throw notFound("Assignee not found.");
      }

      // Atomic per-board number allocation (never MAX(number)+1, which races).
      const [counter] = await tx
        .update(boards)
        .set({ issueCounter: sql`${boards.issueCounter} + 1` })
        .where(eq(boards.id, board.id))
        .returning({ issueCounter: boards.issueCounter });

      const [issue] = await tx
        .insert(issues)
        .values({
          boardId: board.id,
          number: counter.issueCounter,
          title: input.title,
          description: input.description ?? null,
          status: input.status ? statusToDb(input.status) : undefined,
          priority: input.priority ?? undefined,
          sortOrder: input.sortOrder ?? undefined,
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          assigneeType: input.assignee ? input.assignee.type : null,
          assigneeId: input.assignee ? input.assignee.id : null,
          createdBy: actor.type === "user" ? actor.id : null,
        })
        .returning();

      if (input.assignee) {
        await tx.insert(assignments).values({
          issueId: issue.id,
          assigneeType: input.assignee.type,
          assigneeId: input.assignee.id,
          assignedBy: actor.type === "user" ? actor.id : null,
        });
      }
      return { issue, boardSlug: board.slug };
    });

    const [assignee, createdBy] = await Promise.all([
      resolveRef(db, assigneeKey(created.issue)),
      resolveRef(db, createdByKey(created.issue)),
    ]);
    c.header("Location", `/api/v1/issues/${created.issue.id}`);
    return c.json(serializeIssue(created.issue, created.boardSlug, assignee, createdBy), 201);
  });

  // GET /issues/{issueId} — by UUID or human identifier.
  router.get("/issues/:issueId", async (c) => {
    const db = requireDb(deps.db);
    const found = await findIssueByRef(db, c.req.param("issueId"));
    if (!found) throw notFound("Issue not found.");

    const [assignee, createdBy] = await Promise.all([
      resolveRef(db, assigneeKey(found.issue)),
      resolveRef(db, createdByKey(found.issue)),
    ]);
    return c.json(serializeIssue(found.issue, found.boardSlug, assignee, createdBy));
  });

  // PATCH /issues/{issueId} — partial update; enforces the status workflow.
  router.patch("/issues/:issueId", async (c) => {
    const db = requireDb(deps.db);
    const actor = await requireActor(c, db);
    const found = await findIssueByRef(db, c.req.param("issueId"));
    if (!found) throw notFound("Issue not found.");
    const input = parseBody(updateIssueSchema, await readJsonBody(c));

    const patch: Partial<typeof issues.$inferInsert> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.status !== undefined) patch.status = statusToDb(input.status);
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    if (input.dueDate !== undefined) patch.dueDate = input.dueDate ? new Date(input.dueDate) : null;
    if (input.assignee !== undefined) {
      patch.assigneeType = input.assignee ? input.assignee.type : null;
      patch.assigneeId = input.assignee ? input.assignee.id : null;
    }

    const updated = await db.transaction(async (tx) => {
      // Lock the row and re-read the authoritative status inside the tx: the
      // workflow gate must run against the committed state, or two concurrent
      // PATCHes on the same issue could both pass and race the transition.
      const [current] = await tx
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, found.issue.id))
        .for("update")
        .limit(1);
      if (!current) throw notFound("Issue not found.");
      if (input.status !== undefined) {
        assertTransition(statusToApi(current.status), input.status);
      }
      if (input.assignee && input.assignee.type === "user") {
        const [assignee] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, input.assignee.id))
          .limit(1);
        if (!assignee) throw notFound("Assignee not found.");
      }

      const [row] = await tx
        .update(issues)
        .set(patch)
        .where(eq(issues.id, found.issue.id))
        .returning();
      if (input.assignee) {
        await tx.insert(assignments).values({
          issueId: row.id,
          assigneeType: input.assignee.type,
          assigneeId: input.assignee.id,
          assignedBy: actor.type === "user" ? actor.id : null,
        });
      }
      return row;
    });

    const [assignee, createdBy] = await Promise.all([
      resolveRef(db, assigneeKey(updated)),
      resolveRef(db, createdByKey(updated)),
    ]);
    return c.json(serializeIssue(updated, found.boardSlug, assignee, createdBy));
  });

  return router;
}
