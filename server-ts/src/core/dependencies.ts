import type { Sql } from '../db/pool.ts';
import { Conflict, NotFound } from '../identity/errors.ts';
import { dbStatusToApi } from './issues.ts';

/**
 * Issue dependencies.
 *
 * An edge says "this issue waits on that one". Almost none of the rules live
 * here: a trigger refuses a cycle, a foreign key refuses an edge that crosses
 * workspaces, and a unique key makes adding the same edge twice a no-op. This
 * translates those refusals into something a caller can act on.
 */

/** One end of an edge, as a reader sees it. */
export interface DependencyRef {
   id: string;
   identifier: string;
   title: string;
   status: string;
}

/** Everything an issue waits on, and everything waiting on it. */
export interface IssueDependencies {
   dependsOn: DependencyRef[];
   blocks: DependencyRef[];
}

/** The edge would make an issue wait on itself. */
export class DependencyCycle extends Error {
   constructor() {
      super('dependency cycle');
      this.name = 'DependencyCycle';
   }
}

export class DependencyRepository {
   private readonly sql: Sql;

   constructor(sql: Sql) {
      this.sql = sql;
   }

   /**
    * Both directions, oldest edge first.
    *
    * One query rather than two: the edge table is symmetric, so which side an
    * issue is on decides which list it lands in. Deleted issues on the other
    * end are hidden, the same way every issue read hides them.
    */
   async list(issueId: string): Promise<IssueDependencies> {
      const rows = await this.sql`
         SELECT edge.issue_id, edge.depends_on_issue_id,
                other.id, berry_issue_identifier(board.workspace_id, other.number) AS identifier,
                other.title, other.status::text AS status
           FROM issue_dependencies AS edge
           JOIN issues AS other
             ON other.id = CASE WHEN edge.issue_id = ${issueId}
                                THEN edge.depends_on_issue_id ELSE edge.issue_id END
            AND other.deleted_at IS NULL
           JOIN boards AS board ON board.id = other.board_id
          WHERE edge.issue_id = ${issueId} OR edge.depends_on_issue_id = ${issueId}
          ORDER BY edge.created_at ASC, other.id ASC`;

      const result: IssueDependencies = { dependsOn: [], blocks: [] };
      for (const row of rows) {
         const ref: DependencyRef = {
            id: row.id as string,
            identifier: row.identifier as string,
            title: row.title as string,
            status: dbStatusToApi(row.status as string),
         };
         // The issue named in the path is the dependent on one side of the
         // edge and the blocker on the other.
         if (row.issue_id === issueId) result.dependsOn.push(ref);
         else result.blocks.push(ref);
      }
      return result;
   }

   /**
    * Records one edge.
    *
    * Adding the same edge twice is not an error: asking twice for the same
    * ordering is the same request. A self-edge is refused here rather than by
    * the trigger, because it is the one cycle cheap enough to see without
    * asking the database.
    */
   async add(params: {
      workspaceId: string;
      issueId: string;
      dependsOnIssueId: string;
      createdBy: string;
      createdAt: string;
   }): Promise<void> {
      if (params.issueId === params.dependsOnIssueId) throw new DependencyCycle();
      await this.sql`
         INSERT INTO issue_dependencies (
            workspace_id, issue_id, depends_on_issue_id, kind, created_by, created_at
         ) VALUES (
            ${params.workspaceId}, ${params.issueId}, ${params.dependsOnIssueId},
            'blocks', ${params.createdBy}, ${params.createdAt}
         )
         ON CONFLICT (issue_id, depends_on_issue_id) DO NOTHING`.catch(classifyEdgeWrite);
   }

   /** Removes one edge; an edge that was not there is a not-found. */
   async remove(issueId: string, dependsOnIssueId: string): Promise<void> {
      const removed = await this.sql`
         DELETE FROM issue_dependencies
          WHERE issue_id = ${issueId} AND depends_on_issue_id = ${dependsOnIssueId}`;
      if (removed.count === 0) throw new NotFound();
   }
}

/**
 * Local to dependency edges, and only here.
 *
 * A check violation means the trigger caught a cycle, which is true of no
 * other write in Berry; a foreign key violation covers both an unknown issue
 * and an edge crossing workspaces, which the caller reports the same way.
 */
function classifyEdgeWrite(error: unknown): never {
   const code = (error as { code?: string })?.code;
   if (code === '23514') throw new DependencyCycle();
   if (code === '23503') throw new NotFound();
   if (code === '23505' || code === '23P01') throw new Conflict();
   throw error;
}
