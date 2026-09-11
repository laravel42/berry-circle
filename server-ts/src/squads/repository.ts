import { randomUUID } from 'node:crypto';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { Conflict, NotFound } from '../identity/errors.ts';

/**
 * Squads: agents and people under one leader agent.
 *
 * An issue given to a squad is assigned to its leader; the roster is what the
 * leader is briefed with, and what it may delegate to. A squad also carries
 * standing instructions — the brief every member's work follows — and an
 * avatar, so it is recognisable in a list beside agents and people.
 */

export interface SquadMember {
   type: 'agent' | 'user';
   id: string;
   name: string;
   role: string;
   /** An agent's own status; `'person'` for a member who is one. */
   status: string;
   /** Tasks assigned to this member that are neither done nor cancelled. */
   openIssues: number;
   /** An agent's most recent run. People have none: Berry does not track their presence. */
   lastActiveAt: string | null;
}

export interface Squad {
   id: string;
   name: string;
   description: string;
   instructions: string;
   avatarUrl: string | null;
   leaderAgentId: string;
   members: SquadMember[];
   createdBy: string | null;
   archivedAt: string | null;
   createdAt: string;
   updatedAt: string;
}

export interface SquadInput {
   name: string;
   description: string;
   leaderAgentId: string;
   instructions?: string | undefined;
   avatarUrl?: string | null | undefined;
   /** The roster to start with. Validated in the same transaction as the squad. */
   members?: SquadMemberInput[] | undefined;
}

export interface SquadPatch {
   name?: string | undefined;
   description?: string | undefined;
   leaderAgentId?: string | undefined;
   instructions?: string | undefined;
   avatarUrl?: string | null | undefined;
}

export interface SquadMemberInput {
   type: 'agent' | 'user';
   id: string;
   role: string;
}

/** A roster naming someone who is not of this workspace. Never a 404: the squad was found. */
export class InvalidMember extends Error {}

const MEMBERS = `COALESCE((SELECT json_agg(json_build_object(
               'type', m.member_type,
               'id', m.member_id,
               'name', COALESCE(a.name, u.name, ''),
               'role', m.role,
               'status', CASE WHEN m.member_type = 'agent'
                              THEN COALESCE(a.status, 'unknown') ELSE 'person' END,
               'openIssues', (SELECT count(*) FROM issues oi
                                JOIN boards ob ON ob.id = oi.board_id
                               WHERE ob.workspace_id = s.workspace_id
                                 AND oi.deleted_at IS NULL
                                 AND oi.assignee_type::text = m.member_type
                                 AND oi.assignee_id = m.member_id
                                 AND oi.status::text NOT IN ('done', 'cancelled')),
               'lastActiveAt', (SELECT max(lr.created_at) FROM runs lr
                                 WHERE m.member_type = 'agent'
                                   AND lr.workspace_id = s.workspace_id
                                   AND lr.agent_id = m.member_id))
               ORDER BY m.member_type, m.member_id)
               FROM squad_members m
               LEFT JOIN agents a ON m.member_type = 'agent' AND a.id = m.member_id
               LEFT JOIN users u ON m.member_type = 'user' AND u.id = m.member_id
              WHERE m.squad_id = s.id), '[]'::json) AS members`;

const COLUMNS = `s.id, s.name, s.description, s.instructions, s.avatar_url, s.leader_agent_id,
   s.created_by, s.archived_at, s.created_at, s.updated_at,
   ${MEMBERS}`;

export class SquadRepository {
   readonly #sql: Sql;

   constructor(sql: Sql) {
      this.#sql = sql;
   }

   async list(workspaceId: string): Promise<Squad[]> {
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM squads s
          WHERE s.workspace_id = ${workspaceId} AND s.archived_at IS NULL
          ORDER BY lower(s.name), s.id`;
      return rows.map(toSquad);
   }

   async get(workspaceId: string, id: string): Promise<Squad> {
      const [row] = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM squads s
          WHERE s.id = ${id} AND s.workspace_id = ${workspaceId}`;
      if (!row) throw new NotFound();
      return toSquad(row);
   }

   async create(workspaceId: string, input: SquadInput, userId: string): Promise<Squad> {
      const id = randomUUID();
      await this.#sql
         .begin(async (transaction) => {
            const tx = transaction as unknown as Sql;
            await tx`
               INSERT INTO squads (id, workspace_id, name, description, instructions, avatar_url,
                                   leader_agent_id, created_by)
               VALUES (${id}, ${workspaceId}, ${input.name}, ${input.description},
                       ${input.instructions ?? ''}, ${input.avatarUrl ?? null},
                       ${input.leaderAgentId}, ${userId})`;
            // The roster is written here rather than in a second request, so a
            // member who is not of this workspace leaves no half-made squad.
            if (input.members && input.members.length > 0) {
               if (!(await writeMembers(tx, workspaceId, id, input.members))) {
                  throw new InvalidMember();
               }
            }
         })
         .catch(classify);
      return this.get(workspaceId, id);
   }

   async update(workspaceId: string, id: string, patch: SquadPatch): Promise<Squad> {
      const updated = await this.#sql`
         UPDATE squads SET name = COALESCE(${patch.name ?? null}, name),
                description = COALESCE(${patch.description ?? null}, description),
                instructions = COALESCE(${patch.instructions ?? null}, instructions),
                avatar_url = CASE WHEN ${patch.avatarUrl !== undefined}::boolean
                                  THEN ${patch.avatarUrl ?? null} ELSE avatar_url END,
                leader_agent_id = COALESCE(${patch.leaderAgentId ?? null}::uuid, leader_agent_id),
                updated_at = now()
          WHERE id = ${id} AND workspace_id = ${workspaceId} AND archived_at IS NULL`.catch(classify);
      if (updated.count !== 1) throw new NotFound();
      return this.get(workspaceId, id);
   }

   async archive(workspaceId: string, id: string): Promise<void> {
      const updated = await this.#sql`
         UPDATE squads SET archived_at = now(), updated_at = now()
          WHERE id = ${id} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
      if (updated.count !== 1) throw new NotFound();
   }

   /** Replaces the roster. Returns false when a member is not in this workspace. */
   async setMembers(workspaceId: string, id: string, members: SquadMemberInput[]): Promise<boolean> {
      return (await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [squad] = await tx`
            SELECT 1 FROM squads WHERE id = ${id} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
         if (!squad) throw new NotFound();
         await tx`DELETE FROM squad_members WHERE squad_id = ${id}`;
         return writeMembers(tx, workspaceId, id, members);
      })) as boolean;
   }

   async recordAssignment(workspaceId: string, squadId: string, issueId: string, userId: string): Promise<void> {
      await this.#sql`
         INSERT INTO issue_squads (issue_id, squad_id, workspace_id, assigned_by)
         VALUES (${issueId}, ${squadId}, ${workspaceId}, ${userId})
         ON CONFLICT (issue_id) DO UPDATE
            SET squad_id = EXCLUDED.squad_id, workspace_id = EXCLUDED.workspace_id,
                assigned_by = EXCLUDED.assigned_by, assigned_at = now()`;
   }

   async squadForIssue(issueId: string): Promise<Squad | null> {
      const [row] = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM squads s
           JOIN issue_squads i ON i.squad_id = s.id
          WHERE i.issue_id = ${issueId} AND s.archived_at IS NULL`;
      return row ? toSquad(row) : null;
   }
}

/**
 * Writes a roster, having confirmed every member belongs to this workspace.
 * Returns false — rather than throwing — so both callers can answer with the
 * validation error the API already speaks.
 */
async function writeMembers(
   tx: Sql,
   workspaceId: string,
   squadId: string,
   members: SquadMemberInput[]
): Promise<boolean> {
   for (const member of members) {
      const [ok] =
         member.type === 'agent'
            ? await tx`
                 SELECT 1 FROM agents
                  WHERE id = ${member.id} AND workspace_id = ${workspaceId} AND archived_at IS NULL`
            : await tx`
                 SELECT 1 FROM workspace_memberships
                  WHERE user_id = ${member.id} AND workspace_id = ${workspaceId}`;
      if (!ok) return false;
   }
   for (const member of members) {
      await tx`
         INSERT INTO squad_members (squad_id, workspace_id, member_type, member_id, role)
         VALUES (${squadId}, ${workspaceId}, ${member.type}, ${member.id}, ${member.role})
         ON CONFLICT DO NOTHING`;
   }
   return true;
}

function toMember(raw: Record<string, unknown>): SquadMember {
   return {
      type: raw.type as 'agent' | 'user',
      id: raw.id as string,
      name: (raw.name as string | null) ?? '',
      role: raw.role as string,
      status: (raw.status as string | null) ?? 'unknown',
      openIssues: Number(raw.openIssues ?? 0),
      lastActiveAt: toRFC3339((raw.lastActiveAt as string | null) ?? null),
   };
}

function toSquad(row: Record<string, unknown>): Squad {
   return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      instructions: (row.instructions as string | null) ?? '',
      avatarUrl: (row.avatar_url as string | null) ?? null,
      leaderAgentId: row.leader_agent_id as string,
      members: ((row.members as Record<string, unknown>[] | null) ?? []).map(toMember),
      createdBy: (row.created_by as string | null) ?? null,
      archivedAt: toRFC3339(row.archived_at as string | null),
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

function classify(error: unknown): never {
   if (error instanceof InvalidMember || error instanceof NotFound) throw error;
   const code = (error as { code?: string }).code;
   if (code === '23505') throw new Conflict();
   if (code === '23503') throw new NotFound();
   throw error;
}
