import { type InferSelectModel, and, eq, sql } from "drizzle-orm";
import type { BerryDb } from "~/db/client";
import { boards, issues } from "~/db/schema";

/** Shared issue resolution, used by both the issue and comment routers. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `SLUG-<number>`, e.g. `BERRY-42`; the slug itself may contain hyphens, so the
 * number is split from the final `-<digits>` segment. */
const IDENTIFIER_RE = /^(.+)-(\d+)$/;

export interface IssueWithBoard {
  issue: InferSelectModel<typeof issues>;
  boardSlug: string;
}

/**
 * Resolves an issue by UUID or by its case-insensitive human identifier
 * (`GET /issues/{issueId}` accepts either). Returns the issue joined with its
 * board slug (needed for the response `identifier`), or `null` when no issue
 * matches.
 */
export async function findIssueByRef(db: BerryDb, ref: string): Promise<IssueWithBoard | null> {
  const selection = { issue: issues, boardSlug: boards.slug };

  if (UUID_RE.test(ref)) {
    const [row] = await db
      .select(selection)
      .from(issues)
      .innerJoin(boards, eq(issues.boardId, boards.id))
      .where(eq(issues.id, ref))
      .limit(1);
    return row ?? null;
  }

  const match = IDENTIFIER_RE.exec(ref);
  if (!match) return null;
  const slug = match[1].toLowerCase();
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) return null;

  const [row] = await db
    .select(selection)
    .from(issues)
    .innerJoin(boards, eq(issues.boardId, boards.id))
    .where(and(eq(sql`lower(${boards.slug})`, slug), eq(issues.number, number)))
    .limit(1);
  return row ?? null;
}
