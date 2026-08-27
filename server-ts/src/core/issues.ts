import { createHash } from 'node:crypto';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import { allows, type Permission } from '../identity/roles.ts';
import { structJSON } from '../http/canonical-json.ts';
import type { Scope } from './boards.ts';

/**
 * Issues, ported from server/internal/repository/core/issues.go.
 *
 * An issue is reachable two ways — by UUID and by its workspace identifier,
 * `BER-57` — and both resolve through board and workspace membership, so an
 * issue outside the caller's workspaces is invisible either way.
 */

const ISSUE_COLUMNS = `i.id, i.board_id, w.id AS workspace_id, b.slug AS board_slug,
   w.settings->>'issuePrefix' AS issue_prefix, i.number, i.title, i.description,
   i.status::text AS status, i.priority::text AS priority, i.sort_order, i.due_date,
   i.assignee_type::text AS assignee_type, i.assignee_id,
   COALESCE(assignee_user.name, assignee_agent.name) AS assignee_name,
   COALESCE(assignee_user.avatar_url, assignee_agent.avatar_url) AS assignee_avatar_url,
   i.active_run_id,
   project.id AS project_id, project.name AS project_name,
   i.created_by, creator.name AS creator_name, creator.avatar_url AS creator_avatar_url,
   i.created_at, i.updated_at`;

/**
 * An issue belongs to at most one project, and the link table's primary key on
 * issue_id is what guarantees that — so none of these joins can fan out.
 */
const ISSUE_JOINS = `
   JOIN workspaces AS w ON w.id = b.workspace_id AND w.deleted_at IS NULL
   LEFT JOIN users AS assignee_user
     ON i.assignee_type = 'user' AND assignee_user.id = i.assignee_id
   LEFT JOIN agents AS assignee_agent
     ON i.assignee_type = 'agent' AND assignee_agent.id = i.assignee_id
   LEFT JOIN users AS creator ON creator.id = i.created_by
   LEFT JOIN issue_project_links AS link ON link.issue_id = i.id
   LEFT JOIN projects AS project
     ON project.id = link.project_id AND project.deleted_at IS NULL`;

const ISSUE_SOURCE = `FROM issues AS i
   JOIN boards AS b ON b.id = i.board_id AND i.deleted_at IS NULL${ISSUE_JOINS}`;

export interface ActorRef {
   type: string;
   id: string;
   name: string;
   avatarUrl: string | null;
}

export interface Issue {
   id: string;
   boardId: string;
   number: number;
   identifier: string;
   title: string;
   description: string | null;
   status: string;
   priority: string;
   sortOrder: number;
   dueDate: string | null;
   assignee: ActorRef | null;
   activeRunId: string | null;
   project: { id: string; name: string } | null;
   createdBy: ActorRef | null;
   createdAt: string;
   updatedAt: string;
}

export interface IssueDependencyRef {
   id: string;
   identifier: string;
   title: string;
   status: string;
}

export interface IssueRelations {
   goal: { id: string; title: string } | null;
   origin: {
      workflowId: string;
      workflowRunId: string;
      workflowStepRunId: string | null;
   } | null;
   dependsOn: IssueDependencyRef[];
   blocks: IssueDependencyRef[];
}

export interface AssigneeInput {
   type: string;
   id: string;
}

export interface IssueListFilter {
   boardId: string;
   statuses: string[] | null;
   priorities: string[] | null;
   assignee: AssigneeInput | null;
   query: string | null;
   after: { updatedAt: string; id: string } | null;
   limit: number;
}

export class IssueRepository {
   private readonly sql: Sql;

   constructor(sql: Sql) {
      this.sql = sql;
   }

   /** The workspace and role behind an issue, by UUID. */
   async authorize(userId: string, issueId: string, permission: Permission): Promise<Scope> {
      return this.scopeFrom(
         this.sql`
            SELECT board.workspace_id, membership.role::text AS role
              FROM issues AS issue
              JOIN boards AS board ON board.id = issue.board_id AND issue.deleted_at IS NULL
              JOIN workspaces AS workspace
                ON workspace.id = board.workspace_id AND workspace.deleted_at IS NULL
              JOIN workspace_memberships AS membership
                ON membership.workspace_id = workspace.id AND membership.user_id = ${userId}
             WHERE issue.id = ${issueId}`,
         permission
      );
   }

   /**
    * The same, by either form of reference.
    *
    * Nested routes receive whichever the client had — a UUID from a link, or
    * `BER-57` from a person typing it — and both must land on the same
    * membership check.
    */
   async authorizeReference(
      userId: string,
      reference: string,
      permission: Permission
   ): Promise<Scope> {
      const id = parseCanonicalUUID(reference);
      if (id !== null) return this.authorize(userId, id, permission);
      return this.scopeFrom(
         this.sql`
            SELECT board.workspace_id, membership.role::text AS role
              FROM issues AS issue
              JOIN boards AS board ON board.id = issue.board_id AND issue.deleted_at IS NULL
              JOIN workspaces AS workspace
                ON workspace.id = board.workspace_id AND workspace.deleted_at IS NULL
              JOIN workspace_memberships AS membership
                ON membership.workspace_id = workspace.id AND membership.user_id = ${userId}
             WHERE lower(workspace.settings->>'issuePrefix') || '-' || issue.number::text
                   = lower(${reference})`,
         permission
      );
   }

   private async scopeFrom(
      query: PromiseLike<readonly (object | undefined)[]>,
      permission: Permission
   ): Promise<Scope> {
      const [row] = (await query) as Array<Record<string, unknown>>;
      if (!row) throw new NotFound();
      const scope = { workspaceId: row.workspace_id as string, role: row.role as string };
      if (!allows(scope.role, permission)) throw new Forbidden();
      return scope;
   }

   /**
    * One page of a filtered board.
    *
    * Every filter is passed as a parameter guarded by a boolean rather than
    * appended to the SQL, so the statement is one prepared shape whatever the
    * caller asked for.
    */
   async list(filter: IssueListFilter): Promise<Issue[]> {
      const assignee = filter.assignee;
      const rows = await this.sql`
         SELECT ${this.sql.unsafe(ISSUE_COLUMNS)} ${this.sql.unsafe(ISSUE_SOURCE)}
          WHERE i.board_id = ${filter.boardId}
            AND (COALESCE(cardinality(${filter.statuses}::text[]), 0) = 0 OR
                 i.status::text = ANY(${filter.statuses}::text[]))
            AND (COALESCE(cardinality(${filter.priorities}::text[]), 0) = 0 OR
                 i.priority::text = ANY(${filter.priorities}::text[]))
            AND (NOT ${assignee !== null}::boolean OR (
                 i.assignee_type::text = ${assignee?.type ?? null}::text AND
                 i.assignee_id = ${assignee?.id ?? null}::uuid))
            AND (NOT ${filter.query !== null}::boolean OR (
                 i.title ILIKE ${filter.query}::text ESCAPE E'\\\\' OR
                 (w.settings->>'issuePrefix' || '-' || i.number::text)
                     ILIKE ${filter.query}::text ESCAPE E'\\\\'))
            AND (NOT ${filter.after !== null}::boolean OR
                 (i.updated_at, i.id) < (${filter.after?.updatedAt ?? null}::timestamptz,
                                         ${filter.after?.id ?? null}::uuid))
          ORDER BY i.updated_at DESC, i.id DESC
          LIMIT ${filter.limit}`;
      return rows.map(toIssue);
   }

   /** By UUID or by identifier; anything else is simply not found. */
   async get(reference: string): Promise<Issue> {
      const id = parseCanonicalUUID(reference);
      if (id !== null) {
         const [row] = await this.sql`
            SELECT ${this.sql.unsafe(ISSUE_COLUMNS)} ${this.sql.unsafe(ISSUE_SOURCE)}
             WHERE i.id = ${id}`;
         if (!row) throw new NotFound();
         return toIssue(row);
      }

      const parsed = parseIdentifier(reference);
      if (parsed === null) throw new NotFound();
      const [row] = await this.sql`
         SELECT ${this.sql.unsafe(ISSUE_COLUMNS)} ${this.sql.unsafe(ISSUE_SOURCE)}
          WHERE lower(w.settings->>'issuePrefix') = lower(${parsed.prefix})
            AND i.number = ${parsed.number}`;
      if (!row) throw new NotFound();
      return toIssue(row);
   }

   /**
    * Goal, workflow origin, and both directions of the dependency graph.
    *
    * Each edge is described from both ends in one row, because a page that
    * contains both issues of an edge needs the blocker on the dependent's
    * `dependsOn` *and* the dependent on the blocker's `blocks`. Choosing one
    * side per row leaves `blocks` empty on every list read.
    */
   async loadRelations(issueIds: string[]): Promise<Map<string, IssueRelations>> {
      const result = new Map<string, IssueRelations>(
         issueIds.map((id) => [id, { goal: null, origin: null, dependsOn: [], blocks: [] }])
      );
      if (issueIds.length === 0) return result;

      const goals = await this.sql`
         SELECT link.issue_id, goal.id, goal.title
           FROM goal_issues AS link
           JOIN goals AS goal ON goal.id = link.goal_id AND goal.deleted_at IS NULL
          WHERE link.issue_id = ANY(${issueIds}::uuid[])`;
      for (const row of goals) {
         const relations = result.get(row.issue_id as string);
         if (relations) relations.goal = { id: row.id as string, title: row.title as string };
      }

      const origins = await this.sql`
         SELECT issue_id, automation_id, automation_run_id, automation_step_run_id
           FROM automation_issue_origins
          WHERE issue_id = ANY(${issueIds}::uuid[])`;
      for (const row of origins) {
         const relations = result.get(row.issue_id as string);
         if (relations) {
            relations.origin = {
               workflowId: row.automation_id as string,
               workflowRunId: row.automation_run_id as string,
               workflowStepRunId: (row.automation_step_run_id as string | null) ?? null,
            };
         }
      }

      const edges = await this.sql`
         SELECT edge.issue_id, edge.depends_on_issue_id,
                dependent.title AS dependent_title, dependent.status::text AS dependent_status,
                berry_issue_identifier(dependent_board.workspace_id, dependent.number) AS dependent_identifier,
                blocker.title AS blocker_title, blocker.status::text AS blocker_status,
                berry_issue_identifier(blocker_board.workspace_id, blocker.number) AS blocker_identifier
           FROM issue_dependencies AS edge
           JOIN issues AS dependent ON dependent.id = edge.issue_id AND dependent.deleted_at IS NULL
           JOIN boards AS dependent_board ON dependent_board.id = dependent.board_id
           JOIN issues AS blocker ON blocker.id = edge.depends_on_issue_id AND blocker.deleted_at IS NULL
           JOIN boards AS blocker_board ON blocker_board.id = blocker.board_id
          WHERE edge.issue_id = ANY(${issueIds}::uuid[])
             OR edge.depends_on_issue_id = ANY(${issueIds}::uuid[])
          ORDER BY edge.created_at ASC, edge.issue_id ASC, edge.depends_on_issue_id ASC`;
      for (const row of edges) {
         const dependentId = row.issue_id as string;
         const blockerId = row.depends_on_issue_id as string;
         const dependent: IssueDependencyRef = {
            id: dependentId,
            identifier: row.dependent_identifier as string,
            title: row.dependent_title as string,
            status: dbStatusToApi(row.dependent_status as string),
         };
         const blocker: IssueDependencyRef = {
            id: blockerId,
            identifier: row.blocker_identifier as string,
            title: row.blocker_title as string,
            status: dbStatusToApi(row.blocker_status as string),
         };
         result.get(dependentId)?.dependsOn.push(blocker);
         result.get(blockerId)?.blocks.push(dependent);
      }
      return result;
   }
}

/**
 * The cursor scope, which is a hash of the filter itself.
 *
 * A cursor is therefore only valid for the query that produced it: paging with
 * one filter and then changing the filter yields INVALID_CURSOR rather than a
 * page that silently skips rows.
 *
 * The hash is over Go's `json.Marshal` of a struct — declaration order, never
 * sorted, and a nil slice is `null` where an empty slice is `[]`. Verified
 * against seven filter shapes hashed by the running Go server.
 */
export function issueCursorScope(filter: {
   boardId: string;
   statuses: string[] | null;
   priorities: string[] | null;
   assignee: AssigneeInput | null;
   query: string | null;
}): string {
   const shape = {
      boardId: filter.boardId,
      statuses: filter.statuses,
      priorities: filter.priorities,
      // AssigneeInput carries no json tags, so Go writes its field names.
      assignee: filter.assignee ? { Type: filter.assignee.type, ID: filter.assignee.id } : null,
      query: filter.query,
   };
   return `issues.list.${createHash('sha256').update(structJSON(shape)).digest('hex').slice(0, 16)}`;
}

/** The API spells two statuses in camelCase; the enum uses underscores. */
export function dbStatusToApi(status: string): string {
   if (status === 'in_progress') return 'inProgress';
   if (status === 'in_review') return 'inReview';
   return status;
}

export function apiStatusToDb(status: string): string {
   if (status === 'inProgress') return 'in_progress';
   if (status === 'inReview') return 'in_review';
   return status;
}

/**
 * A UUID in exactly the canonical form, and an RFC 4122 one.
 *
 * Go's ParseUUID refuses the brace and URN spellings that uuid.Parse accepts,
 * and refuses the nil UUID, so a reference that is nearly a UUID falls through
 * to identifier parsing rather than silently matching nothing.
 */
export function parseCanonicalUUID(raw: string): string | null {
   if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
      return null;
   }
   if (raw === '00000000-0000-0000-0000-000000000000') return null;
   return raw.toLowerCase();
}

/** `BER-57` into its prefix and number. The split is at the *last* hyphen. */
export function parseIdentifier(reference: string): { prefix: string; number: number } | null {
   const index = reference.lastIndexOf('-');
   if (index < 1 || index === reference.length - 1) return null;
   const tail = reference.slice(index + 1);
   if (!/^\d+$/.test(tail)) return null;
   const number = Number(tail);
   if (!Number.isInteger(number) || number < 1 || number > 2147483647) return null;
   const prefix = reference.slice(0, index);
   if (prefix === '' || prefix.trim() !== prefix) return null;
   return { prefix, number };
}

/** `%` and `_` are ILIKE wildcards; a search for them must match literally. */
export function escapeSearchLiteral(value: string): string {
   return `%${value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
}

export function formatIdentifier(prefix: string, number: number): string {
   return `${prefix.trim().toUpperCase()}-${number}`;
}

/**
 * An actor reference, with the placeholder Go uses when the join found no row.
 *
 * A deleted user still has issues attributed to them, and the wire shape has
 * no room for a missing name — so the reference carries "Unknown user" rather
 * than an empty string, which would render as a blank byline.
 */
function actorRef(
   type: string,
   id: string,
   name: string | null,
   avatarUrl: string | null
): ActorRef {
   return {
      type,
      id,
      name: name ?? (type === 'user' ? 'Unknown user' : 'Agent'),
      avatarUrl,
   };
}

function toIssue(row: Record<string, unknown>): Issue {
   const assigneeType = row.assignee_type as string | null;
   return {
      id: row.id as string,
      boardId: row.board_id as string,
      number: row.number as number,
      identifier: formatIdentifier((row.issue_prefix as string | null) ?? '', row.number as number),
      title: row.title as string,
      description: (row.description as string | null) ?? null,
      status: dbStatusToApi(row.status as string),
      priority: row.priority as string,
      sortOrder: row.sort_order as number,
      dueDate: row.due_date ? toRFC3339(row.due_date as string) : null,
      assignee:
         assigneeType && row.assignee_id
            ? actorRef(
                 assigneeType,
                 row.assignee_id as string,
                 row.assignee_name as string | null,
                 row.assignee_avatar_url as string | null
              )
            : null,
      activeRunId: (row.active_run_id as string | null) ?? null,
      project: row.project_id
         ? { id: row.project_id as string, name: row.project_name as string }
         : null,
      createdBy: row.created_by
         ? actorRef(
              'user',
              row.created_by as string,
              row.creator_name as string | null,
              row.creator_avatar_url as string | null
           )
         : null,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}
