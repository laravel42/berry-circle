import { createHash } from 'node:crypto';
import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';
import { Conflict, Forbidden, IdempotencyConflict, LastOwner, NotFound } from './errors.ts';
import { allows, type Role } from './roles.ts';
import type { NameCursor, TimeCursor } from '../http/cursor.ts';
import type { Workspace, WorkspaceSettings } from './repository.ts';
import { installStarterLabels } from '../core/starter-labels.ts';

/**
 * Workspaces and memberships.
 *
 * Membership is the security boundary: every query here joins
 * `workspace_memberships`, so a workspace the caller does not belong to is not
 * merely forbidden — it is not visible, and a handler cannot leak one by
 * forgetting a check.
 */

const WORKSPACE_COLUMNS = `w.id, w.name, w.slug, w.description, w.settings,
                           m.role::text AS role, w.created_at, w.updated_at,
                           w.logo_url, w.agent_context`;

const MEMBER_COLUMNS = `m.workspace_id, m.user_id, m.role::text AS role,
                        u.email, u.name, u.avatar_url, m.joined_at, m.updated_at`;

export interface Membership {
   workspaceId: string;
   userId: string;
   role: string;
   email: string;
   name: string;
   avatarUrl: string | null;
   joinedAt: string;
   updatedAt: string;
}

export interface WorkspacePatch {
   name?: string;
   slug?: string;
   descriptionSet: boolean;
   description?: string | null;
   logoUrlSet: boolean;
   logoUrl?: string | null;
   agentContextSet: boolean;
   agentContext?: string | null;
}

export interface WorkspaceSettingsPatch {
   issuePrefix?: string;
   defaultRole?: string;
   allowMemberInvites?: boolean;
}

export class WorkspaceRepository {
   private readonly sql: Sql;
   private readonly clock: () => Date;
   private readonly newId: () => string;

   constructor(sql: Sql, clock: () => Date = () => new Date(), newId = () => crypto.randomUUID()) {
      this.sql = sql;
      this.clock = clock;
      this.newId = newId;
   }

   private now(): string {
      return this.clock().toISOString();
   }

   /** Descending by creation, keyed so a cursor is stable across inserts. */
   async list(userId: string, after: TimeCursor | null, limit: number): Promise<Workspace[]> {
      const rows = await this.sql`
         SELECT ${this.sql.unsafe(WORKSPACE_COLUMNS)}
           FROM workspace_memberships AS m
           JOIN workspaces AS w ON w.id = m.workspace_id
          WHERE m.user_id = ${userId}
            AND w.deleted_at IS NULL
            AND (NOT ${after !== null}::boolean OR
                (w.created_at, w.id) < (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY w.created_at DESC, w.id DESC
          LIMIT ${limit}`;
      return rows.map(toWorkspace);
   }

   async get(workspaceId: string, userId: string): Promise<Workspace> {
      const [row] = await this.sql`
         SELECT ${this.sql.unsafe(WORKSPACE_COLUMNS)}
           FROM workspace_memberships AS m
           JOIN workspaces AS w ON w.id = m.workspace_id
          WHERE w.id = ${workspaceId} AND m.user_id = ${userId} AND w.deleted_at IS NULL`;
      if (!row) throw new NotFound();
      return toWorkspace(row);
   }

   /**
    * Creates a workspace, its owner membership, and the caller's selection.
    *
    * Idempotency is a partial unique index on (created_by, creation_key_hash)
    * rather than a separate claim table: the insert either wins or conflicts,
    * and the conflicting path compares the stored body fingerprint. Replaying
    * the same request returns the same workspace; replaying the key with a
    * different body is a conflict rather than a silent second create.
    */
   async create(params: {
      actorId: string;
      name: string;
      slug: string;
      description: string | null;
      idempotencyKey: string;
      fingerprint: Buffer;
   }): Promise<{ workspace: Workspace; replayed: boolean }> {
      const id = this.newId();
      const now = this.now();
      const keyHash = createHash('sha256').update(params.idempotencyKey).digest();
      const settings: WorkspaceSettings = {
         issuePrefix: prefixFromName(params.name, params.slug),
         defaultRole: 'member',
         allowMemberInvites: false,
      };

      return this.sql.begin(async (tx) => {
         const inserted = await tx`
            INSERT INTO workspaces (
               id, name, slug, description, settings, created_by,
               creation_key_hash, creation_fingerprint, created_at, updated_at
            ) VALUES (
               ${id}, ${params.name}, ${params.slug}, ${params.description},
               ${tx.json(settings)}::jsonb, ${params.actorId},
               ${keyHash}, ${params.fingerprint}, ${now}, ${now}
            )
            ON CONFLICT (created_by, creation_key_hash)
            WHERE created_by IS NOT NULL AND creation_key_hash IS NOT NULL
            DO NOTHING
            RETURNING true AS inserted`.catch(classifyWrite);

         if (inserted.length > 0) {
            await tx`
               INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at)
               VALUES (${id}, ${params.actorId}, 'owner', ${now}, ${now})`.catch(classifyWrite);
            await tx`
               UPDATE users SET last_workspace_id = ${id}, updated_at = ${now}
                WHERE id = ${params.actorId}`;
            // The starter labels, so the first task filed here has something
            // to be labelled with. In the same transaction: a workspace that
            // exists without them is the state a person saw as "no labels".
            await installStarterLabels(tx, id, params.actorId, now);
            return { workspace: await getWorkspaceIn(tx, id, params.actorId), replayed: false };
         }

         const [existing] = await tx`
            SELECT id, creation_fingerprint
              FROM workspaces
             WHERE created_by = ${params.actorId} AND creation_key_hash = ${keyHash}`;
         if (!existing) throw new NotFound();
         // The same key with a different body is a caller bug, not a replay.
         if (!timingSafeEqualBytes(existing.creation_fingerprint as Buffer, params.fingerprint)) {
            throw new IdempotencyConflict();
         }
         return {
            workspace: await getWorkspaceIn(tx, existing.id as string, params.actorId),
            replayed: true,
         };
      });
   }

   /** The caller's role is carried over: the UPDATE does not join memberships. */
   async update(userId: string, workspaceId: string, patch: WorkspacePatch): Promise<Workspace> {
      const current = await this.get(workspaceId, userId);
      if (!allows(current.role, 'workspace.update')) throw new Forbidden();

      const [row] = await this.sql`
         UPDATE workspaces
            SET name = CASE WHEN ${patch.name !== undefined} THEN ${patch.name ?? null}::text ELSE name END,
                slug = CASE WHEN ${patch.slug !== undefined} THEN ${patch.slug ?? null}::text ELSE slug END,
                description = CASE WHEN ${patch.descriptionSet} THEN ${patch.description ?? null}::text ELSE description END,
                logo_url = CASE WHEN ${patch.logoUrlSet} THEN ${patch.logoUrl ?? null}::text ELSE logo_url END,
                agent_context = CASE WHEN ${patch.agentContextSet} THEN ${patch.agentContext ?? null}::text ELSE agent_context END,
                updated_at = ${this.now()}
          WHERE id = ${workspaceId} AND deleted_at IS NULL
          RETURNING id, name, slug, description, settings, created_at, updated_at,
                    logo_url, agent_context`.catch(classifyWrite);
      if (!row) throw new NotFound();
      return toWorkspace({ ...row, role: current.role });
   }

   async remove(userId: string, workspaceId: string): Promise<void> {
      const current = await this.get(workspaceId, userId);
      if (!allows(current.role, 'workspace.delete')) throw new Forbidden();
      const now = this.now();

      await this.sql.begin(async (tx) => {
         const deleted = await tx`
            UPDATE workspaces SET deleted_at = ${now}, updated_at = ${now}
             WHERE id = ${workspaceId} AND deleted_at IS NULL`;
         if (deleted.count !== 1) throw new NotFound();
         // Nobody may be left pointing at a workspace that no longer exists.
         await tx`
            UPDATE users SET last_workspace_id = NULL, updated_at = ${now}
             WHERE last_workspace_id = ${workspaceId}`;
      });
   }

   /** Membership is re-checked in the statement, not trusted from a prior read. */
   async select(userId: string, workspaceId: string): Promise<void> {
      const updated = await this.sql`
         UPDATE users AS u
            SET last_workspace_id = ${workspaceId}, updated_at = ${this.now()}
          WHERE u.id = ${userId}
            AND EXISTS (
                SELECT 1
                  FROM workspace_memberships AS m
                  JOIN workspaces AS w ON w.id = m.workspace_id AND w.deleted_at IS NULL
                 WHERE m.user_id = u.id AND m.workspace_id = ${workspaceId}
            )`;
      if (updated.count !== 1) throw new NotFound();
   }

   async updateSettings(
      userId: string,
      workspaceId: string,
      patch: WorkspaceSettingsPatch
   ): Promise<WorkspaceSettings> {
      const current = await this.get(workspaceId, userId);
      if (!allows(current.role, 'settings.write')) throw new Forbidden();

      const next: WorkspaceSettings = {
         issuePrefix: patch.issuePrefix ?? current.settings.issuePrefix,
         defaultRole: patch.defaultRole ?? current.settings.defaultRole,
         allowMemberInvites: patch.allowMemberInvites ?? current.settings.allowMemberInvites,
      };
      const [row] = await this.sql`
         UPDATE workspaces SET settings = ${this.sql.json(next)}::jsonb, updated_at = ${this.now()}
          WHERE id = ${workspaceId} AND deleted_at IS NULL
          RETURNING settings`;
      if (!row) throw new NotFound();
      return toWorkspaceSettings(row.settings);
   }

   /**
    * Members, ascending by name.
    *
    * Ordered and paged by `lower(u.name)` so the cursor comparison uses the
    * same collation the index does; ordering by `u.name` and paging by the
    * lowered value would skip rows whenever case differs.
    */
   async listMembers(
      userId: string,
      workspaceId: string,
      after: NameCursor | null,
      limit: number
   ): Promise<Membership[]> {
      await this.get(workspaceId, userId); // membership check, and 404 if absent
      const rows = await this.sql`
         SELECT ${this.sql.unsafe(MEMBER_COLUMNS)}
           FROM workspace_memberships AS m
           JOIN users AS u ON u.id = m.user_id
          WHERE m.workspace_id = ${workspaceId}
            AND (NOT ${after !== null}::boolean OR
                (lower(u.name), u.id) > (lower(${after?.name ?? null}::text), ${after?.id ?? null}::uuid))
          ORDER BY lower(u.name) ASC, u.id ASC
          LIMIT ${limit}`;
      return rows.map(toMembership);
   }

   /**
    * The agents that have run most on this member's work.
    *
    * "This member's work" is the tasks they filed or hold, because that is the
    * only link a run has to a person: `runs` records the agent and the task,
    * never who asked. So this answers the question the hover card is really
    * asking — which agents turn up on the things this person is responsible
    * for — rather than pretending to a requester column that does not exist.
    *
    * The membership check runs first, so the caller must be in the workspace
    * and a member of another workspace gets the same 404 as an absent one.
    */
   async topAgentsForMember(
      userId: string,
      workspaceId: string,
      memberId: string,
      limit = 2
   ): Promise<{ agentId: string; name: string; runCount: number }[]> {
      await this.get(workspaceId, userId);
      // 404 rather than an empty list for somebody who is not in here: the
      // absence of a membership is not a fact about their agents.
      const [member] = await this.sql`
         SELECT 1 FROM workspace_memberships
          WHERE workspace_id = ${workspaceId} AND user_id = ${memberId}`;
      if (!member) throw new NotFound();

      const rows = await this.sql`
         SELECT agent.id AS agent_id, agent.name AS name, count(*)::int AS run_count
           FROM runs AS run
           JOIN issues AS issue ON issue.id = run.issue_id
           JOIN agents AS agent ON agent.id = run.agent_id
          WHERE run.workspace_id = ${workspaceId}
            AND agent.workspace_id = ${workspaceId}
            AND (issue.created_by = ${memberId}
                 OR (issue.assignee_type = 'user' AND issue.assignee_id = ${memberId}))
          GROUP BY agent.id, agent.name
          ORDER BY run_count DESC, lower(agent.name), agent.id
          LIMIT ${limit}`;
      return rows.map((row) => ({
         agentId: row.agent_id as string,
         name: row.name as string,
         runCount: Number(row.run_count),
      }));
   }

   /**
    * Changes one member's role under a row lock.
    *
    * The lock is what makes the last-owner rule hold: two concurrent
    * demotions each reading "two owners" would both proceed and leave none.
    * `FOR UPDATE` on the membership rows and again on the owner set serialises
    * them, so the second sees one owner and is refused.
    */
   async updateMemberRole(
      workspaceId: string,
      actorId: string,
      targetId: string,
      next: Role
   ): Promise<Membership> {
      return this.sql.begin(async (tx) => {
         const roles = await lockRoles(tx, workspaceId, actorId, targetId);
         const actorRole = roles.get(actorId);
         const targetRole = roles.get(targetId);
         if (actorRole === undefined || targetRole === undefined) throw new NotFound();
         if (!allows(actorRole, 'members.manage')) throw new Forbidden();
         // Only an owner may touch an owner or admin, or grant either role —
         // otherwise an admin could promote themselves and remove the owner.
         if (
            actorRole !== 'owner' &&
            (targetRole === 'owner' ||
               targetRole === 'admin' ||
               next === 'owner' ||
               next === 'admin')
         ) {
            throw new Forbidden();
         }
         if (targetRole === 'owner' && next !== 'owner' && (await lockOwners(tx, workspaceId)) < 2) {
            throw new LastOwner();
         }

         const [row] = await tx`
            UPDATE workspace_memberships AS m
               SET role = ${next}
              FROM users AS u
             WHERE m.workspace_id = ${workspaceId}
               AND m.user_id = ${targetId}
               AND u.id = m.user_id
            RETURNING ${tx.unsafe(MEMBER_COLUMNS)}`;
         if (!row) throw new NotFound();
         return toMembership(row);
      });
   }

   /**
    * The caller removes their own membership.
    *
    * Separate from {@link removeMember} because it is a different act with a
    * different rule: removing someone else needs `members.manage`, which a
    * plain member does not have — so routing "leave" through that method left
    * most of a workspace unable to leave it. What does carry over is the
    * last-owner rule, under the same lock: a sole owner leaving would abandon
    * a workspace nobody can administer, so they must hand it over or delete it.
    */
   async leave(userId: string, workspaceId: string): Promise<void> {
      await this.sql.begin(async (tx) => {
         const [row] = await tx`
            SELECT m.role::text AS role
              FROM workspace_memberships AS m
              JOIN workspaces AS w ON w.id = m.workspace_id AND w.deleted_at IS NULL
             WHERE m.workspace_id = ${workspaceId} AND m.user_id = ${userId}
             FOR UPDATE OF m`;
         // A non-member and an absent workspace are the same 404, as everywhere.
         if (!row) throw new NotFound();
         if ((row.role as string) === 'owner' && (await lockOwners(tx, workspaceId)) < 2) {
            throw new LastOwner();
         }

         const deleted = await tx`
            DELETE FROM workspace_memberships
             WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`;
         if (deleted.count !== 1) throw new NotFound();
         await tx`
            UPDATE users SET last_workspace_id = NULL
             WHERE id = ${userId} AND last_workspace_id = ${workspaceId}`;
      });
   }

   async removeMember(workspaceId: string, actorId: string, targetId: string): Promise<void> {
      await this.sql.begin(async (tx) => {
         const roles = await lockRoles(tx, workspaceId, actorId, targetId);
         const actorRole = roles.get(actorId);
         const targetRole = roles.get(targetId);
         if (actorRole === undefined || targetRole === undefined) throw new NotFound();
         if (!allows(actorRole, 'members.manage')) throw new Forbidden();
         if (actorRole !== 'owner' && (targetRole === 'owner' || targetRole === 'admin')) {
            throw new Forbidden();
         }
         if (targetRole === 'owner' && (await lockOwners(tx, workspaceId)) < 2) {
            throw new LastOwner();
         }

         const deleted = await tx`
            DELETE FROM workspace_memberships
             WHERE workspace_id = ${workspaceId} AND user_id = ${targetId}`;
         if (deleted.count !== 1) throw new NotFound();
         await tx`
            UPDATE users SET last_workspace_id = NULL
             WHERE id = ${targetId} AND last_workspace_id = ${workspaceId}`;
      });
   }
}

async function getWorkspaceIn(tx: Queryable, workspaceId: string, userId: string): Promise<Workspace> {
   const [row] = await tx`
      SELECT ${tx.unsafe(WORKSPACE_COLUMNS)}
        FROM workspace_memberships AS m
        JOIN workspaces AS w ON w.id = m.workspace_id
       WHERE w.id = ${workspaceId} AND m.user_id = ${userId} AND w.deleted_at IS NULL`;
   if (!row) throw new NotFound();
   return toWorkspace(row);
}

async function lockRoles(
   tx: Queryable,
   workspaceId: string,
   actorId: string,
   targetId: string
): Promise<Map<string, string>> {
   const rows = await tx`
      SELECT user_id, role::text AS role
        FROM workspace_memberships
       WHERE workspace_id = ${workspaceId} AND user_id = ANY(${[actorId, targetId]}::uuid[])
       FOR UPDATE`;
   return new Map(rows.map((row) => [row.user_id as string, row.role as string]));
}

async function lockOwners(tx: Queryable, workspaceId: string): Promise<number> {
   const rows = await tx`
      SELECT user_id
        FROM workspace_memberships
       WHERE workspace_id = ${workspaceId} AND role = 'owner'
       FOR UPDATE`;
   return rows.length;
}

/**
 * A unique-violation is a conflict, not a server error.
 *
 * 23505 is a slug already taken; anything else is genuinely unexpected and
 * keeps its original error so it surfaces as a 500 rather than being
 * mislabelled as the caller's fault.
 */
function classifyWrite(error: unknown): never {
   if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505') {
      throw new Conflict();
   }
   throw error;
}

/** Constant-time comparison; a length difference is reported without leaking where. */
function timingSafeEqualBytes(left: Buffer | null, right: Buffer): boolean {
   if (!left || left.length !== right.length) return false;
   let difference = 0;
   for (let index = 0; index < left.length; index += 1) {
      difference |= left[index]! ^ right[index]!;
   }
   return difference === 0;
}

function toWorkspace(row: Record<string, unknown>): Workspace {
   return {
      id: row.id as string,
      name: row.name as string,
      slug: row.slug as string,
      description: (row.description as string | null) ?? null,
      settings: toWorkspaceSettings(row.settings),
      role: row.role as string,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
      logoUrl: (row.logo_url as string | null) ?? null,
      agentContext: (row.agent_context as string | null) ?? null,
   };
}

function toWorkspaceSettings(value: unknown): WorkspaceSettings {
   const raw = (value ?? {}) as Partial<WorkspaceSettings>;
   return {
      issuePrefix: raw.issuePrefix ?? '',
      defaultRole: raw.defaultRole ?? '',
      allowMemberInvites: raw.allowMemberInvites ?? false,
   };
}

function toMembership(row: Record<string, unknown>): Membership {
   return {
      workspaceId: row.workspace_id as string,
      userId: row.user_id as string,
      role: row.role as string,
      email: row.email as string,
      name: row.name as string,
      avatarUrl: (row.avatar_url as string | null) ?? null,
      joinedAt: toRFC3339(row.joined_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

/**
 * The default issue prefix: up to three alphanumerics from the name, or the
 * slug, or `WS`.
 */
export function prefixFromName(name: string, slug: string): string {
   return prefixFrom(name) ?? prefixFrom(slug) ?? 'WS';
}

function prefixFrom(value: string): string | null {
   const letters = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
   if (letters.length < 2 || letters[0]! < 'A' || letters[0]! > 'Z') return null;
   return letters;
}
