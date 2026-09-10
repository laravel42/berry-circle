import type { Sql } from '../db/pool.ts';
import type { Logger } from '../observability/log.ts';
import type { ScmLinkRepository } from './links.ts';

/**
 * Applying a change made on GitHub to Berry.
 *
 * The direction nobody thinks about until it is missing: somebody closes an
 * issue on GitHub, and Berry goes on showing it as open forever.
 *
 * Every handler resolves the Berry object by the host's numeric id and stops
 * if there is no link. That is deliberate — a repository Berry does not know
 * about is not Berry's to write to, and guessing by name is how an unrelated
 * repository's issue ends up closing a task.
 */

/** Where GitHub-App events go: pull requests on issues, checks, uninstalls. */
export interface GitHubEventHandler {
   handles(event: string): boolean;
   apply(event: string, payload: Record<string, unknown>): Promise<InboundResult>;
}

export interface InboundDeps {
   sql: Sql;
   links: ScmLinkRepository;
   logger: Logger;
   github?: GitHubEventHandler;
   /**
    * The workspace that claimed a GitHub App installation, or null. Pull
    * request and review events are applied only inside that workspace: the
    * branch name they match on is not unique across workspaces.
    */
   workspaceForInstallation?: (installationId: number) => Promise<string | null>;
}

export interface InboundResult {
   applied: boolean;
   /** Why nothing was done, for the response body and the log. */
   reason: string;
}

const IGNORED = (reason: string): InboundResult => ({ applied: false, reason });

export class ScmInbound {
   readonly #sql: Sql;
   readonly #links: ScmLinkRepository;
   readonly #logger: Logger;
   readonly #github: GitHubEventHandler | null;
   readonly #workspaceForInstallation: (installationId: number) => Promise<string | null>;

   constructor(deps: InboundDeps) {
      this.#sql = deps.sql;
      this.#links = deps.links;
      this.#logger = deps.logger;
      this.#github = deps.github ?? null;
      this.#workspaceForInstallation = deps.workspaceForInstallation ?? (async () => null);
   }

   /**
    * The workspace a pull-request event belongs to: the one that claimed the
    * installation the payload names, looked up by GitHub's id and nothing
    * else. A delivery with no installation, or one no workspace claimed, has
    * no workspace, and is applied nowhere.
    */
   async #workspaceOf(payload: Record<string, unknown>): Promise<string | null> {
      const installation = payload.installation as Record<string, unknown> | undefined;
      const installationId = Number(installation?.id ?? 0);
      if (!Number.isSafeInteger(installationId) || installationId <= 0) return null;
      return this.#workspaceForInstallation(installationId);
   }

   /** Routes one event to its handler. */
   async apply(event: string, payload: Record<string, unknown>): Promise<InboundResult> {
      switch (event) {
         case 'issues':
            return this.#issue(payload);
         case 'pull_request': {
            // Both, independently: the review a run opened follows its pull
            // request by branch, and the issue sidebar follows it by link.
            const review = await this.#pullRequest(payload);
            if (!this.#github) return review;
            const linked = await this.#github.apply(event, payload);
            return {
               applied: review.applied || linked.applied,
               reason: `${review.reason}; ${linked.reason}`,
            };
         }
         case 'check_run':
         case 'check_suite':
         case 'installation':
            return this.#github?.handles(event)
               ? this.#github.apply(event, payload)
               : IGNORED(`unhandled event ${event}`);
         case 'pull_request_review':
            return this.#review(payload);
         case 'push':
            // Recorded rather than applied: a push changes no Berry object on
            // its own, and the run that produced it already knows its branch.
            return IGNORED('push carries no Berry object');
         case 'milestone':
            return this.#milestone(payload);
         default:
            return IGNORED(`unhandled event ${event}`);
      }
   }

   /** An issue opened, edited, closed or reopened on the host. */
   async #issue(payload: Record<string, unknown>): Promise<InboundResult> {
      const issue = payload.issue as Record<string, unknown> | undefined;
      const externalId = Number(issue?.id ?? 0);
      if (!externalId) return IGNORED('no issue id');

      const link = await this.#links.resolve('github', 'issue', externalId);
      if (!link) return IGNORED('issue is not linked to a Berry task');
      // A pull request is an issue to GitHub's API, and its `issues` events
      // are separate — but a `pull_request` payload arriving here would
      // otherwise close the Berry task the PR was opened for.
      if (issue?.pull_request) return IGNORED('a pull request, not a task');

      const updatedAt = typeof issue?.updated_at === 'string' ? issue.updated_at : null;
      if (!(await this.#links.isNews('github', 'issue', link.berryId, updatedAt))) {
         // Berry's own write, arriving back. Applying it would be harmless
         // here but the same check is what stops title edits ping-ponging.
         return IGNORED('not newer than Berry’s own last write');
      }

      const state = String(issue?.state ?? '');
      const title = typeof issue?.title === 'string' ? issue.title : null;

      // Status is narrowed deliberately: the host has open and closed, Berry
      // has seven statuses, and re-opening must not guess which of them a task
      // was in before it closed. `todo` is the honest neutral.
      const status = state === 'closed' ? 'done' : null;

      await this.#sql`
         UPDATE issues
            SET title = COALESCE(${title}, title),
                status = COALESCE(${status}::issue_status, status),
                updated_at = now()
          WHERE id = ${link.berryId} AND deleted_at IS NULL`;

      await this.#links.touch({
         provider: 'github',
         berryType: 'issue',
         berryId: link.berryId,
         externalUpdatedAt: updatedAt,
      });
      this.#logger.info('scm inbound applied', {
         event: 'issues',
         issueId: link.berryId,
         state,
      });
      return { applied: true, reason: 'issue updated' };
   }

   /** A pull request opened, updated, closed or merged. */
   async #pullRequest(payload: Record<string, unknown>): Promise<InboundResult> {
      const pull = payload.pull_request as Record<string, unknown> | undefined;
      const number = Number(pull?.number ?? 0);
      const head = (pull?.head as Record<string, unknown> | undefined)?.ref;
      if (!number || typeof head !== 'string') return IGNORED('no pull request number or branch');
      const workspaceId = await this.#workspaceOf(payload);
      if (!workspaceId) return IGNORED('installation is not claimed by a workspace');

      const merged = pull?.merged === true;
      const state = merged ? 'merged' : String(pull?.state ?? '') === 'closed' ? 'closed' : 'open';

      // Matched by branch, which is Berry's own: `berry/<n>-<agent>-<slug>` is
      // written by Berry when the run starts, so this is still an id Berry
      // issued rather than a name somebody typed.
      const updated = await this.#sql`
         UPDATE reviews
            SET state = ${state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open'},
                pull_request_number = ${number},
                decided_at = CASE WHEN ${state} = 'open' THEN NULL ELSE now() END,
                updated_at = now()
          WHERE kind = 'code' AND branch = ${head} AND workspace_id = ${workspaceId}
          RETURNING id`;

      await this.#sql`
         UPDATE runs SET pull_request_number = ${number}, updated_at = now()
          WHERE branch = ${head} AND workspace_id = ${workspaceId}
            AND pull_request_number IS DISTINCT FROM ${number}`;

      if (updated.length === 0) return IGNORED('no Berry review for this branch');
      this.#logger.info('scm inbound applied', { event: 'pull_request', number, state });
      return { applied: true, reason: `pull request ${state}` };
   }

   /** A review submitted on a pull request. */
   async #review(payload: Record<string, unknown>): Promise<InboundResult> {
      const pull = payload.pull_request as Record<string, unknown> | undefined;
      const head = (pull?.head as Record<string, unknown> | undefined)?.ref;
      const review = payload.review as Record<string, unknown> | undefined;
      if (typeof head !== 'string') return IGNORED('no branch on the pull request');

      // GitHub reports the verdict in `review.state`: `approved`,
      // `changes_requested` or `commented`. Only the first two are decisions.
      const verdict = String(review?.state ?? '').toLowerCase();
      const state =
         verdict === 'approved'
            ? 'approved'
            : verdict === 'changes_requested'
              ? 'changes_requested'
              : null;
      if (!state) return IGNORED('review is a comment, not a verdict');
      const workspaceId = await this.#workspaceOf(payload);
      if (!workspaceId) return IGNORED('installation is not claimed by a workspace');

      const updated = await this.#sql`
         UPDATE reviews
            SET state = ${state}, decided_at = now(), updated_at = now()
          WHERE kind = 'code' AND branch = ${head} AND state = 'open' AND workspace_id = ${workspaceId}
          RETURNING id`;
      if (updated.length === 0) return IGNORED('no open Berry review for this branch');
      this.#logger.info('scm inbound applied', { event: 'pull_request_review', state });
      return { applied: true, reason: `review ${state}` };
   }

   /** A milestone renamed, closed or reopened on the host. */
   async #milestone(payload: Record<string, unknown>): Promise<InboundResult> {
      const milestone = payload.milestone as Record<string, unknown> | undefined;
      const externalId = Number(milestone?.id ?? 0);
      if (!externalId) return IGNORED('no milestone id');

      const link = await this.#links.resolve('github', 'milestone', externalId);
      if (!link) return IGNORED('milestone is not linked to a Berry goal');

      const title = typeof milestone?.title === 'string' ? milestone.title : null;
      const closed = String(milestone?.state ?? '') === 'closed';
      // Only the closed direction is applied. Re-opening a milestone cannot
      // say which of Berry's several non-final statuses the goal held before,
      // and inventing one would silently rewrite the goal's history.
      const status = closed ? 'completed' : null;

      await this.#sql`
         UPDATE goals
            SET title = COALESCE(${title}, title),
                status = COALESCE(${status}, status),
                completed_at = CASE WHEN ${closed} THEN COALESCE(completed_at, now())
                                    ELSE completed_at END,
                updated_at = now()
          WHERE id = ${link.berryId} AND deleted_at IS NULL`;

      await this.#links.touch({
         provider: 'github',
         berryType: 'milestone',
         berryId: link.berryId,
         externalUpdatedAt: typeof milestone?.updated_at === 'string' ? milestone.updated_at : null,
      });
      this.#logger.info('scm inbound applied', {
         event: 'milestone',
         goalId: link.berryId,
         closed,
      });
      return { applied: true, reason: 'milestone updated' };
   }
}
