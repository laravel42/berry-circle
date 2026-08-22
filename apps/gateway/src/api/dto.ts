import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import type { ActorRef } from "~/api/actors";
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "~/api/enums";
import type { ApiIssuePriority } from "~/api/enums";
import { statusToApi } from "~/api/enums";
import type { comments, issues } from "~/db/schema";

/**
 * Request schemas and resource serializers for the Issue and Comment surfaces of
 * the M0 contract (BERR-23). BERR-22 is producing the workspace-wide DTO module
 * (Board/Agent/Run + the shared envelopes); when it lands, these issue/comment
 * schemas should fold into it as the single source of truth. They live here so
 * this vertical slice is self-contained and testable in the meantime.
 */

// ---------- shared field schemas ----------

const uuidSchema = z.string().uuid();
const titleSchema = z.string().trim().min(1).max(500);
const descriptionSchema = z.string().max(100_000);
const bodySchema = z.string().min(1).max(100_000);
const sortOrderSchema = z.number().int();
const timestampSchema = z.string().datetime({ offset: true });
const statusSchema = z.enum(ISSUE_STATUSES);
const prioritySchema = z.enum(ISSUE_PRIORITIES);
const assigneeInputSchema = z.object({
  type: z.enum(["user", "agent"]),
  id: uuidSchema,
});

export type AssigneeInput = z.infer<typeof assigneeInputSchema>;

// ---------- issue requests ----------

export const createIssueSchema = z.object({
  boardId: uuidSchema,
  title: titleSchema,
  description: descriptionSchema.nullish(),
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  sortOrder: sortOrderSchema.optional(),
  dueDate: timestampSchema.nullish(),
  assignee: assigneeInputSchema.nullish(),
});

export type CreateIssueInput = z.infer<typeof createIssueSchema>;

export const updateIssueSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema.nullable(),
    status: statusSchema,
    priority: prioritySchema,
    sortOrder: sortOrderSchema,
    dueDate: timestampSchema.nullable(),
    assignee: assigneeInputSchema.nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided.",
  });

export type UpdateIssueInput = z.infer<typeof updateIssueSchema>;

// ---------- comment requests ----------

export const createCommentSchema = z.object({
  body: bodySchema,
  parentId: uuidSchema.nullish(),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const updateCommentSchema = z.object({
  body: bodySchema,
});

export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;

// ---------- resource shapes ----------

export interface IssueResource {
  id: string;
  boardId: string;
  number: number;
  identifier: string;
  title: string;
  description: string | null;
  status: string;
  priority: ApiIssuePriority;
  sortOrder: number;
  dueDate: string | null;
  assignee: ActorRef | null;
  activeRunId: string | null;
  createdBy: ActorRef | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommentResource {
  id: string;
  issueId: string;
  body: string;
  author: ActorRef;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

type IssueRow = InferSelectModel<typeof issues>;
type CommentRow = InferSelectModel<typeof comments>;

/** Board slug drives the immutable human `identifier` (e.g. `BERRY-42`). */
export function issueIdentifier(boardSlug: string, number: number): string {
  return `${boardSlug.toUpperCase()}-${number}`;
}

export function serializeIssue(
  row: IssueRow,
  boardSlug: string,
  assignee: ActorRef | null,
  createdBy: ActorRef | null,
): IssueResource {
  return {
    id: row.id,
    boardId: row.boardId,
    number: row.number,
    identifier: issueIdentifier(boardSlug, row.number),
    title: row.title,
    description: row.description ?? null,
    status: statusToApi(row.status),
    priority: row.priority as ApiIssuePriority,
    sortOrder: row.sortOrder,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    assignee,
    // Berry runs (and thus an active-run link) arrive with the run surface; the
    // stored openfangRunId is an internal mapping and is never exposed here.
    activeRunId: null,
    createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeComment(row: CommentRow, author: ActorRef): CommentResource {
  return {
    id: row.id,
    issueId: row.issueId,
    body: row.body,
    author,
    parentId: row.parentId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
