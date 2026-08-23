import { type SQL, and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type ActorType, requiredRef, resolveRefRequired, resolveRefs } from "~/api/actors";
import {
  type CommentResource,
  createCommentSchema,
  serializeComment,
  updateCommentSchema,
} from "~/api/dto";
import { findIssueByRef } from "~/api/lookups";
import { getAuthUser, requireAuth } from "~/auth/middleware";
import type { AuthEnv, AuthUser } from "~/auth/types";
import type { BerryDb } from "~/db/client";
import { comments } from "~/db/schema";
import { requireDb } from "~/http/context";
import { forbidden, notFound, validationFailed } from "~/http/errors";
import {
  buildConnection,
  decodeCursor,
  pageArgsSchema,
  scopeKey,
  timestampIdKeySchema,
} from "~/http/pagination";
import { parseBody, parseQuery } from "~/http/validation";
import { type RouteDeps, readJsonBody } from "~/routes/support";

const COMMENTS_SORT = "createdAt:asc,id:asc";

export function makeCommentRoutes(deps: RouteDeps): Hono<AuthEnv> {
  const router = new Hono<AuthEnv>();

  // GET /issues/{issueId}/comments — cursor-paginated, (createdAt, id) ASC.
  // Replies are ordinary nodes carrying parentId; the server never nests them.
  router.get("/issues/:issueId/comments", requireAuth, async (c) => {
    const db = requireDb(deps.db);
    const issue = await findIssueByRef(db, c.req.param("issueId"));
    if (!issue) throw notFound("Issue not found.");

    const page = parseQuery(pageArgsSchema, c.req.query());
    const scope = scopeKey("issue-comments", COMMENTS_SORT, { issueId: issue.issue.id });

    const conditions: (SQL | undefined)[] = [eq(comments.issueId, issue.issue.id)];
    if (page.after) {
      const [createdAt, id] = decodeCursor(scope, page.after, timestampIdKeySchema);
      // Keyset seek at millisecond precision (see the note in issues.ts): both
      // sides truncated to ms, cursor timestamp bound as a string.
      conditions.push(
        sql`(date_trunc('milliseconds', ${comments.createdAt}), ${comments.id}) > (${String(createdAt)}::timestamptz, ${id}::uuid)`,
      );
    }

    const rows = await db
      .select()
      .from(comments)
      .where(and(...conditions))
      .orderBy(sql`date_trunc('milliseconds', ${comments.createdAt}) asc`, asc(comments.id))
      .limit(page.first + 1);

    const refs = await resolveRefs(
      db,
      rows.map((row) => ({ type: row.authorType, id: row.authorId })),
    );

    const connection = buildConnection<(typeof rows)[number], CommentResource>(
      rows,
      page.first,
      scope,
      (row) => serializeComment(row, requiredRef(refs, { type: row.authorType, id: row.authorId })),
      (row) => [row.createdAt.toISOString(), row.id],
    );
    return c.json(connection);
  });

  // POST /issues/{issueId}/comments — author is always the authenticated actor.
  router.post("/issues/:issueId/comments", requireAuth, async (c) => {
    const db = requireDb(deps.db);
    const user = getAuthUser(c);
    const issue = await findIssueByRef(db, c.req.param("issueId"));
    if (!issue) throw notFound("Issue not found.");
    const input = parseBody(createCommentSchema, await readJsonBody(c));

    // Validate the parent and insert in one transaction with the parent row
    // locked, so a concurrent delete of the parent can't slip between the check
    // and the insert and turn the parent FK into a 500 instead of a clean 4xx.
    const comment = await db.transaction(async (tx) => {
      if (input.parentId) {
        const [parent] = await tx
          .select({ id: comments.id, issueId: comments.issueId, parentId: comments.parentId })
          .from(comments)
          .where(eq(comments.id, input.parentId))
          .for("update")
          .limit(1);
        if (!parent || parent.issueId !== issue.issue.id) {
          throw notFound("Parent comment not found.");
        }
        if (parent.parentId !== null) {
          // One-level threading: a reply cannot itself be a parent.
          throw validationFailed([
            {
              path: "/parentId",
              code: "invalid_parent",
              message: "A reply cannot be nested under another reply.",
            },
          ]);
        }
      }

      const [row] = await tx
        .insert(comments)
        .values({
          issueId: issue.issue.id,
          authorType: "user",
          authorId: user.id,
          body: input.body,
          parentId: input.parentId ?? null,
        })
        .returning();
      return row;
    });

    const author = await resolveRefRequired(db, {
      type: comment.authorType,
      id: comment.authorId,
    });
    c.header("Location", `/api/v1/comments/${comment.id}`);
    return c.json(serializeComment(comment, author), 201);
  });

  // GET /comments/{commentId}
  router.get("/comments/:commentId", requireAuth, async (c) => {
    const db = requireDb(deps.db);
    const comment = await findComment(db, c.req.param("commentId"));
    if (!comment) throw notFound("Comment not found.");

    const author = await resolveRefRequired(db, {
      type: comment.authorType,
      id: comment.authorId,
    });
    return c.json(serializeComment(comment, author));
  });

  // PATCH /comments/{commentId} — author (or admin) edits the body only.
  router.patch("/comments/:commentId", requireAuth, async (c) => {
    const db = requireDb(deps.db);
    const user = getAuthUser(c);
    const existing = await findComment(db, c.req.param("commentId"));
    if (!existing) throw notFound("Comment not found.");
    if (!canModify(user, existing.authorType, existing.authorId)) {
      throw forbidden("Only the author or an administrator may edit this comment.");
    }
    const input = parseBody(updateCommentSchema, await readJsonBody(c));

    const [updated] = await db
      .update(comments)
      .set({ body: input.body })
      .where(eq(comments.id, existing.id))
      .returning();

    const author = await resolveRefRequired(db, {
      type: updated.authorType,
      id: updated.authorId,
    });
    return c.json(serializeComment(updated, author));
  });

  // DELETE /comments/{commentId} — cascades to replies via the parent FK.
  router.delete("/comments/:commentId", requireAuth, async (c) => {
    const db = requireDb(deps.db);
    const user = getAuthUser(c);
    const existing = await findComment(db, c.req.param("commentId"));
    if (!existing) throw notFound("Comment not found.");
    if (!canModify(user, existing.authorType, existing.authorId)) {
      throw forbidden("Only the author or an administrator may delete this comment.");
    }

    await db.delete(comments).where(eq(comments.id, existing.id));
    return c.body(null, 204);
  });

  return router;
}

async function findComment(db: BerryDb, id: string) {
  const [comment] = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
  return comment ?? null;
}

function canModify(user: AuthUser, authorType: ActorType, authorId: string): boolean {
  return user.role === "admin" || (authorType === "user" && user.id === authorId);
}
