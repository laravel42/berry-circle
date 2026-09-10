import { toRFC3339, type Sql } from '../db/pool.ts';
import { canTransition, type IssueRepository } from '../core/issues.ts';
import { writeWorkspaceEvent } from './github-settings.ts';
import {
   findLinkIntents,
   rollupChecks,
   statusPathToDone,
   type CheckRollup,
   type LinkSource,
   type PullRequestState,
} from './pr-linking.ts';

/**
 * Pull requests and checks, as GitHub reported them, against Berry issues.
 *
 * Every method takes the workspace the webhook was routed to (by installation
 * id) and never looks outside it: an issue number is resolved inside that
 * workspace, and a pull request is keyed by that workspace and GitHub's id.
 */

export interface PullRequestInput {
   githubId: number;
   repoId: number;
   repoFullName: string;
   number: number;
   title: string;
   url: string;
   state: PullRequestState;
   draft: boolean;
   headRef: string;
   headSha: string | null;
   authorLogin: string | null;
   mergedAt: string | null;
   closedAt: string | null;
   githubUpdatedAt: string | null;
   body: string | null;
}

export interface CheckInput {
   kind: 'run' | 'suite';
   githubId: number;
   repoId: number;
   headSha: string;
   name: string;
   status: string;
   conclusion: string | null;
   url: string | null;
}

export interface CheckItem {
   kind: 'run' | 'suite';
   name: string;
   status: string;
   conclusion: string | null;
   url: string | null;
}

export interface LinkedPullRequest {
   id: string;
   number: number;
   title: string;
   url: string;
   repoFullName: string;
   state: PullRequestState;
   draft: boolean;
   headRef: string;
   authorLogin: string | null;
   mergedAt: string | null;
   closeIntent: boolean;
   checks: {
      rollup: CheckRollup;
      total: number;
      passed: number;
      failed: number;
      pending: number;
      items: CheckItem[];
   };
   updatedAt: string;
}

export interface PullRequestStoreDeps {
   sql: Sql;
   issues: Pick<IssueRepository, 'update'>;
}

const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);

export class PullRequestStore {
   readonly #sql: Sql;
   readonly #issues: Pick<IssueRepository, 'update'>;

   constructor(deps: PullRequestStoreDeps) {
      this.#sql = deps.sql;
      this.#issues = deps.issues;
   }

   /**
    * Records what GitHub says about a pull request.
    *
    * `stale` is true when the row already holds a newer description: webhooks
    * are retried and can arrive out of order, and a late `opened` must not
    * undo a `merged`.
    */
   async upsertPullRequest(
      workspaceId: string,
      pr: PullRequestInput
   ): Promise<{ id: string; stale: boolean }> {
      const sql = this.#sql;
      const [written] = await sql`
         INSERT INTO github_pull_requests
                (workspace_id, github_id, repo_id, repo_full_name, number, title, url, state, draft,
                 head_ref, head_sha, author_login, merged_at, closed_at, github_updated_at)
         VALUES (${workspaceId}, ${pr.githubId}, ${pr.repoId}, ${pr.repoFullName}, ${pr.number},
                 ${pr.title.slice(0, 1000)}, ${pr.url}, ${pr.state}, ${pr.draft}, ${pr.headRef},
                 ${pr.headSha}, ${pr.authorLogin}, ${pr.mergedAt}, ${pr.closedAt},
                 ${pr.githubUpdatedAt})
         ON CONFLICT (workspace_id, github_id) DO UPDATE SET
            repo_id = EXCLUDED.repo_id, repo_full_name = EXCLUDED.repo_full_name,
            number = EXCLUDED.number, title = EXCLUDED.title, url = EXCLUDED.url,
            state = EXCLUDED.state, draft = EXCLUDED.draft, head_ref = EXCLUDED.head_ref,
            head_sha = EXCLUDED.head_sha, author_login = EXCLUDED.author_login,
            merged_at = EXCLUDED.merged_at, closed_at = EXCLUDED.closed_at,
            github_updated_at = EXCLUDED.github_updated_at, updated_at = now()
          WHERE github_pull_requests.github_updated_at IS NULL
             OR EXCLUDED.github_updated_at IS NULL
             OR EXCLUDED.github_updated_at >= github_pull_requests.github_updated_at
         RETURNING id`;
      if (written) return { id: written.id as string, stale: false };
      const [existing] = await sql`
         SELECT id FROM github_pull_requests
          WHERE workspace_id = ${workspaceId} AND github_id = ${pr.githubId}`;
      return { id: existing!.id as string, stale: true };
   }

   /**
    * Links the issues this pull request names, and answers with their ids.
    *
    * A branch Berry itself wrote for a run on an issue always links — Berry
    * issued that name. Keys in the branch, title or body link only with
    * auto-link on. A number that names more than one issue in the workspace is
    * ambiguous and links nothing, rather than guessing.
    */
   async linkIssues(
      workspaceId: string,
      pullRequestId: string,
      pr: Pick<PullRequestInput, 'headRef' | 'title' | 'body'>,
      options: { autoLink: boolean }
   ): Promise<string[]> {
      const sql = this.#sql;
      const wanted = new Map<string, { closeIntent: boolean; source: LinkSource }>();

      const fromRuns = await sql`
         SELECT DISTINCT run.issue_id
           FROM runs AS run
           JOIN boards AS board ON board.id = run.board_id
          WHERE board.workspace_id = ${workspaceId} AND run.branch = ${pr.headRef}`;
      for (const row of fromRuns) {
         wanted.set(row.issue_id as string, { closeIntent: false, source: 'run' });
      }

      if (options.autoLink) {
         const [workspace] = await sql`
            SELECT settings->>'issuePrefix' AS prefix FROM workspaces WHERE id = ${workspaceId}`;
         const intents = findLinkIntents({
            prefix: typeof workspace?.prefix === 'string' ? workspace.prefix : '',
            branch: pr.headRef,
            title: pr.title,
            body: pr.body,
         });
         if (intents.length > 0) {
            const rows = await sql`
               SELECT issue.id, issue.number
                 FROM issues AS issue
                 JOIN boards AS board ON board.id = issue.board_id
                WHERE board.workspace_id = ${workspaceId} AND issue.deleted_at IS NULL
                  AND issue.number = ANY(${intents.map((intent) => intent.number)}::int[])`;
            for (const intent of intents) {
               const matches = rows.filter((row) => Number(row.number) === intent.number);
               if (matches.length !== 1) continue;
               const issueId = matches[0]!.id as string;
               const previous = wanted.get(issueId);
               wanted.set(issueId, {
                  closeIntent: (previous?.closeIntent ?? false) || intent.closeIntent,
                  source: previous?.source ?? intent.source,
               });
            }
         }
      }

      for (const [issueId, link] of wanted) {
         await sql`
            INSERT INTO github_pull_request_links
                   (workspace_id, pull_request_id, issue_id, close_intent, source)
            VALUES (${workspaceId}, ${pullRequestId}, ${issueId}, ${link.closeIntent}, ${link.source})
            ON CONFLICT (pull_request_id, issue_id) DO UPDATE
               SET close_intent = github_pull_request_links.close_intent OR EXCLUDED.close_intent`;
      }
      return [...wanted.keys()];
   }

   /**
    * Moves the issues a merged pull request closes to done, and answers with
    * the ones it moved.
    *
    * Through the issue repository, one legal step at a time, so the normal
    * `issue.updated` and `issue.completed` events fire and the state machine
    * is never bypassed. An issue that refuses a step (an approval gate, a
    * concurrent change) is left where it stopped.
    */
   async closeLinkedIssues(
      workspaceId: string,
      pullRequestId: string,
      actorId: string | null
   ): Promise<string[]> {
      const sql = this.#sql;
      const [pr] = await sql`
         SELECT state FROM github_pull_requests
          WHERE id = ${pullRequestId} AND workspace_id = ${workspaceId}`;
      if (pr?.state !== 'merged') return [];

      const targets = await sql`
         SELECT issue.id, issue.status::text AS status
           FROM github_pull_request_links AS link
           JOIN issues AS issue ON issue.id = link.issue_id AND issue.deleted_at IS NULL
           JOIN boards AS board ON board.id = issue.board_id AND board.workspace_id = ${workspaceId}
          WHERE link.pull_request_id = ${pullRequestId} AND link.close_intent`;
      if (targets.length === 0) return [];

      const actor = actorId ?? (await this.#systemActor(workspaceId));
      if (!actor) return [];

      const moved: string[] = [];
      for (const target of targets) {
         const path = statusPathToDone(target.status as string, canTransition);
         if (path.length === 0) continue;
         try {
            for (const status of path) {
               await this.#issues.update({
                  issueId: target.id as string,
                  actorId: actor,
                  patch: {
                     status,
                     descriptionSet: false,
                     dueDateSet: false,
                     assigneeSet: false,
                     projectSet: false,
                  },
               });
            }
            moved.push(target.id as string);
         } catch {
            // Left at the last step it accepted. The link and the merged
            // state still show on the issue, so a person can finish the move.
         }
      }
      return moved;
   }

   /** Records a check, and answers with the issues whose pull requests it ran on. */
   async upsertCheck(workspaceId: string, check: CheckInput): Promise<string[]> {
      const sql = this.#sql;
      await sql`
         INSERT INTO github_checks
                (workspace_id, kind, github_id, repo_id, head_sha, name, status, conclusion, url)
         VALUES (${workspaceId}, ${check.kind}, ${check.githubId}, ${check.repoId}, ${check.headSha},
                 ${check.name.slice(0, 300)}, ${check.status}, ${check.conclusion}, ${check.url})
         ON CONFLICT (workspace_id, kind, github_id) DO UPDATE SET
            repo_id = EXCLUDED.repo_id, head_sha = EXCLUDED.head_sha, name = EXCLUDED.name,
            status = EXCLUDED.status, conclusion = EXCLUDED.conclusion, url = EXCLUDED.url,
            updated_at = now()`;
      const rows = await sql`
         SELECT DISTINCT link.issue_id
           FROM github_pull_requests AS pr
           JOIN github_pull_request_links AS link ON link.pull_request_id = pr.id
          WHERE pr.workspace_id = ${workspaceId} AND pr.repo_id = ${check.repoId}
            AND pr.head_sha = ${check.headSha}`;
      return rows.map((row) => row.issue_id as string);
   }

   /**
    * The issue's id and board in this workspace, by uuid or by key; null when
    * the workspace has no such issue. A foreign issue and a missing one are
    * the same answer.
    */
   async resolveIssue(
      workspaceId: string,
      issueRef: string
   ): Promise<{ id: string; boardId: string } | null> {
      const ref = issueRef.trim();
      if (ref === '' || ref.length > 100) return null;
      const [row] = await this.#sql`
         SELECT issue.id, issue.board_id
           FROM issues AS issue
           JOIN boards AS board ON board.id = issue.board_id
          WHERE board.workspace_id = ${workspaceId} AND issue.deleted_at IS NULL
            AND (issue.id::text = ${ref.toLowerCase()}
                 OR berry_issue_identifier(board.workspace_id, issue.number) = ${ref.toUpperCase()})
          LIMIT 1`;
      return row ? { id: row.id as string, boardId: row.board_id as string } : null;
   }

   /** The pull requests linked to an issue, newest first; null when the issue is not here. */
   async listForIssue(workspaceId: string, issueRef: string): Promise<LinkedPullRequest[] | null> {
      const issue = await this.resolveIssue(workspaceId, issueRef);
      if (!issue) return null;
      const sql = this.#sql;
      const prs = await sql`
         SELECT pr.id, pr.number, pr.title, pr.url, pr.repo_full_name, pr.repo_id, pr.state,
                pr.draft, pr.head_ref, pr.head_sha, pr.author_login, pr.merged_at, pr.updated_at,
                link.close_intent
           FROM github_pull_request_links AS link
           JOIN github_pull_requests AS pr ON pr.id = link.pull_request_id
          WHERE link.workspace_id = ${workspaceId} AND pr.workspace_id = ${workspaceId}
            AND link.issue_id = ${issue.id}
          ORDER BY pr.updated_at DESC, pr.id ASC`;
      const shas = prs
         .map((row) => row.head_sha as string | null)
         .filter((sha): sha is string => typeof sha === 'string');
      const checks =
         shas.length === 0
            ? []
            : await sql`
                 SELECT kind, name, status, conclusion, url, repo_id, head_sha
                   FROM github_checks
                  WHERE workspace_id = ${workspaceId} AND head_sha = ANY(${shas}::text[])
                  ORDER BY name ASC, github_id ASC`;

      return prs.map((row) => {
         const mine = checks.filter(
            (check) =>
               check.head_sha === row.head_sha && Number(check.repo_id) === Number(row.repo_id)
         );
         // Runs are the individual checks; a suite only summarises them. Where
         // runs exist they are the answer, and a suite stands in only for a
         // provider that reports suites alone.
         const runs = mine.filter((check) => check.kind === 'run');
         const chosen = (runs.length > 0 ? runs : mine).map(
            (check): CheckItem => ({
               kind: check.kind as 'run' | 'suite',
               name: check.name as string,
               status: check.status as string,
               conclusion: (check.conclusion as string | null) ?? null,
               url: (check.url as string | null) ?? null,
            })
         );
         return {
            id: row.id as string,
            number: Number(row.number),
            title: row.title as string,
            url: row.url as string,
            repoFullName: row.repo_full_name as string,
            state: row.state as PullRequestState,
            draft: row.draft === true,
            headRef: row.head_ref as string,
            authorLogin: (row.author_login as string | null) ?? null,
            mergedAt: toRFC3339(row.merged_at as string | null),
            closeIntent: row.close_intent === true,
            checks: {
               rollup: rollupChecks(chosen),
               total: chosen.length,
               passed: chosen.filter((check) => check.conclusion === 'success').length,
               failed: chosen.filter((check) => FAILED.has(check.conclusion ?? '')).length,
               pending: chosen.filter((check) => check.status !== 'completed').length,
               items: chosen,
            },
            updatedAt: toRFC3339(row.updated_at as string) ?? '',
         };
      });
   }

   /** One `github.pull_request.updated` per issue, on the issue's board and workspace. */
   async publishUpdated(
      workspaceId: string,
      issueIds: readonly string[],
      pullRequestId: string | null
   ): Promise<void> {
      if (issueIds.length === 0) return;
      const sql = this.#sql;
      const rows = await sql`
         SELECT issue.id, issue.board_id
           FROM issues AS issue
           JOIN boards AS board ON board.id = issue.board_id AND board.workspace_id = ${workspaceId}
          WHERE issue.id = ANY(${[...new Set(issueIds)]}::uuid[])`;
      for (const row of rows) {
         await writeWorkspaceEvent(sql, {
            workspaceId,
            boardId: row.board_id as string,
            issueId: row.id as string,
            type: 'github.pull_request.updated',
            aggregateType: 'github_pull_request',
            aggregateId: pullRequestId ?? (row.id as string),
            payload: { issueId: row.id as string, pullRequestId },
         });
      }
   }

   /**
    * Who a merge's status change is recorded as when no person made it: the
    * person who installed the App here, or else whoever created the workspace.
    */
   async #systemActor(workspaceId: string): Promise<string | null> {
      const [row] = await this.#sql`
         SELECT COALESCE(installation.installed_by, workspace.created_by) AS actor
           FROM workspaces AS workspace
           LEFT JOIN github_installations AS installation ON installation.workspace_id = workspace.id
          WHERE workspace.id = ${workspaceId}`;
      return (row?.actor as string | null) ?? null;
   }
}
