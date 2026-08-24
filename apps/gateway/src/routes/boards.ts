import { type InferSelectModel, type SQL, and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { statusToDb } from "~/api/enums";
import { getAuthUser, requireAuth } from "~/auth/middleware";
import type { AuthEnv } from "~/auth/types";
import { boards, issues } from "~/db/schema";
import { requireDb } from "~/http/context";
import { conflict, notFound } from "~/http/errors";
import {
  buildConnection,
  decodeCursor,
  pageArgsSchema,
  scopeKey,
  timestampIdKeySchema,
} from "~/http/pagination";
import { parseBody, parseQuery } from "~/http/validation";
import { type RouteDeps, readJsonBody } from "~/routes/support";
import {
  type Board,
  boardColumnSchema,
  createBoardRequestSchema,
  updateBoardRequestSchema,
} from "~/schemas/board";
import { uuidSchema } from "~/schemas/common";
import { issueStatusSchema } from "~/schemas/enums";

const BOARDS_SORT = "createdAt:desc,id:desc";
const SLUG_UNIQUE_INDEX = "boards_slug_key";
const storedColumnsSchema = z.array(boardColumnSchema);
/** Statuses that never block column removal. */
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

type BoardRow = InferSelectModel<typeof boards>;

/** Maps a stored board row to the public `Board` resource. */
function serializeBoard(row: BoardRow): Board {
  const columns = storedColumnsSchema.safeParse(row.columns);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    columns: columns.success ? columns.data : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseBoardId(raw: string): string {
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) throw notFound("Board not found.");
  return parsed.data;
}

/** Walks postgres-js / Drizzle error wrappers looking for unique_violation 23505. */
function isSlugConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = "code" in current ? current.code : undefined;
    const name =
      "constraint_name" in current
        ? current.constraint_name
        : "constraint" in current
          ? current.constraint
          : undefined;
    if (code === "23505" && (name === undefined || name === SLUG_UNIQUE_INDEX)) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

export function makeBoardRoutes(deps: RouteDeps): Hono<AuthEnv> {
  const router = new Hono<AuthEnv>();
  router.use("*", requireAuth);

  // GET /boards — cursor-paginated list ordered by (createdAt, id) DESC.
  router.get("/boards", async (c) => {
    const db = requireDb(deps.db);
    const page = parseQuery(pageArgsSchema, c.req.query());
    const scope = scopeKey("boards", BOARDS_SORT, {});

    const conditions: SQL[] = [];
    if (page.after) {
      const [createdAt, id] = decodeCursor(scope, page.after, timestampIdKeySchema);
      // Keyset seek at millisecond precision (see the note in issues.ts).
      conditions.push(
        sql`(date_trunc('milliseconds', ${boards.createdAt}), ${boards.id}) < (${String(createdAt)}::timestamptz, ${id}::uuid)`,
      );
    }

    const rows = await db
      .select()
      .from(boards)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(sql`date_trunc('milliseconds', ${boards.createdAt}) desc`, desc(boards.id))
      .limit(page.first + 1);

    return c.json(
      buildConnection(rows, page.first, scope, serializeBoard, (row) => [
        row.createdAt.toISOString(),
        row.id,
      ]),
    );
  });

  // POST /boards — create; omitted `columns` become the five non-cancelled statuses.
  router.post("/boards", async (c) => {
    const db = requireDb(deps.db);
    const user = getAuthUser(c);
    const input = parseBody(createBoardRequestSchema, await readJsonBody(c));

    let created: BoardRow;
    try {
      const [row] = await db
        .insert(boards)
        .values({
          name: input.name,
          slug: input.slug,
          description: input.description ?? null,
          columns: [...input.columns],
          createdBy: user.id,
        })
        .returning();
      created = row;
    } catch (err) {
      if (isSlugConflict(err)) {
        throw conflict("A board with this slug already exists.");
      }
      throw err;
    }

    c.header("Location", `/api/v1/boards/${created.id}`);
    return c.json(serializeBoard(created), 201);
  });

  // GET /boards/{boardId} — UUID only (the contract's Board id, not a slug).
  router.get("/boards/:boardId", async (c) => {
    const db = requireDb(deps.db);
    const boardId = parseBoardId(c.req.param("boardId"));
    const [row] = await db.select().from(boards).where(eq(boards.id, boardId)).limit(1);
    if (!row) throw notFound("Board not found.");
    return c.json(serializeBoard(row));
  });

  // PATCH /boards/{boardId} — non-empty subset of name/slug/description/columns.
  router.patch("/boards/:boardId", async (c) => {
    const db = requireDb(deps.db);
    const boardId = parseBoardId(c.req.param("boardId"));
    const input = parseBody(updateBoardRequestSchema, await readJsonBody(c));

    const updated = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(boards)
        .where(eq(boards.id, boardId))
        .for("update")
        .limit(1);
      if (!current) throw notFound("Board not found.");

      const patch: Partial<typeof boards.$inferInsert> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.slug !== undefined) patch.slug = input.slug;
      if (input.description !== undefined) patch.description = input.description;
      if (input.columns !== undefined) {
        const nextIds = new Set<string>(input.columns.map((column) => column.id));
        const removed = current.columns.map((column) => column.id).filter((id) => !nextIds.has(id));
        const blocking = removed.flatMap((id) => {
          const parsed = issueStatusSchema.safeParse(id);
          if (!parsed.success || TERMINAL_ISSUE_STATUSES.has(parsed.data)) return [];
          return [statusToDb(parsed.data)];
        });
        if (blocking.length > 0) {
          const [inUse] = await tx
            .select({ id: issues.id })
            .from(issues)
            .where(and(eq(issues.boardId, boardId), inArray(issues.status, blocking)))
            .limit(1);
          if (inUse) {
            throw conflict("A status column cannot be removed while non-terminal issues use it.");
          }
        }
        patch.columns = input.columns;
      }

      try {
        const [row] = await tx.update(boards).set(patch).where(eq(boards.id, boardId)).returning();
        return row;
      } catch (err) {
        if (isSlugConflict(err)) {
          throw conflict("A board with this slug already exists.");
        }
        throw err;
      }
    });

    return c.json(serializeBoard(updated));
  });

  return router;
}
