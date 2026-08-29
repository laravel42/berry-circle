import { randomUUID } from 'node:crypto';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { Conflict, Forbidden, NotFound } from '../identity/errors.ts';
import { allows, type Permission } from '../identity/roles.ts';
import type { Scope } from './boards.ts';
import { dbStatusToApi } from './issues.ts';
import type { ActorRef } from './comments.ts';

/**
 * Goals.
 *
 * A goal is the thing work is *for*: issues link to it, plans propose
 * against it, approvals decide about it. Almost everything here is either the
 * lifecycle — which statuses may follow which — or a count over what points at
 * the goal, and neither belongs to any one of those domains.
 */

export type GoalStatus = 'draft' | 'planned' | 'active' | 'blocked' | 'completed' | 'cancelled';

const STATUSES: readonly GoalStatus[] = [
   'draft', 'planned', 'active', 'blocked', 'completed', 'cancelled',
];

/**
 * draft → planned → active ⇄ blocked → completed | cancelled.
 *
 * Terminal goals never move again, which is why `completed` and `cancelled`
 * name no successors: a goal that was cancelled and then reopened would leave
 * every count and every event describing it as finished wrong.
 */
const TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
   draft: ['planned', 'active', 'cancelled'],
   planned: ['active', 'cancelled'],
   active: ['blocked', 'completed', 'cancelled'],
   blocked: ['active', 'completed', 'cancelled'],
   completed: [],
   cancelled: [],
};

export function isGoalStatus(value: string): value is GoalStatus {
   return (STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: GoalStatus, to: GoalStatus): boolean {
   return TRANSITIONS[from].includes(to);
}

export interface Goal {
   id: string;
   workspaceId: string;
   projectId: string | null;
   title: string;
   description: string | null;
   status: GoalStatus;
   source: string;
   sourcePrompt: string | null;
   createdBy: string | null;
   createdAt: string;
   updatedAt: string;
   startedAt: string | null;
   completedAt: string | null;
}

/** What the goal's work adds up to. */
export interface Progress {
   issuesTotal: number;
   issuesDone: number;
   issuesCancelled: number;
   approvalsPending: number;
}

export interface GoalCursor {
   updatedAt: string;
   id: string;
}

export interface GoalEvent {
   id: string;
   type: string;
   workspaceId: string;
   payload: string;
   occurredAt: Date;
}

export interface LinkedIssue {
   id: string;
   identifier: string;
   title: string;
   status: string;
   linkedAt: string;
}

/** A move the lifecycle does not allow, naming both ends. */
export class InvalidTransition extends Error {
   readonly from: GoalStatus;
   readonly to: GoalStatus;

   constructor(from: GoalStatus, to: GoalStatus) {
      super(`goal cannot move from ${from} to ${to}`);
      this.name = 'InvalidTransition';
      this.from = from;
      this.to = to;
   }
}

export interface GoalPatch {
   title?: string;
   description?: string | null;
   descriptionSet?: boolean;
   projectId?: string | null;
   projectSet?: boolean;
}

const GOAL_COLUMNS = `
   goal.id, goal.workspace_id, goal.project_id, goal.title, goal.description,
   goal.status, goal.source, goal.source_prompt, goal.created_by,
   goal.created_at, goal.updated_at, goal.started_at, goal.completed_at`;

export class GoalRepository {
   private readonly sql: Sql;
   private readonly newId: () => string;

   constructor(sql: Sql, newId: () => string = randomUUID) {
      this.sql = sql;
      this.newId = newId;
   }

   async authorizeWorkspace(
      userId: string,
      workspaceId: string,
      permission: Permission
   ): Promise<Scope> {
      const [row] = await this.sql`
         SELECT membership.role::text AS role
           FROM workspace_memberships AS membership
           JOIN workspaces AS workspace
             ON workspace.id = membership.workspace_id AND workspace.deleted_at IS NULL
          WHERE membership.workspace_id = ${workspaceId} AND membership.user_id = ${userId}`;
      if (!row) throw new NotFound();
      const scope = { workspaceId, role: row.role as string };
      if (!allows(scope.role, permission)) throw new Forbidden();
      return scope;
   }

   /** Membership reached through the goal, so a caller cannot name a workspace. */
   async authorize(userId: string, goalId: string, permission: Permission): Promise<Scope> {
      const [row] = await this.sql`
         SELECT workspace_id FROM goals WHERE id = ${goalId} AND deleted_at IS NULL`;
      if (!row) throw new NotFound();
      return this.authorizeWorkspace(userId, row.workspace_id as string, permission);
   }

   /**
    * The people named as authors, resolved in one query.
    *
    * A list of twenty goals would otherwise be twenty lookups, and the answer
    * for most of them is the same handful of users.
    */
   async lookupAuthors(userIds: string[]): Promise<Map<string, ActorRef>> {
      const wanted = [...new Set(userIds.filter(Boolean))];
      if (wanted.length === 0) return new Map();
      const rows = await this.sql`
         SELECT id, name, avatar_url FROM users WHERE id = ANY(${wanted}::uuid[])`;
      return new Map(
         rows.map((row) => [
            row.id as string,
            {
               type: 'user',
               id: row.id as string,
               name: row.name as string,
               avatarUrl: (row.avatar_url as string | null) ?? null,
            } as ActorRef,
         ])
      );
   }

   async get(goalId: string): Promise<Goal> {
      const [row] = await this.sql`
         SELECT ${this.sql.unsafe(GOAL_COLUMNS)}
           FROM goals AS goal WHERE goal.id = ${goalId} AND goal.deleted_at IS NULL`;
      if (!row) throw new NotFound();
      return toGoal(row);
   }

   /** One page, most recently updated first. */
   async list(
      workspaceId: string,
      filter: { query: string; status: GoalStatus | null; projectId: string | null },
      after: GoalCursor | null,
      limit: number
   ): Promise<Goal[]> {
      const rows = await this.sql`
         SELECT ${this.sql.unsafe(GOAL_COLUMNS)}
           FROM goals AS goal
          WHERE goal.workspace_id = ${workspaceId}
            AND goal.deleted_at IS NULL
            AND (${filter.status ?? ''} = '' OR goal.status = ${filter.status ?? ''})
            AND (${filter.projectId === null} OR goal.project_id = ${filter.projectId}::uuid)
            AND (${filter.query} = '' OR goal.title ILIKE '%' || ${filter.query} || '%')
            AND (${after === null} OR (goal.updated_at, goal.id) < (${after?.updatedAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY goal.updated_at DESC, goal.id DESC
          LIMIT ${limit}`;
      return rows.map(toGoal);
   }

   async create(params: {
      workspaceId: string;
      title: string;
      description?: string | null;
      projectId?: string | null;
      createdBy: string;
      createdAt: string;
   }): Promise<{ goal: Goal; event: GoalEvent }> {
      const id = this.newId();
      return this.sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [row] = await tx`
            INSERT INTO goals AS goal (
               id, workspace_id, project_id, title, description, status, source,
               source_prompt, created_by, created_at, updated_at, started_at
            ) VALUES (
               ${id}, ${params.workspaceId}, ${params.projectId ?? null}, ${params.title},
               ${params.description ?? null}, 'draft', 'manual', NULL, ${params.createdBy},
               ${params.createdAt}, ${params.createdAt}, NULL
            )
            RETURNING ${tx.unsafe(GOAL_COLUMNS)}`.catch(classifyWrite);
         const goal = toGoal(row!);
         const event = await this.writeEvent(tx, 'goal.created', goal, [], params.createdBy, params.createdAt);
         return { goal, event };
      }) as Promise<{ goal: Goal; event: GoalEvent }>;
   }

   /**
    * Applies a patch under a row lock and names what changed.
    *
    * The event carries the field names rather than the old values: a consumer
    * re-renders the goal it was just given, and the names are what tell it
    * whether it has to.
    */
   async update(
      goalId: string,
      patch: GoalPatch,
      actorId: string,
      now: string
   ): Promise<{ goal: Goal; event: GoalEvent }> {
      return this.sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const current = await lockGoal(tx, goalId);

         const changed: string[] = [];
         if (patch.title !== undefined && patch.title !== current.title) changed.push('title');
         if (patch.descriptionSet) changed.push('description');
         if (patch.projectSet) changed.push('project');

         const [row] = await tx`
            UPDATE goals AS goal SET
               title = COALESCE(${patch.title ?? null}, goal.title),
               description = CASE WHEN ${patch.descriptionSet === true}
                  THEN ${patch.description ?? null}::text ELSE goal.description END,
               project_id = CASE WHEN ${patch.projectSet === true}
                  THEN ${patch.projectId ?? null}::uuid ELSE goal.project_id END,
               updated_at = ${now}
             WHERE goal.id = ${goalId}
             RETURNING ${tx.unsafe(GOAL_COLUMNS)}`.catch(classifyWrite);
         const goal = toGoal(row!);
         const event = await this.writeEvent(tx, 'goal.updated', goal, changed, actorId, now);
         return { goal, event };
      }) as Promise<{ goal: Goal; event: GoalEvent }>;
   }

   /**
    * Moves a goal along its lifecycle.
    *
    * Asking for the status it is already in is not a conflict — it is the
    * caller and the server agreeing — so it returns the goal with no event
    * rather than refusing.
    */
   async transition(
      goalId: string,
      to: GoalStatus,
      actorId: string | null,
      now: string
   ): Promise<{ goal: Goal; event: GoalEvent | null }> {
      return this.sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const current = await lockGoal(tx, goalId);
         if (current.status === to) return { goal: current, event: null };
         if (!canTransition(current.status, to)) throw new InvalidTransition(current.status, to);

         const [row] = await tx`
            UPDATE goals AS goal SET
               status = ${to},
               started_at = CASE WHEN ${to} IN ('active', 'blocked')
                  THEN COALESCE(goal.started_at, ${now}) ELSE goal.started_at END,
               completed_at = CASE WHEN ${to} = 'completed' THEN ${now}::timestamptz ELSE NULL END,
               updated_at = ${now}
             WHERE goal.id = ${goalId}
             RETURNING ${tx.unsafe(GOAL_COLUMNS)}`.catch(classifyWrite);
         const goal = toGoal(row!);

         // The topic says what happened, not merely that something did: a
         // consumer counting completions cannot get that from goal.updated.
         // `active` is only a start the first time — returning from blocked is
         // not a second beginning.
         let topic = 'goal.updated';
         if (to === 'active' && current.startedAt === null) topic = 'goal.started';
         else if (to === 'completed') topic = 'goal.completed';
         else if (to === 'cancelled') topic = 'goal.cancelled';

         const event = await this.writeEvent(tx, topic, goal, ['status'], actorId, now);
         return { goal, event };
      }) as Promise<{ goal: Goal; event: GoalEvent | null }>;
   }

   /** Archives a goal. Soft, because issues and events still reference it. */
   async archive(goalId: string, actorId: string, now: string): Promise<GoalEvent> {
      return this.sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const goal = await lockGoal(tx, goalId);
         await tx`UPDATE goals SET deleted_at = ${now}, updated_at = ${now} WHERE id = ${goalId}`;
         return this.writeEvent(tx, 'goal.archived', goal, [], actorId, now);
      }) as Promise<GoalEvent>;
   }

   /**
    * Attaches an issue, replacing any earlier goal.
    *
    * An issue belongs to at most one goal — the unique key is on the issue,
    * not on the pair — so linking is an upsert rather than an insert. A
    * trigger refuses an issue from another workspace.
    */
   async linkIssue(params: {
      workspaceId: string;
      goalId: string;
      issueId: string;
      actorId: string;
      now: string;
   }): Promise<void> {
      await this.sql`
         INSERT INTO goal_issues (workspace_id, issue_id, goal_id, linked_by, created_at)
         VALUES (${params.workspaceId}, ${params.issueId}, ${params.goalId}, ${params.actorId}, ${params.now})
         ON CONFLICT (issue_id) DO UPDATE
            SET goal_id = EXCLUDED.goal_id,
                workspace_id = EXCLUDED.workspace_id,
                linked_by = EXCLUDED.linked_by,
                created_at = EXCLUDED.created_at`.catch(classifyWrite);
   }

   async unlinkIssue(goalId: string, issueId: string): Promise<void> {
      const removed = await this.sql`
         DELETE FROM goal_issues WHERE goal_id = ${goalId} AND issue_id = ${issueId}`;
      if (removed.count === 0) throw new NotFound();
   }

   /** The live issues linked to a goal, oldest link first. */
   async listIssues(goalId: string, limit = 500): Promise<LinkedIssue[]> {
      const rows = await this.sql`
         SELECT issue.id, berry_issue_identifier(board.workspace_id, issue.number) AS identifier,
                issue.title, issue.status::text AS status, link.created_at
           FROM goal_issues AS link
           JOIN issues AS issue ON issue.id = link.issue_id AND issue.deleted_at IS NULL
           JOIN boards AS board ON board.id = issue.board_id
          WHERE link.goal_id = ${goalId}
          ORDER BY link.created_at ASC, issue.number ASC, issue.id ASC
          LIMIT ${limit}`;
      return rows.map((row) => ({
         id: row.id as string,
         identifier: row.identifier as string,
         title: row.title as string,
         status: dbStatusToApi(row.status as string),
         linkedAt: toRFC3339(row.created_at as string) ?? '',
      }));
   }

   /**
    * What the goal's work adds up to.
    *
    * One query with five subqueries rather than five round trips, because this
    * is rendered beside every goal read on its own. Approvals count whether
    * they target the goal directly or one of its issues — a decision blocking
    * an issue is blocking the goal.
    */
   async progress(goalId: string): Promise<Progress> {
      const [row] = await this.sql`
         SELECT
            (SELECT count(*) FROM goal_issues AS link
               JOIN issues AS issue ON issue.id = link.issue_id AND issue.deleted_at IS NULL
              WHERE link.goal_id = ${goalId}) AS issues_total,
            (SELECT count(*) FROM goal_issues AS link
               JOIN issues AS issue ON issue.id = link.issue_id AND issue.deleted_at IS NULL
              WHERE link.goal_id = ${goalId} AND issue.status = 'done') AS issues_done,
            (SELECT count(*) FROM goal_issues AS link
               JOIN issues AS issue ON issue.id = link.issue_id AND issue.deleted_at IS NULL
              WHERE link.goal_id = ${goalId} AND issue.status = 'cancelled') AS issues_cancelled,
            (SELECT count(*) FROM approvals AS approval
              WHERE approval.status = 'pending'
                AND (approval.goal_id = ${goalId}
                     OR approval.issue_id IN (SELECT issue_id FROM goal_issues WHERE goal_id = ${goalId}))) AS approvals_pending`;
      return {
         issuesTotal: Number(row!.issues_total),
         issuesDone: Number(row!.issues_done),
         issuesCancelled: Number(row!.issues_cancelled),
         approvalsPending: Number(row!.approvals_pending),
      };
   }

   /**
    * The goal's approvals and plans.
    *
    * Two reads of tables no mount here owns. That is fine because they depend
    * on the tables and not on that code: a goal has to be able to say what
    * points at it without owning any of it.
    */
   async listApprovals(goalId: string, workspaceId: string, limit = 100) {
      const rows = await this.sql`
         SELECT approval.id, approval.kind::text AS kind, approval.risk::text AS risk,
                approval.title, approval.status::text AS status,
                approval.issue_id, approval.requested_at
           FROM approvals AS approval
          WHERE approval.workspace_id = ${workspaceId}
            AND (approval.goal_id = ${goalId}
                 OR approval.issue_id IN (SELECT issue_id FROM goal_issues WHERE goal_id = ${goalId}))
          ORDER BY approval.requested_at DESC, approval.id DESC
          LIMIT ${limit}`;
      return rows.map((row) => ({
         id: row.id as string,
         kind: row.kind as string,
         risk: row.risk as string,
         title: row.title as string,
         status: row.status as string,
         issueId: (row.issue_id as string | null) ?? null,
         requestedAt: toRFC3339(row.requested_at as string) ?? '',
      }));
   }

   async listPlans(goalId: string, limit = 100) {
      const rows = await this.sql`
         SELECT id, status::text AS status, source::text AS source, current_version,
                generation_status::text AS generation_status,
                validation_status::text AS validation_status,
                compile_status::text AS compile_status, created_at
           FROM plans
          WHERE goal_id = ${goalId}
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit}`;
      return rows.map((row) => ({
         id: row.id as string,
         // `pending_approval` is the only status spelled differently on the
         // wire, and it is the one a plan sits in longest.
         status: row.status === 'pending_approval' ? 'pendingApproval' : (row.status as string),
         source: row.source as string,
         version: Number(row.current_version),
         generationStatus: row.generation_status as string,
         validationStatus: row.validation_status as string,
         compileStatus: row.compile_status as string,
         createdAt: toRFC3339(row.created_at as string) ?? '',
      }));
   }

   /**
    * One goal fact, in the collaboration envelope every workspace-scoped event
    * uses: {id, type, occurredAt, workspaceId, aggregateType, aggregateId,
    * payload}.
    */
   private async writeEvent(
      tx: Sql,
      topic: string,
      goal: Goal,
      changed: string[],
      actorId: string | null,
      occurredAt: string
   ): Promise<GoalEvent> {
      const eventId = this.newId();
      const payload = {
         goal: serializeGoal(goal),
         changedFields: changed,
         ...(actorId ? { actor: { type: 'user', id: actorId } } : {}),
      };
      const envelope = {
         id: eventId,
         type: topic,
         occurredAt: toRFC3339(occurredAt),
         workspaceId: goal.workspaceId,
         // A goal belongs to no board, which is what keeps it out of the board
         // replay's partial index and in the workspace stream.
         boardId: null,
         aggregateType: 'goal',
         aggregateId: goal.id,
         payload,
      };
      await tx`
         INSERT INTO outbox_events (
            id, topic, aggregate_type, aggregate_id, workspace_id, board_id,
            payload, occurred_at, available_at
         ) VALUES (
            ${eventId}, ${topic}, 'goal', ${goal.id}, ${goal.workspaceId}, NULL,
            ${tx.json(envelope as never)}, ${occurredAt}, ${occurredAt}
         )`;
      return {
         id: eventId,
         type: topic,
         workspaceId: goal.workspaceId,
         payload: JSON.stringify(payload),
         occurredAt: new Date(occurredAt),
      };
   }
}

async function lockGoal(tx: Sql, goalId: string): Promise<Goal> {
   const [row] = await tx`
      SELECT ${tx.unsafe(GOAL_COLUMNS)}
        FROM goals AS goal WHERE goal.id = ${goalId} AND goal.deleted_at IS NULL
        FOR UPDATE`;
   if (!row) throw new NotFound();
   return toGoal(row);
}

function toGoal(row: Record<string, unknown>): Goal {
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      projectId: (row.project_id as string | null) ?? null,
      title: row.title as string,
      description: (row.description as string | null) ?? null,
      status: row.status as GoalStatus,
      source: row.source as string,
      sourcePrompt: (row.source_prompt as string | null) ?? null,
      createdBy: (row.created_by as string | null) ?? null,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
      startedAt: toRFC3339(row.started_at as string | null),
      completedAt: toRFC3339(row.completed_at as string | null),
   };
}

/** The goal as an event payload carries it: the same fields, no progress. */
export function serializeGoal(goal: Goal): Record<string, unknown> {
   return {
      id: goal.id,
      workspaceId: goal.workspaceId,
      projectId: goal.projectId,
      title: goal.title,
      description: goal.description,
      status: goal.status,
      source: goal.source,
      sourcePrompt: goal.sourcePrompt,
      createdBy: goal.createdBy,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      startedAt: goal.startedAt,
      completedAt: goal.completedAt,
   };
}

function classifyWrite(error: unknown): never {
   const code = (error as { code?: string })?.code;
   if (code === '23503' || code === '23514') throw new NotFound();
   if (code === '23505' || code === '23P01') throw new Conflict();
   throw error;
}
