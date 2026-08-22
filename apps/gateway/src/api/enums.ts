/**
 * The API exposes `camelCase` status values (`inProgress`, `inReview`) while the
 * Postgres enum stores `snake_case` (`in_progress`, `in_review`). These maps are
 * the single translation point between storage and the wire contract; priority
 * values are identical on both sides and need no mapping.
 */

export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "inProgress",
  "inReview",
  "done",
  "cancelled",
] as const;
export type ApiIssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;
export type ApiIssuePriority = (typeof ISSUE_PRIORITIES)[number];

type DbIssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "cancelled";

const STATUS_API_TO_DB: Record<ApiIssueStatus, DbIssueStatus> = {
  backlog: "backlog",
  todo: "todo",
  inProgress: "in_progress",
  inReview: "in_review",
  done: "done",
  cancelled: "cancelled",
};

const STATUS_DB_TO_API: Record<DbIssueStatus, ApiIssueStatus> = {
  backlog: "backlog",
  todo: "todo",
  in_progress: "inProgress",
  in_review: "inReview",
  done: "done",
  cancelled: "cancelled",
};

export function statusToDb(status: ApiIssueStatus): DbIssueStatus {
  return STATUS_API_TO_DB[status];
}

export function statusToApi(status: string): ApiIssueStatus {
  return STATUS_DB_TO_API[status as DbIssueStatus];
}
