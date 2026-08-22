import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Berry-owned product state (M2 gateway).
 *
 * Modeled from the project build plan / product brief domain; the M0 API
 * contract (BERR-11) is still being drafted, so expect a refinement pass
 * once the contract lands. Agent execution state (runs, tool calls, costs,
 * audit trail) lives in OpenFang — these tables hold only what Berry owns:
 * issues, comments, assignments, boards, users/sessions.
 */

// ---------- enums ----------

export const issueStatusEnum = pgEnum("issue_status", [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
]);

export const issuePriorityEnum = pgEnum("issue_priority", [
  "none",
  "urgent",
  "high",
  "medium",
  "low",
]);

export const assigneeTypeEnum = pgEnum("assignee_type", ["user", "agent"]);

// ---------- users & sessions ----------

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_key").on(t.tokenHash),
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

// ---------- boards ----------

export const boards = pgTable(
  "boards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    /** Ordered list of status columns shown on the board. */
    columns: jsonb("columns").notNull().default(sql`'[]'::jsonb`),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("boards_slug_key").on(t.slug)],
);

// ---------- issues ----------

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    /** Human-readable sequential number within the board (e.g. BERR-123). */
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: issueStatusEnum("status").notNull().default("backlog"),
    priority: issuePriorityEnum("priority").notNull().default("none"),
    sortOrder: integer("sort_order").notNull().default(0),
    dueDate: timestamp("due_date", { withTimezone: true }),
    /**
     * Current assignee. Assignment history (including agent dispatches) is
     * recorded in `assignments`; this is the denormalized latest value.
     */
    assigneeType: assigneeTypeEnum("assignee_type"),
    assigneeId: uuid("assignee_id"),
    /** OpenFang run id for the active agent run on this issue, if any. */
    openfangRunId: text("openfang_run_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("issues_board_number_key").on(t.boardId, t.number),
    index("issues_board_status_idx").on(t.boardId, t.status),
    index("issues_assignee_idx").on(t.assigneeType, t.assigneeId),
  ],
);

// ---------- assignments (history) ----------

export const assignments = pgTable(
  "assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    assigneeType: assigneeTypeEnum("assignee_type").notNull(),
    /** User id (Berry) or agent id (OpenFang) depending on assignee_type. */
    assigneeId: uuid("assignee_id").notNull(),
    assignedBy: uuid("assigned_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("assignments_issue_id_idx").on(t.issueId)],
);

// ---------- comments ----------

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    authorType: assigneeTypeEnum("author_type").notNull(),
    /** User id or agent id depending on author_type. */
    authorId: uuid("author_id").notNull(),
    body: text("body").notNull(),
    parentId: uuid("parent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("comments_issue_id_idx").on(t.issueId)],
);
