import { toRFC3339, type Sql } from '../db/pool.ts';

/**
 * The human review gate, as a list.
 *
 * A task moves to `in_review` when its run delivers, and a person decides. This
 * is what that person opens: every task waiting, with the run that delivered
 * it — its pull request, its own account of the work, the checks that ran and
 * any peer verdict — so the decision is made with the evidence beside it
 * rather than by clicking through to GitHub. The product brief calls review a
 * first-class state with the run's evidence attached, and this is the read
 * that makes it one.
 *
 * Decisions are not taken here: approving is the issue moving to `done` and
 * sending back is it moving to `todo`, both through the issue's own transition
 * so the timeline, the goal's derived status and the board stream all see it.
 */

export type ReviewState = 'open' | 'completed';

export interface ReviewItem {
   /** The issue id: a review is identified by the task under review. */
   id: string;
   issue: { id: string; identifier: string; title: string; status: string; autoGate: boolean };
   author: { id: string; name: string } | null;
   run: { id: string; summary: string | null; completedAt: string | null };
   repository: string | null;
   pullRequest: { number: number; url: string | null; branch: string | null; headCommit: string | null } | null;
   delivery: { committed: boolean; filesChanged: number; insertions: number; deletions: number; files: string[] };
   checks: {
      passed: boolean;
      complete: boolean;
      results: Array<{ command: string; exitCode: number | null; passed: boolean }>;
   } | null;
   verdicts: Array<{
      id: string;
      reviewer: string;
      approved: boolean | null;
      reason: string;
      attempt: number;
      decidedAt: string | null;
   }>;
   updatedAt: string;
}

const DEFAULT_LIMIT = 50;

export class ReviewQueue {
   readonly #sql: Sql;

   constructor(sql: Sql) {
      this.#sql = sql;
   }

   /**
    * Tasks at the gate, newest first.
    *
    * `open` is every task in review. `completed` is the tasks a decision was
    * taken on that still have a delivered run to look back at — done, or sent
    * back to todo — so a reviewer can see what they decided and why.
    */
   async list(workspaceId: string, state: ReviewState, limit = DEFAULT_LIMIT): Promise<ReviewItem[]> {
      const bounded = limit < 1 || limit > 200 ? DEFAULT_LIMIT : limit;
      const statuses = state === 'open' ? ['in_review'] : ['done', 'todo', 'in_progress'];
      const rows = await this.#sql`
         SELECT issue.id, issue.title, issue.status::text AS status, issue.auto_gate, issue.updated_at,
                berry_issue_identifier(board.workspace_id, issue.number) AS identifier,
                run.id AS run_id, run.summary, run.completed_at, run.pull_request_number, run.branch, run.head_commit,
                run.agent_id, agent.name AS agent_name,
                project.github_repo_full_name AS repository,
                delivered.payload AS delivered, verified.payload AS verified
           FROM issues AS issue
           JOIN boards AS board ON board.id = issue.board_id
           JOIN LATERAL (
              SELECT r.id, r.summary, r.completed_at, r.pull_request_number, r.branch, r.head_commit, r.agent_id
                FROM runs AS r
               WHERE r.issue_id = issue.id AND r.status = 'succeeded'
               ORDER BY r.completed_at DESC NULLS LAST, r.created_at DESC
               LIMIT 1
           ) AS run ON true
           LEFT JOIN LATERAL (
              SELECT payload FROM run_events e
               WHERE e.run_id = run.id AND e.event_type = 'run.delivered'
               ORDER BY e.occurred_at DESC LIMIT 1
           ) AS delivered ON true
           LEFT JOIN LATERAL (
              SELECT payload FROM run_events e
               WHERE e.run_id = run.id AND e.event_type = 'run.verified'
               ORDER BY e.occurred_at DESC LIMIT 1
           ) AS verified ON true
           LEFT JOIN agents AS agent ON agent.id = run.agent_id
           LEFT JOIN issue_project_links AS link ON link.issue_id = issue.id
           LEFT JOIN projects AS project ON project.id = link.project_id AND project.deleted_at IS NULL
          WHERE board.workspace_id = ${workspaceId}
            AND issue.deleted_at IS NULL
            AND issue.status::text = ANY(${statuses})
            -- A completed entry is one somebody decided on: a task in todo that
            -- was never delivered is not a review that happened.
            AND (${state === 'open'} OR delivered.payload IS NOT NULL)
          ORDER BY issue.updated_at DESC
          LIMIT ${bounded}`;

      const issueIds = rows.map((row) => row.id as string);
      const verdictRows = issueIds.length
         ? await this.#sql`
              SELECT review.id, review.issue_id, COALESCE(reviewer.name, 'an agent') AS reviewer,
                     review.approved, COALESCE(review.reason, '') AS reason, review.attempt, review.decided_at
                FROM issue_auto_reviews AS review
                LEFT JOIN agents AS reviewer ON reviewer.id = review.reviewer_id
               WHERE review.issue_id = ANY(${issueIds})
               ORDER BY review.started_at DESC`
         : [];
      const verdicts = new Map<string, ReviewItem['verdicts']>();
      for (const row of verdictRows) {
         const list = verdicts.get(row.issue_id as string) ?? [];
         list.push({
            id: row.id as string,
            reviewer: row.reviewer as string,
            approved: (row.approved as boolean | null) ?? null,
            reason: row.reason as string,
            attempt: Number(row.attempt),
            decidedAt: toRFC3339(row.decided_at as string | null),
         });
         verdicts.set(row.issue_id as string, list);
      }

      return rows.map((row) => {
         const delivered = (row.delivered ?? null) as {
            committed?: boolean;
            filesChanged?: number;
            insertions?: number;
            deletions?: number;
            files?: string[];
            pullRequest?: { number?: number; url?: string } | null;
         } | null;
         const number = delivered?.pullRequest?.number ?? (row.pull_request_number as number | null) ?? null;
         return {
            id: row.id as string,
            issue: {
               id: row.id as string,
               identifier: row.identifier as string,
               title: row.title as string,
               status: row.status as string,
               autoGate: Boolean(row.auto_gate),
            },
            author: row.agent_id ? { id: row.agent_id as string, name: (row.agent_name as string | null) ?? 'an agent' } : null,
            run: {
               id: row.run_id as string,
               summary: (row.summary as string | null) ?? null,
               completedAt: toRFC3339(row.completed_at as string | null),
            },
            repository: (row.repository as string | null) ?? null,
            pullRequest:
               number === null
                  ? null
                  : {
                       number: Number(number),
                       url: delivered?.pullRequest?.url ?? null,
                       branch: (row.branch as string | null) ?? null,
                       headCommit: (row.head_commit as string | null) ?? null,
                    },
            delivery: {
               committed: delivered?.committed ?? false,
               filesChanged: delivered?.filesChanged ?? 0,
               insertions: delivered?.insertions ?? 0,
               deletions: delivered?.deletions ?? 0,
               files: delivered?.files ?? [],
            },
            checks: (row.verified as ReviewItem['checks']) ?? null,
            verdicts: verdicts.get(row.id as string) ?? [],
            updatedAt: toRFC3339(row.updated_at as string) ?? '',
         };
      });
   }

   /** The repository and pull request a run delivered, for the diff read. */
   async pullRequestOf(runId: string): Promise<{ workspaceId: string; repository: string; number: number } | null> {
      const [row] = await this.#sql`
         SELECT board.workspace_id, run.pull_request_number, project.github_repo_full_name AS repository
           FROM runs AS run
           JOIN issues AS issue ON issue.id = run.issue_id
           JOIN boards AS board ON board.id = issue.board_id
           LEFT JOIN issue_project_links AS link ON link.issue_id = issue.id
           LEFT JOIN projects AS project ON project.id = link.project_id AND project.deleted_at IS NULL
          WHERE run.id = ${runId}`;
      if (!row || row.pull_request_number === null || !row.repository) return null;
      return {
         workspaceId: row.workspace_id as string,
         repository: row.repository as string,
         number: Number(row.pull_request_number),
      };
   }
}
