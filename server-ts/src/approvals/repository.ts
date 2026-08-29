import { randomUUID } from 'node:crypto';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import type { Role } from '../identity/roles.ts';

/**
 * The human decisions that gate work.
 *
 * An approval is the product's one hard stop: a task that needs one does not
 * start, and the database enforces that rather than the application — a
 * trigger on `issues` refuses the move to `todo` while a gate on it is
 * unresolved. So resolving the gate is the *only* path that releases a task,
 * and this repository is where that path lives.
 *
 * Kinds are stored snake_case and answered camelCase. That is not a style
 * choice: the trigger reads `issue_start` from SQL and the contract says
 * `issueStart` on the wire, and translating in one place is what keeps them
 * from drifting apart.
 */

export type ApprovalKind = 'plan' | 'issueStart' | 'integrationAction';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ApprovalRisk = 'low' | 'medium' | 'high';

export interface Approval {
   id: string;
   workspaceId: string;
   kind: string;
   risk: ApprovalRisk;
   title: string;
   description: string | null;
   goalId: string | null;
   planId: string | null;
   issueId: string | null;
   issue: { id: string; identifier: string; title: string } | null;
   requestedFrom: { userId: string | null; role: string | null };
   requestedBy: { type: string; id: string } | null;
   status: ApprovalStatus;
   decisionNote: string | null;
   resolvedBy: string | null;
   requestedAt: string;
   expiresAt: string | null;
   resolvedAt: string | null;
}

/**
 * `{createdAt, id}` — the shared time cursor, whose `createdAt` here is the
 * request time. Named for the encoder rather than for the column, because
 * every cursor in the API shares one encoding and a bespoke field name would
 * be a second one.
 */
export interface ApprovalCursor {
   createdAt: string;
   id: string;
}

export interface ApprovalFilter {
   status?: string | undefined;
   kind?: string | undefined;
   goalId?: string | undefined;
   issueId?: string | undefined;
   /** Only the pending gates this caller could actually resolve. */
   mine?: { userId: string; role: Role } | undefined;
}

export class ApprovalResolved extends Error {
   override readonly name = 'ApprovalResolved';
   constructor() {
      super('this approval has already been decided');
   }
}

export class NotAddressee extends Error {
   override readonly name = 'NotAddressee';
   readonly reason: 'not_addressee' | 'admin_required';
   constructor(reason: 'not_addressee' | 'admin_required') {
      super(
         reason === 'admin_required'
            ? 'a high-risk approval needs an admin'
            : 'this approval is addressed to someone else'
      );
      this.reason = reason;
   }
}

export class GateExists extends Error {
   override readonly name = 'GateExists';
   readonly approvalId: string;
   constructor(approvalId: string) {
      super('this task already has a gate waiting on it');
      this.approvalId = approvalId;
   }
}

/**
 * Who outranks whom, for "or anyone holding the addressed role or a stronger
 * one".
 *
 * Deliberately not the permission matrix next door, which is explicit sets
 * precisely so that an admin cannot inherit an owner's `owners.manage`. This
 * is a different question — seniority — and answering it from the matrix
 * would either be wrong or would drag that boundary into a comparison that
 * has nothing to do with it.
 */
const SENIORITY: Record<string, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };

const COLUMNS = `approval.id, approval.workspace_id, approval.kind, approval.risk,
   approval.title, approval.description, approval.goal_id, approval.plan_id,
   approval.issue_id, approval.requested_from_user_id, approval.requested_from_role,
   approval.requested_by_type, approval.requested_by, approval.status,
   approval.decision_note, approval.resolved_by, approval.requested_at,
   approval.expires_at, approval.resolved_at,
   issue.title AS issue_title,
   berry_issue_identifier(board.workspace_id, issue.number) AS issue_identifier`;

const SOURCE = `FROM approvals AS approval
   LEFT JOIN issues AS issue ON issue.id = approval.issue_id AND issue.deleted_at IS NULL
   LEFT JOIN boards AS board ON board.id = issue.board_id`;

export class ApprovalRepository {
   readonly #sql: Sql;
   readonly #newId: () => string;
   readonly #clock: () => Date;

   constructor(sql: Sql, options: { newId?: () => string; clock?: () => Date } = {}) {
      this.#sql = sql;
      this.#newId = options.newId ?? randomUUID;
      this.#clock = options.clock ?? (() => new Date());
   }

   async get(approvalId: string): Promise<Approval> {
      const [row] = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} ${this.#sql.unsafe(SOURCE)}
          WHERE approval.id = ${approvalId}`;
      if (!row) throw new NotFound();
      return toApproval(row);
   }

   /**
    * A workspace's approvals, newest request first.
    *
    * `mine` is the interesting filter: it means "the ones I could decide", not
    * "the ones addressed to me by name". A gate addressed to admins is every
    * admin's to answer, and an inbox that only showed personally-addressed
    * ones would leave role-addressed gates waiting forever.
    */
   async list(
      workspaceId: string,
      filter: ApprovalFilter,
      after: ApprovalCursor | null,
      limit: number
   ): Promise<Approval[]> {
      const mine = filter.mine ?? null;
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} ${this.#sql.unsafe(SOURCE)}
          WHERE approval.workspace_id = ${workspaceId}
            AND (${filter.status == null} OR approval.status = ${filter.status ?? null})
            AND (${filter.kind == null} OR approval.kind = ${filter.kind ?? null})
            AND (${filter.goalId == null} OR approval.goal_id = ${filter.goalId ?? null}::uuid)
            AND (${filter.issueId == null} OR approval.issue_id = ${filter.issueId ?? null}::uuid)
            AND (${mine === null} OR (
                  approval.status = 'pending'
                  AND (approval.requested_from_user_id = ${mine?.userId ?? null}::uuid
                       OR (approval.requested_from_user_id IS NULL
                           AND ${seniorityOf(mine?.role)} >=
                               COALESCE(
                                  CASE approval.requested_from_role
                                     WHEN 'owner' THEN 3 WHEN 'admin' THEN 2
                                     WHEN 'member' THEN 1 WHEN 'viewer' THEN 0
                                  END, 2)))
                  AND (approval.risk <> 'high' OR ${seniorityOf(mine?.role)} >= 2)))
            AND (${after === null} OR (approval.requested_at, approval.id) <
                 (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY approval.requested_at DESC, approval.id DESC
          LIMIT ${limit}`;
      return rows.map(toApproval);
   }

   /**
    * Opens a gate on a task.
    *
    * One pending gate per task: a second would mean a task that needs two
    * yeses, and nothing in the product can express which. The check and the
    * insert are one transaction with the issue locked, so two requests cannot
    * both find none.
    */
   async open(input: {
      workspaceId: string;
      issueId: string;
      title: string;
      description: string | null;
      risk: ApprovalRisk;
      requestedFromUserId: string | null;
      requestedFromRole: string | null;
      requestedBy: string;
      expiresAt: string | null;
   }): Promise<Approval> {
      const id = this.#newId();
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [issue] = await tx`SELECT id FROM issues WHERE id = ${input.issueId} FOR UPDATE`;
         if (!issue) throw new NotFound();

         const [pending] = await tx`
            SELECT id FROM approvals
             WHERE issue_id = ${input.issueId} AND status = 'pending'
             LIMIT 1`;
         if (pending) throw new GateExists(pending.id as string);

         await tx`
            INSERT INTO approvals
               (id, workspace_id, kind, risk, title, description, issue_id,
                requested_from_user_id, requested_from_role, requested_by_type,
                requested_by, status)
            VALUES (${id}, ${input.workspaceId}, 'issue_start', ${input.risk}, ${input.title},
                    ${input.description}, ${input.issueId},
                    ${input.requestedFromUserId},
                    -- Addressed to admins when nobody was named: a gate with
                    -- no addressee is one nobody is responsible for.
                    ${input.requestedFromUserId ? null : (input.requestedFromRole ?? 'admin')},
                    'user', ${input.requestedBy}, 'pending')`;
         if (input.expiresAt) {
            await tx`UPDATE approvals SET expires_at = ${input.expiresAt} WHERE id = ${id}`;
         }

         // The task waits where it can be seen rather than in `todo`, which
         // the trigger would refuse anyway.
         await tx`
            UPDATE issues SET status = 'backlog', updated_at = now()
             WHERE id = ${input.issueId} AND status IN ('todo', 'backlog')`;

         const [row] = await tx`
            SELECT ${tx.unsafe(COLUMNS)} ${tx.unsafe(SOURCE)} WHERE approval.id = ${id}`;
         return toApproval(row!);
      }) as Promise<Approval>;
   }

   /**
    * Decides a gate, and releases what it was holding.
    *
    * The release is in the same transaction as the decision. Splitting them
    * would leave a window where the approval says approved and the task is
    * still held — and the task is what the person was actually approving.
    *
    * Where the task goes is not always `todo`: a task whose blockers are
    * still open goes to `blocked`, because saying it is ready to start when
    * it cannot start is a lie the board would show.
    */
   async resolve(input: {
      approvalId: string;
      decision: 'approved' | 'rejected';
      userId: string;
      role: Role;
      note: string | null;
   }): Promise<Approval> {
      const now = this.#clock().toISOString();
      return this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [current] = await tx`
            SELECT id, issue_id, status, risk, requested_from_user_id, requested_from_role
              FROM approvals WHERE id = ${input.approvalId} FOR UPDATE`;
         if (!current) throw new NotFound();
         if (current.status !== 'pending') throw new ApprovalResolved();

         assertMayResolve(current, input);

         await tx`
            UPDATE approvals
               SET status = ${input.decision}, decision_note = ${input.note},
                   resolved_by = ${input.userId}, resolved_at = ${now}, updated_at = ${now}
             WHERE id = ${input.approvalId}`;

         const issueId = current.issue_id as string | null;
         if (issueId && input.decision === 'approved') {
            const [blocked] = await tx`
               SELECT count(*)::int AS n
                 FROM issue_dependencies AS edge
                 JOIN issues AS blocker ON blocker.id = edge.depends_on_issue_id
                WHERE edge.issue_id = ${issueId}
                  AND blocker.deleted_at IS NULL
                  AND blocker.status NOT IN ('done', 'cancelled')`;
            await tx`
               UPDATE issues
                  SET status = ${Number(blocked!.n) > 0 ? 'blocked' : 'todo'}, updated_at = ${now}
                WHERE id = ${issueId} AND status = 'backlog'`;
         }

         const [row] = await tx`
            SELECT ${tx.unsafe(COLUMNS)} ${tx.unsafe(SOURCE)} WHERE approval.id = ${input.approvalId}`;
         return toApproval(row!);
      }) as Promise<Approval>;
   }
}

/**
 * Whether this caller may decide this gate.
 *
 * Two rules, and the order matters: being the named addressee does not lift
 * the high-risk requirement, because that rule is about what the decision
 * costs rather than about whose decision it is.
 */
function assertMayResolve(
   row: Record<string, unknown>,
   caller: { userId: string; role: Role }
): void {
   if (row.risk === 'high' && seniorityOf(caller.role) < 2) {
      throw new NotAddressee('admin_required');
   }
   const addressee = row.requested_from_user_id as string | null;
   if (addressee) {
      if (addressee !== caller.userId) throw new NotAddressee('not_addressee');
      return;
   }
   const role = (row.requested_from_role as string | null) ?? 'admin';
   if (seniorityOf(caller.role) < seniorityOf(role)) throw new NotAddressee('not_addressee');
}

function seniorityOf(role: string | undefined | null): number {
   return SENIORITY[role ?? 'member'] ?? 0;
}

/** `issue_start` in the column, `issueStart` on the wire. */
export function toWireKind(kind: string): string {
   return kind.replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase());
}

export function toColumnKind(kind: string): string {
   return kind.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function toApproval(row: Record<string, unknown>): Approval {
   const issueId = (row.issue_id as string | null) ?? null;
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      kind: toWireKind(row.kind as string),
      risk: row.risk as ApprovalRisk,
      title: row.title as string,
      description: (row.description as string | null) ?? null,
      goalId: (row.goal_id as string | null) ?? null,
      planId: (row.plan_id as string | null) ?? null,
      issueId,
      // Present only when the issue is still there: a deleted task's gate
      // keeps its id and loses its summary rather than inventing one.
      issue:
         issueId && row.issue_identifier
            ? {
                 id: issueId,
                 identifier: row.issue_identifier as string,
                 title: row.issue_title as string,
              }
            : null,
      requestedFrom: {
         userId: (row.requested_from_user_id as string | null) ?? null,
         role: (row.requested_from_role as string | null) ?? null,
      },
      requestedBy: row.requested_by
         ? { type: row.requested_by_type as string, id: row.requested_by as string }
         : null,
      status: row.status as ApprovalStatus,
      decisionNote: (row.decision_note as string | null) ?? null,
      resolvedBy: (row.resolved_by as string | null) ?? null,
      requestedAt: toRFC3339(row.requested_at as string)!,
      expiresAt: toRFC3339(row.expires_at as string | null),
      resolvedAt: toRFC3339(row.resolved_at as string | null),
   };
}
