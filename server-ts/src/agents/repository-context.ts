import type { Sql } from '../db/pool.ts';

/**
 * Which repository a run's work belongs in.
 *
 * A task reaches a repository through its project, because that is where the
 * link lives — Berry stores `github_repo_full_name` on a project and a task is
 * linked to projects. A task in no project, or in one with no repository, has
 * no code to change, and the run proceeds without a checkout rather than
 * failing: plenty of work is answering a question.
 *
 * A task belongs to at most one project: `issue_project_links` has its primary
 * key on `issue_id` alone, so the database will not hold a second link. There
 * is therefore no ordering rule to get right and no ambiguity to resolve —
 * which is worth stating, because the query below looks like it is picking one
 * of several and it is not.
 */

export interface RepositoryContext {
   /** `owner/name`. */
   fullName: string;
   projectId: string;
   projectName: string;
   /** Run against the tree before it is pushed. Empty means no evidence. */
   verifyCommands: string[];

}

export async function repositoryForIssue(
   sql: Sql,
   issueId: string
): Promise<RepositoryContext | null> {
   const [row] = await sql<
      Array<{
         project_id: string;
         name: string;
         github_repo_full_name: string;
         verify_commands: string[];
      }>
   >`
      SELECT p.id AS project_id, p.name, p.github_repo_full_name, p.verify_commands
        FROM issue_project_links l
        JOIN projects p ON p.id = l.project_id
       WHERE l.issue_id = ${issueId}
         AND p.deleted_at IS NULL
         AND p.github_repo_full_name IS NOT NULL`;

   if (!row) return null;
   return {
      fullName: row.github_repo_full_name as string,
      projectId: row.project_id,
      projectName: row.name,
      verifyCommands: row.verify_commands ?? [],
   };
}
