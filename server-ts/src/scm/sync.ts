import type { Sql } from '../db/pool.ts';
import type { Logger } from '../observability/log.ts';
import type { ScmProvisioning } from './provisioning.ts';
import type { RepositoryRef } from './provider.ts';

/**
 * Keeping the git host in step with Berry's domain objects.
 *
 * The mounts call the two verbs here and nothing else. Everything about how a
 * goal becomes a milestone — which repository, what a `draft` status means as
 * a milestone state, what happens when the project has no repository — lives
 * behind them, so the goal-creation route stays a route about goals.
 *
 * Nothing here throws. Failing to mirror a goal is not a reason to fail
 * creating one, and the outcome is recorded on the object's link where an
 * operator and the serializer can both see it.
 */
export class ScmSync {
   readonly #sql: Sql;
   readonly #scm: ScmProvisioning;
   readonly #logger: Logger;

   constructor(sql: Sql, scm: ScmProvisioning, logger: Logger) {
      this.#sql = sql;
      this.#scm = scm;
      this.#logger = logger;
   }

   /**
    * Mirrors a goal as a milestone in its project's repository.
    *
    * A goal with no project is left alone rather than failed. A milestone
    * lives inside a repository, and Berry's goals are workspace-scoped with a
    * nullable project — so for some goals there is genuinely nowhere to put
    * one, and inventing a home would be worse than having none.
    */
   async goalCreated(goalId: string): Promise<void> {
      const [row] = await this.#sql`
         SELECT goal.id, goal.workspace_id, goal.project_id, goal.title, goal.description,
                goal.status
           FROM goals AS goal
          WHERE goal.id = ${goalId} AND goal.deleted_at IS NULL`;
      if (!row) return;

      const projectId = row.project_id as string | null;
      if (!projectId) return;
      const repo = await this.repositoryFor(projectId);
      if (!repo) return;

      await this.#scm.milestone({
         workspaceId: row.workspace_id as string,
         milestoneId: goalId,
         repo,
         title: row.title as string,
         description: (row.description as string | null) ?? null,
         state: milestoneState(row.status as string),
      });
   }

   /** Pushes a goal's title, description and state to its milestone. */
   async goalUpdated(goalId: string): Promise<void> {
      const link = await this.#scm.linkFor('milestone', goalId);
      if (!link?.externalId || link.status !== 'synced') return;

      const [row] = await this.#sql`
         SELECT workspace_id, project_id, title, description, status
           FROM goals WHERE id = ${goalId} AND deleted_at IS NULL`;
      if (!row?.project_id) return;
      const repo = await this.repositoryFor(row.project_id as string);
      if (!repo) return;

      await this.#scm.milestone({
         workspaceId: row.workspace_id as string,
         milestoneId: goalId,
         repo,
         title: row.title as string,
         description: (row.description as string | null) ?? null,
         state: milestoneState(row.status as string),
      });
   }

   /**
    * Mirrors a Berry task as an issue in its project's repository.
    *
    * The milestone comes from the goal the task is linked to, so a task
    * arrives on the host already filed under the same goal it has in Berry
    * rather than being sorted out by a later pass.
    */
   async issueCreated(issueId: string): Promise<void> {
      const context = await this.#issueContext(issueId);
      if (!context) return;

      const goalLink = context.goalId
         ? await this.#scm.linkFor('milestone', context.goalId)
         : null;

      await this.#scm.issue({
         workspaceId: context.workspaceId,
         issueId,
         repo: context.repo,
         title: context.title,
         body: context.description,
         milestoneId: goalLink?.status === 'synced' ? goalLink.externalId : null,
         labels: context.labels,
      });
   }

   /** Pushes a task's title, body, state and milestone to its issue. */
   async issueUpdated(issueId: string): Promise<void> {
      const context = await this.#issueContext(issueId);
      if (!context) return;

      const goalLink = context.goalId
         ? await this.#scm.linkFor('milestone', context.goalId)
         : null;

      await this.#scm.pushIssue({
         workspaceId: context.workspaceId,
         issueId,
         repo: context.repo,
         changes: {
            title: context.title,
            body: context.description,
            // Done and cancelled are the closed states; everything else,
            // including `in_review`, is still work in progress on the host.
            state: context.status === 'done' || context.status === 'cancelled' ? 'closed' : 'open',
            milestoneId: goalLink?.status === 'synced' ? goalLink.externalId : null,
            labels: context.labels,
         },
      });
   }

   /**
    * Where a project's repository is, as the host addresses it.
    *
    * `owner/name`, as the project's GitHub link records it. A project with no
    * link has no repository, which is a fact rather than a failure: plenty of
    * work is answering a question.
    */
   async repositoryFor(projectId: string): Promise<RepositoryRef | null> {
      const [row] = await this.#sql`
         SELECT github_repo_full_name FROM projects
          WHERE id = ${projectId} AND deleted_at IS NULL`;
      const full = (row?.github_repo_full_name as string | null) ?? null;
      if (!full) return null;
      const slash = full.indexOf('/');
      if (slash === -1) {
         // Not addressable. A GitHub repository is always `owner/name`, and a
         // bare value is a row from before that was true — reporting it as a
         // repository would build a URL that resolves to nothing.
         return null;
      }
      return { owner: full.slice(0, slash), name: full.slice(slash + 1) };
   }

   async #issueContext(issueId: string): Promise<{
      workspaceId: string;
      repo: RepositoryRef;
      title: string;
      description: string | null;
      status: string;
      goalId: string | null;
      labels: string[];
   } | null> {
      const [row] = await this.#sql`
         SELECT issue.id, issue.title, issue.description, issue.status::text AS status,
                board.workspace_id,
                link.project_id,
                goal.goal_id,
                coalesce(
                   (SELECT array_agg(label.name ORDER BY label.name)
                      FROM issue_label_memberships AS membership
                      JOIN issue_labels AS label ON label.id = membership.label_id
                     WHERE membership.issue_id = issue.id),
                   ARRAY[]::text[]
                ) AS labels
           FROM issues AS issue
           JOIN boards AS board ON board.id = issue.board_id
           LEFT JOIN issue_project_links AS link ON link.issue_id = issue.id
           LEFT JOIN goal_issues AS goal ON goal.issue_id = issue.id
          WHERE issue.id = ${issueId} AND issue.deleted_at IS NULL`;
      if (!row?.project_id) return null;

      const repo = await this.repositoryFor(row.project_id as string);
      if (!repo) return null;

      return {
         workspaceId: row.workspace_id as string,
         repo,
         title: row.title as string,
         description: (row.description as string | null) ?? null,
         status: row.status as string,
         goalId: (row.goal_id as string | null) ?? null,
         labels: (row.labels as string[] | null) ?? [],
      };
   }

   /** Reports a mirroring failure without letting it reach the caller. */
   guard(what: string, work: Promise<void>): void {
      void work.catch((error: unknown) => {
         this.#logger.error('scm sync failed', {
            what,
            error: error instanceof Error ? error.message : String(error),
         });
      });
   }
}

/**
 * A goal's status as a milestone state.
 *
 * GitHub has two states where Berry has several, so this is a narrowing and not
 * a mapping: everything that is not finished is open.
 */
function milestoneState(status: string): 'open' | 'closed' {
   return status === 'completed' || status === 'archived' || status === 'cancelled'
      ? 'closed'
      : 'open';
}
