import { z } from "zod";
import {
  actorRefSchema,
  actorTypeSchema,
  assigneeInputSchema,
  commaSeparated,
  hasAtLeastOneKey,
  paginationQuerySchema,
  timestampSchema,
  uuidSchema,
} from "~/schemas/common";
import { issuePrioritySchema, issueStatusSchema } from "~/schemas/enums";

/** Issue DTOs: the resource shape plus create/update bodies and list filters. */

export const issueSchema = z.object({
  id: uuidSchema,
  boardId: uuidSchema,
  number: z.number().int().positive(),
  /** Uppercase board slug plus number, e.g. `BERRY-42`; immutable. */
  identifier: z.string().min(1),
  title: z.string().min(1).max(500),
  description: z.string().max(100000).nullable(),
  status: issueStatusSchema,
  priority: issuePrioritySchema,
  sortOrder: z.number().int(),
  dueDate: timestampSchema.nullable(),
  assignee: actorRefSchema.nullable(),
  /** Active Berry run; null when no run is active. */
  activeRunId: uuidSchema.nullable(),
  /** Null only when the creator was removed. */
  createdBy: actorRefSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Issue = z.infer<typeof issueSchema>;

/**
 * `POST /api/v1/issues` request body. Recording an assignee here does not
 * dispatch a run; that is `POST /issues/{id}/runs`. Optional fields carry the
 * contract's documented defaults.
 */
export const createIssueRequestSchema = z.object({
  boardId: uuidSchema,
  title: z.string().min(1).max(500),
  description: z.string().max(100000).nullable().default(null),
  status: issueStatusSchema.default("backlog"),
  priority: issuePrioritySchema.default("none"),
  sortOrder: z.number().int().default(0),
  dueDate: timestampSchema.nullable().default(null),
  assignee: assigneeInputSchema.nullable().default(null),
});
export type CreateIssueRequest = z.infer<typeof createIssueRequestSchema>;

/**
 * `PATCH /api/v1/issues/{issueId}` request body: a non-empty subset. Setting
 * `assignee` to null unassigns the issue.
 */
export const updateIssueRequestSchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(100000).nullable().optional(),
    status: issueStatusSchema.optional(),
    priority: issuePrioritySchema.optional(),
    sortOrder: z.number().int().optional(),
    dueDate: timestampSchema.nullable().optional(),
    assignee: assigneeInputSchema.nullable().optional(),
  })
  .refine(hasAtLeastOneKey, { message: "At least one field must be provided." });
export type UpdateIssueRequest = z.infer<typeof updateIssueRequestSchema>;

/**
 * `GET /api/v1/issues` query parameters. `boardId` is required; `status` and
 * `priority` are comma-separated lists; `assigneeType`/`assigneeId` must be
 * supplied together.
 */
export const issueListQuerySchema = paginationQuerySchema
  .extend({
    boardId: uuidSchema,
    status: commaSeparated(issueStatusSchema).optional(),
    priority: commaSeparated(issuePrioritySchema).optional(),
    assigneeType: actorTypeSchema.optional(),
    assigneeId: uuidSchema.optional(),
    query: z.string().min(1).max(200).optional(),
  })
  .refine((q) => (q.assigneeType === undefined) === (q.assigneeId === undefined), {
    message: "assigneeType and assigneeId must be provided together.",
    path: ["assigneeId"],
  });
export type IssueListQuery = z.infer<typeof issueListQuerySchema>;
