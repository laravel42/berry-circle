import type { ApiIssueStatus } from "~/api/enums";
import { invalidStateTransition } from "~/http/errors";

/**
 * Release 1 issue workflow. The M0 contract requires status changes to follow a
 * configured workflow and reject the rest with `409 INVALID_STATE_TRANSITION`;
 * this is that workflow. It is deliberately review-gate shaped — `done` is only
 * reachable from `inReview`, never straight from `backlog`/`todo`/`inProgress` —
 * matching Berry's product model. A later cycle can make this table
 * board-configurable without touching the routes.
 *
 * Setting a status to its current value is a no-op, not a transition.
 */
const ALLOWED_TRANSITIONS: Record<ApiIssueStatus, readonly ApiIssueStatus[]> = {
  backlog: ["todo", "cancelled"],
  todo: ["backlog", "inProgress", "cancelled"],
  inProgress: ["todo", "inReview", "cancelled"],
  inReview: ["inProgress", "done", "cancelled"],
  done: ["inReview"],
  cancelled: ["backlog", "todo"],
};

export function canTransition(from: ApiIssueStatus, to: ApiIssueStatus): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

/** Throws `409 INVALID_STATE_TRANSITION` when `from → to` is not permitted. */
export function assertTransition(from: ApiIssueStatus, to: ApiIssueStatus): void {
  if (!canTransition(from, to)) {
    throw invalidStateTransition(from, to);
  }
}
