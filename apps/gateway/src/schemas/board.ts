import { z } from "zod";
import { hasAtLeastOneKey, timestampSchema, uuidSchema } from "~/schemas/common";
import { issueStatusSchema } from "~/schemas/enums";

/** Board DTOs: the workspace board and its ordered status columns. */

/** 2–12 lowercase ASCII letters/digits/hyphens; unique per workspace. */
export const boardSlugSchema = z
  .string()
  .regex(/^[a-z0-9-]{2,12}$/, "Slug must be 2-12 lowercase letters, digits, or hyphens.");

/** A single status column on a board. */
export const boardColumnSchema = z.object({
  id: issueStatusSchema,
  name: z.string().min(1).max(50),
});
export type BoardColumn = z.infer<typeof boardColumnSchema>;

/**
 * Default columns applied when a board is created without an explicit `columns`
 * list: the five non-`cancelled` workflow states, in workflow order.
 */
export const DEFAULT_BOARD_COLUMNS: readonly BoardColumn[] = [
  { id: "backlog", name: "Backlog" },
  { id: "todo", name: "Todo" },
  { id: "inProgress", name: "In progress" },
  { id: "inReview", name: "In review" },
  { id: "done", name: "Done" },
];

export const boardSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(100),
  slug: boardSlugSchema,
  description: z.string().max(5000).nullable(),
  columns: z.array(boardColumnSchema).min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Board = z.infer<typeof boardSchema>;

/** `POST /api/v1/boards` request body. */
export const createBoardRequestSchema = z.object({
  name: z.string().min(1).max(100),
  slug: boardSlugSchema,
  description: z.string().max(5000).nullish(),
  columns: z
    .array(boardColumnSchema)
    .min(1)
    .default([...DEFAULT_BOARD_COLUMNS]),
});
export type CreateBoardRequest = z.infer<typeof createBoardRequestSchema>;

/** `PATCH /api/v1/boards/{boardId}` request body: a non-empty subset of fields. */
export const updateBoardRequestSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    slug: boardSlugSchema.optional(),
    description: z.string().max(5000).nullable().optional(),
    columns: z.array(boardColumnSchema).min(1).optional(),
  })
  .refine(hasAtLeastOneKey, { message: "At least one field must be provided." });
export type UpdateBoardRequest = z.infer<typeof updateBoardRequestSchema>;
