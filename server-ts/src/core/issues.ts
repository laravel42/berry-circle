import { createHash } from 'node:crypto';
import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';
import { Conflict, Forbidden, NotFound } from '../identity/errors.ts';
import { allows, type Permission } from '../identity/roles.ts';
import { structJSON } from '../http/canonical-json.ts';
import type { Scope } from './boards.ts';

/**
 * Issues.
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
   i.created_at, i.updated_at,
   i.parent_id, i.stage, i.status_id,
   (SELECT count(*) FROM issues AS child
     WHERE child.parent_id = i.id AND child.deleted_at IS NULL)::int AS child_total,
   (SELECT count(*) FROM issues AS child
     WHERE child.parent_id = i.id AND child.deleted_at IS NULL
       AND child.status IN ('done', 'cancelled'))::int AS child_done`;

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

/** The same, including deleted rows — an event still describes what was deleted. */
const ISSUE_SOURCE_ANY = `FROM issues AS i
   JOIN boards AS b ON b.id = i.board_id${ISSUE_JOINS}`;

export interface ActorRef {
   type: string;
   id: string;
   name: string;
   avatarUrl: string | null;
}

export interface Issue {
   id: string;
   boardId: string;
   /**
    * The workspace the issue's board belongs to.
    *
    * Read from the row and deliberately not serialized: the wire shape has
    * never carried it. Callers that need to compare two issues' workspaces —
    * a dependency edge may not cross one — would otherwise have to ask again
    * for something the query already selected.
    */
   workspaceId: string;
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
   /** The issue this one is a sub-issue of. */
   parentId: string | null;
   /** Ordered barrier among siblings; null means no stage. */
   stage: number | null;
   /** The custom status refining `status`, when one is set. */
   statusId: string | null;
   childProgress: { total: number; done: number };
}

export interface IssueDependencyRef {
   id: string;
   identifier: string;
   title: string;
   status: string;
}

export interface IssueRelations {
   goal: { id: string; title: string } | null;
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

/** The wire form of a mutation, ready to publish. */
export interface IssueMutationEvent {
   id: string;
   type: string;
   workspaceId: string;
   boardId: string;
   issueId: string;
   payload: string;
   occurredAt: Date;
}

export interface IssuePatch {
   title?: string;
   descriptionSet: boolean;
   description?: string | null;
   status?: string;
   /** A custom status of `status`'s category. Undefined leaves it alone. */
   statusId?: string | null;
   priority?: string;
   sortOrder?: number;
   dueDateSet: boolean;
   dueDate?: string | null;
   assigneeSet: boolean;
   assignee?: AssigneeInput | null;
   projectSet: boolean;
   project?: string | null;
}

/** A status change the board's rules do not allow. */
export class InvalidTransition extends Error {
   readonly from: string;
   readonly to: string;
   constructor(from: string, to: string) {
      super(`cannot transition from ${from} to ${to}`);
      this.name = 'InvalidTransition';
      this.from = from;
      this.to = to;
   }
}

/** A database gate refused the write: the issue is waiting for approval. */
export class ApprovalRequired extends Error {
   constructor() {
      super('approval required');
      this.name = 'ApprovalRequired';
   }
}

export class ProjectNotFound extends Error {
   constructor() {
      super('project not found');
      this.name = 'ProjectNotFound';
   }
}

/**
 * Which statuses an issue may move to.
 *
 * Written out rather than derived: `done` leads only back to `in_review`, and
 * `in_review` can return to `todo` because a reviewer sends rejected work back
 * to be done again — a person looking at the same work must be able to do what
 * the reviewer does.
 */
const TRANSITIONS: Record<string, string[]> = {
   backlog: ['todo', 'cancelled'],
   todo: ['backlog', 'in_progress', 'blocked', 'cancelled'],
   in_progress: ['todo', 'in_review', 'blocked', 'cancelled'],
   in_review: ['todo', 'in_progress', 'done', 'blocked', 'cancelled'],
   done: ['in_review'],
   blocked: ['todo', 'in_progress', 'cancelled'],
   cancelled: ['backlog', 'todo'],
};

export function canTransition(from: string, to: string): boolean {
   return from === to || (TRANSITIONS[from]?.includes(to) ?? false);
}

export class IssueRepository {
   private readonly sql: Sql;
   private readonly clock: () => Date;
   private readonly newId: () => string;

   constructor(sql: Sql, clock: () => Date = () => new Date(), newId = () => crypto.randomUUID()) {
      this.sql = sql;
      this.clock = clock;
      this.newId = newId;
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
    * Whether an actor can be assigned work in this workspace.
    *
    * A user must be a member; an agent must belong to the workspace, directly
    * or through its board, and not be archived. Without this an issue could be
    * assigned to someone from another workspace, whose name would then render
    * on a board they cannot open.
    */
   async assigneeExistsInWorkspace(
      workspaceId: string,
      actorType: string,
      actorId: string
   ): Promise<boolean> {
      if (actorType === 'user') {
         const [row] = await this.sql`
            SELECT EXISTS (
               SELECT 1
                 FROM workspace_memberships AS membership
                 JOIN workspaces AS workspace
                   ON workspace.id = membership.workspace_id AND workspace.deleted_at IS NULL
                WHERE membership.workspace_id = ${workspaceId}
                  AND membership.user_id = ${actorId}
            ) AS present`;
         return Boolean(row?.present);
      }
      if (actorType === 'agent') {
         const [row] = await this.sql`
            SELECT EXISTS (
               SELECT 1
                 FROM agents AS agent
                 LEFT JOIN boards AS board ON board.id = agent.board_id
                WHERE agent.id = ${actorId}
                  AND agent.archived_at IS NULL
                  AND COALESCE(agent.workspace_id, board.workspace_id) = ${workspaceId}
            ) AS present`;
         return Boolean(row?.present);
      }
      return false;
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
    * Creates an issue, its assignment and its project link in one transaction.
    *
    * The board is locked FOR KEY SHARE first, so it cannot be deleted between
    * allocating a number and inserting the row that uses it.
    */
   async create(params: {
      boardId: string;
      title: string;
      description: string | null;
      status: string;
      priority: string;
      sortOrder: number;
      dueDate: string | null;
      assignee: AssigneeInput | null;
      project: string | null;
      /**
       * A users.id, or nobody. An agent is not a user, so work it files carries
       * the person who asked for it and nothing when nobody did (an autopilot).
       * The column is nullable, and `created_by` is the only honest answer.
       */
      createdBy: string | null;
   }): Promise<{ issue: Issue; events: IssueMutationEvent[] }> {
      const id = this.newId();
      const now = this.clock().toISOString();

      return this.sql.begin(async (tx) => {
         const [board] = await tx`
            SELECT slug FROM boards WHERE id = ${params.boardId} FOR KEY SHARE`;
         if (!board) throw new NotFound();
         await assertAssigneeExists(tx, params.assignee);

         // A sequence function, not a count: two concurrent creates must not
         // both take the same number.
         const [allocated] = await tx`SELECT berry_next_issue_number(${params.boardId}) AS number`;
         const number = allocated!.number as number;

         await tx`
            INSERT INTO issues (
               id, board_id, number, title, description, status, priority,
               sort_order, due_date, assignee_type, assignee_id, created_by,
               created_at, updated_at
            ) VALUES (
               ${id}, ${params.boardId}, ${number}, ${params.title}, ${params.description},
               ${params.status}::issue_status, ${params.priority}::issue_priority,
               ${params.sortOrder}, ${params.dueDate},
               ${params.assignee?.type ?? null}::assignee_type, ${params.assignee?.id ?? null},
               ${params.createdBy}, ${now}, ${now}
            )`.catch(classifyWrite);

         if (params.assignee) {
            await tx`
               INSERT INTO assignments (id, issue_id, assignee_type, assignee_id, assigned_by, created_at)
               VALUES (${this.newId()}, ${id}, ${params.assignee.type}::assignee_type,
                       ${params.assignee.id}, ${params.createdBy}, ${now})`.catch(classifyWrite);
         }
         if (params.project) {
            await setIssueProject(tx, id, params.project, params.createdBy);
         }

         // Read back after linking, so the returned issue carries its project
         // and a caller can render it without a second request.
         const issue = await issueById(tx, id, false);
         const events = await this.recordEvents(tx, {
            issueId: id,
            kind: 'created',
            actor: { type: 'user', id: params.createdBy },
            occurredAt: now,
         });
         return { issue, events };
      });
   }

   /**
    * Applies a patch under a row lock.
    *
    * The lock is what makes the transition check meaningful: two concurrent
    * patches reading the same status could each find their move legal and
    * commit a pair that is not.
    */
   async update(params: {
      issueId: string;
      patch: IssuePatch;
      actorId: string;
      /**
       * Who the change is recorded as. A person by default; an agent when the
       * review gate moves a task on a peer's verdict, so the timeline says an
       * agent did it rather than attributing it to a user id that is not one.
       */
      actorType?: 'user' | 'agent';
   }): Promise<{ issue: Issue; events: IssueMutationEvent[] }> {
      const { patch } = params;
      const now = this.clock().toISOString();

      return this.sql.begin(async (tx) => {
         const [locked] = await tx`
            SELECT status::text AS status FROM issues
             WHERE id = ${params.issueId} AND deleted_at IS NULL
             FOR UPDATE`;
         if (!locked) throw new NotFound();
         const currentStatus = locked.status as string;

         if (patch.status !== undefined && !canTransition(currentStatus, patch.status)) {
            throw new InvalidTransition(dbStatusToApi(currentStatus), dbStatusToApi(patch.status));
         }
         if (patch.assigneeSet) await assertAssigneeExists(tx, patch.assignee ?? null);

         const updated = await tx`
            UPDATE issues SET
               title = CASE WHEN ${patch.title !== undefined} THEN ${patch.title ?? null}::text ELSE title END,
               description = CASE WHEN ${patch.descriptionSet} THEN ${patch.description ?? null}::text ELSE description END,
               status = CASE WHEN ${patch.status !== undefined} THEN ${patch.status ?? null}::issue_status ELSE status END,
               status_id = CASE WHEN ${patch.statusId !== undefined} THEN ${patch.statusId ?? null}::uuid ELSE status_id END,
               priority = CASE WHEN ${patch.priority !== undefined} THEN ${patch.priority ?? null}::issue_priority ELSE priority END,
               sort_order = CASE WHEN ${patch.sortOrder !== undefined} THEN ${patch.sortOrder ?? null}::integer ELSE sort_order END,
               due_date = CASE WHEN ${patch.dueDateSet} THEN ${patch.dueDate ?? null}::timestamptz ELSE due_date END,
               assignee_type = CASE WHEN ${patch.assigneeSet} THEN ${patch.assignee?.type ?? null}::assignee_type ELSE assignee_type END,
               assignee_id = CASE WHEN ${patch.assigneeSet} THEN ${patch.assignee?.id ?? null}::uuid ELSE assignee_id END,
               updated_at = ${now}
             WHERE id = ${params.issueId}`.catch(classifyWrite);
         if (updated.count !== 1) throw new NotFound();

         if (patch.assigneeSet && patch.assignee) {
            await tx`
               INSERT INTO assignments (id, issue_id, assignee_type, assignee_id, assigned_by, created_at)
               VALUES (${this.newId()}, ${params.issueId}, ${patch.assignee.type}::assignee_type,
                       ${patch.assignee.id}, ${params.actorId}, ${now})`.catch(classifyWrite);
         }
         if (patch.projectSet) {
            await setIssueProject(tx, params.issueId, patch.project ?? null, params.actorId);
         }

         const issue = await issueById(tx, params.issueId, false);
         const { changed, previousStatus } = patchChanges(patch, currentStatus);
         const events = await this.recordEvents(tx, {
            issueId: params.issueId,
            kind: 'updated',
            changedFields: changed,
            previousStatus,
            actor: { type: params.actorType ?? 'user', id: params.actorId },
            occurredAt: now,
         });
         return { issue, events };
      });
   }

   /**
    * Soft-deletes, so what the issue owned survives.
    *
    * Its runs, the history of what agents did through it and the artifacts
    * they produced are all retained: an issue is removed because it is no
    * longer wanted on a board, which is not a reason to destroy the record of
    * work already done. An in-flight run is left to finish for the same
    * reason — what it did in the outside world happened either way.
    */
   async remove(params: {
      issueId: string;
      deletedBy: string;
   }): Promise<{ issue: Issue; events: IssueMutationEvent[] }> {
      const now = this.clock().toISOString();
      return this.sql.begin(async (tx) => {
         // Read first: after the update the projection would exclude it, and
         // the response names what was deleted.
         const issue = await issueById(tx, params.issueId, true);
         const deleted = await tx`
            UPDATE issues SET deleted_at = ${now}, updated_at = ${now}
             WHERE id = ${params.issueId} AND deleted_at IS NULL`;
         // Already deleted reads as not-found, so a second click from a stale
         // board says something true rather than reporting success.
         if (deleted.count === 0) throw new NotFound();

         const events = await this.recordEvents(tx, {
            issueId: params.issueId,
            kind: 'deleted',
            actor: { type: 'user', id: params.deletedBy },
            occurredAt: now,
         });
         return { issue, events };
      });
   }

   /**
    * Writes the outbox rows for one mutation and returns them to publish.
    *
    * Persisted inside the caller's transaction and broadcast after it commits:
    * the outbox is the durable record, and the relay is a courtesy. A publish
    * that fails loses a live update, never the fact.
    */
   private async recordEvents(
      tx: Queryable,
      params: {
         issueId: string;
         kind: 'created' | 'updated' | 'deleted';
         changedFields?: string[];
         previousStatus?: string | undefined;
         actor: { type: string; id: string | null };
         occurredAt: string;
      }
   ): Promise<IssueMutationEvent[]> {
      // The snapshot includes deleted issues: a deletion event still has to
      // describe what was deleted.
      const snapshot = await issueById(tx, params.issueId, true);
      const [row] = await tx`
         SELECT b.workspace_id FROM issues AS i
           JOIN boards AS b ON b.id = i.board_id
          WHERE i.id = ${params.issueId}`;
      if (!row) throw new NotFound();
      const workspaceId = row.workspace_id as string;

      const topics = eventTopics(params.kind, params.changedFields ?? [], snapshot, params.previousStatus);
      const payload = JSON.stringify({
         issue: serializeIssueEvent(snapshot),
         changedFields: params.changedFields ?? [],
         ...(params.previousStatus ? { previousStatus: params.previousStatus } : {}),
         actor: params.actor,
      });

      const events: IssueMutationEvent[] = [];
      for (const [index, topic] of topics.entries()) {
         // A microsecond apart, so two topics from one mutation order stably.
         const occurredAt = new Date(new Date(params.occurredAt).getTime() + index / 1000);
         const event: IssueMutationEvent = {
            id: this.newId(),
            type: topic,
            workspaceId,
            boardId: snapshot.boardId,
            issueId: snapshot.id,
            payload,
            occurredAt,
         };
         // An object, not a pre-serialised string. Passing text and casting
         // it with ::jsonb stores a jsonb *string* — the whole envelope
         // quoted and escaped — which every consumer then fails to decode.
         const envelope = {
            id: event.id,
            type: event.type,
            occurredAt: occurredAt.toISOString(),
            workspaceId: event.workspaceId,
            boardId: event.boardId,
            issueId: event.issueId,
            runId: null,
            sequence: null,
            aggregateType: 'issue',
            aggregateId: event.issueId,
            payload: JSON.parse(payload),
         };
         await tx`
            INSERT INTO outbox_events (
               id, topic, aggregate_type, aggregate_id, workspace_id, board_id,
               payload, occurred_at, available_at
            ) VALUES (
               ${event.id}, ${event.type}, 'issue', ${event.issueId}, ${event.workspaceId},
               ${event.boardId}, ${tx.json(envelope)}::jsonb, ${occurredAt.toISOString()},
               ${occurredAt.toISOString()}
            )`;
         events.push(event);
      }
      return events;
   }

   /**
    * Goal, and both directions of the dependency graph.
    *
    * Each edge is described from both ends in one row, because a page that
    * contains both issues of an edge needs the blocker on the dependent's
    * `dependsOn` *and* the dependent on the blocker's `blocks`. Choosing one
    * side per row leaves `blocks` empty on every list read.
    */
   async loadRelations(issueIds: string[]): Promise<Map<string, IssueRelations>> {
      const result = new Map<string, IssueRelations>(
         issueIds.map((id) => [id, { goal: null, dependsOn: [], blocks: [] }])
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
 * The hash is over the canonical struct form — declaration order, never
 * sorted, and an absent slice is `null` where an empty one is `[]`. Verified
 * against seven captured filter shapes.
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
      workspaceId: row.workspace_id as string,
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
      parentId: (row.parent_id as string | null) ?? null,
      stage: row.stage === null || row.stage === undefined ? null : Number(row.stage),
      statusId: (row.status_id as string | null) ?? null,
      childProgress: { total: Number(row.child_total ?? 0), done: Number(row.child_done ?? 0) },
   };
}

/**
 * A user assignee must exist; an agent is not checked here.
 *
 * Agents live behind a separate lifecycle and may be created concurrently, so
 * the workspace-scoped check the handler performs is the one that matters for
 * them. FOR KEY SHARE holds the user row against deletion for the transaction.
 */
async function assertAssigneeExists(tx: Queryable, assignee: AssigneeInput | null): Promise<void> {
   if (!assignee || assignee.type === 'agent') return;
   const [row] = await tx`SELECT id FROM users WHERE id = ${assignee.id} FOR KEY SHARE`;
   if (!row) throw new NotFound();
}

/** An issue by id, optionally including one already deleted. */
async function issueById(tx: Queryable, id: string, includeDeleted: boolean): Promise<Issue> {
   const source = includeDeleted ? ISSUE_SOURCE_ANY : ISSUE_SOURCE;
   const [row] = await tx`
      SELECT ${tx.unsafe(ISSUE_COLUMNS)} ${tx.unsafe(source)} WHERE i.id = ${id}`;
   if (!row) throw new NotFound();
   return toIssue(row);
}

/**
 * Links or unlinks an issue's project.
 *
 * The project must be in the issue's own workspace: without that check a
 * caller could file an issue under a project they cannot see, and the join
 * would happily render its name.
 */
async function setIssueProject(
   tx: Queryable,
   issueId: string,
   projectId: string | null,
   linkedBy: string | null
): Promise<void> {
   if (projectId === null) {
      await tx`DELETE FROM issue_project_links WHERE issue_id = ${issueId}`;
      return;
   }
   const [scope] = await tx`
      SELECT board.workspace_id
        FROM issues AS issue
        JOIN boards AS board ON board.id = issue.board_id
       WHERE issue.id = ${issueId} AND issue.deleted_at IS NULL`;
   if (!scope) throw new NotFound();

   const [present] = await tx`
      SELECT EXISTS (
         SELECT 1 FROM projects
          WHERE id = ${projectId} AND workspace_id = ${scope.workspace_id as string}
            AND deleted_at IS NULL
      ) AS present`;
   if (!present?.present) throw new ProjectNotFound();

   await tx`
      INSERT INTO issue_project_links (workspace_id, issue_id, project_id, linked_by)
      VALUES (${scope.workspace_id as string}, ${issueId}, ${projectId}, ${linkedBy})
      ON CONFLICT (issue_id) DO UPDATE
         SET project_id = EXCLUDED.project_id, linked_by = EXCLUDED.linked_by`;
}

/**
 * Which topics one mutation publishes.
 *
 * An update can be several facts at once — a status move to `in_progress` is
 * both `issue.updated` and `issue.started` — because a consumer subscribing to
 * starts should not have to diff snapshots to find them.
 */
function eventTopics(
   kind: 'created' | 'updated' | 'deleted',
   changedFields: string[],
   snapshot: Issue,
   previousStatus: string | undefined
): string[] {
   if (kind === 'created') return ['issue.created'];
   if (kind === 'deleted') return ['issue.deleted'];

   const topics = ['issue.updated'];
   if (changedFields.includes('assignee') && snapshot.assignee) topics.push('issue.assigned');
   if (previousStatus && previousStatus !== apiStatusToDb(snapshot.status)) {
      if (snapshot.status === 'inProgress') topics.push('issue.started');
      if (snapshot.status === 'done') topics.push('issue.completed');
   }
   return topics;
}

/** What actually changed, for consumers that apply a diff rather than a snapshot. */
function patchChanges(
   patch: IssuePatch,
   currentStatus: string
): { changed: string[]; previousStatus: string | undefined } {
   const changed: string[] = [];
   let previousStatus: string | undefined;
   if (patch.title !== undefined) changed.push('title');
   if (patch.descriptionSet) changed.push('description');
   if (patch.status !== undefined && patch.status !== currentStatus) {
      changed.push('status');
      previousStatus = currentStatus;
   }
   if (patch.priority !== undefined) changed.push('priority');
   if (patch.sortOrder !== undefined) changed.push('sortOrder');
   if (patch.dueDateSet) changed.push('dueDate');
   if (patch.assigneeSet) changed.push('assignee');
   if (patch.projectSet) changed.push('project');
   return { changed, previousStatus };
}

/** The snapshot carried in an event, mirroring the public issue shape. */
function serializeIssueEvent(issue: Issue): Record<string, unknown> {
   return {
      id: issue.id,
      boardId: issue.boardId,
      number: issue.number,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      status: issue.status,
      priority: issue.priority,
      sortOrder: issue.sortOrder,
      dueDate: issue.dueDate,
      assignee: issue.assignee,
      activeRunId: issue.activeRunId,
      project: issue.project,
      createdBy: issue.createdBy,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
   };
}

/**
 * A constraint violation is a domain outcome, not a server fault.
 *
 * 23001 is Berry's approval gate refusing the write from a trigger, which is
 * the only way that boundary can be enforced against every writer at once.
 */
function classifyWrite(error: unknown): never {
   const code = (error as { code?: string })?.code;
   if (code === '23503') throw new NotFound();
   if (code === '23505' || code === '23P01') throw new Conflict();
   if (code === '23001') throw new ApprovalRequired();
   throw error;
}
