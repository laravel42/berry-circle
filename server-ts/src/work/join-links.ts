import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';

/**
 * Shareable links that add whoever opens them to a workspace, at a fixed role.
 * The token is shown once; only its SHA-256 is stored, as for invitations.
 */
export const JOIN_TOKEN_PREFIX = 'berry_join_';

export const joinLinkCreateSchema = z
   .object({
      role: z.enum(['admin', 'member', 'viewer']).default('member'),
      expiresInDays: z.number().int().min(1).max(365).optional(),
      maxUses: z.number().int().min(1).max(10000).optional(),
   })
   .strict();
export type JoinLinkCreate = z.infer<typeof joinLinkCreateSchema>;

export interface JoinLink {
   id: string;
   workspaceId: string;
   role: string;
   expiresAt: string | null;
   maxUses: number | null;
   useCount: number;
   revokedAt: string | null;
   createdAt: string;
   createdBy: string;
}

export class JoinLinkInvalid extends Error {
   constructor() {
      super('join link is invalid, expired, revoked or used up');
      this.name = 'JoinLinkInvalid';
   }
}

const COLUMNS =
   'id, workspace_id, role::text AS role, expires_at, max_uses, use_count, revoked_at, created_at, created_by';

function toLink(row: Record<string, unknown>): JoinLink {
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      role: row.role as string,
      expiresAt: toRFC3339((row.expires_at as string | null) ?? null),
      maxUses: row.max_uses === null ? null : Number(row.max_uses),
      useCount: Number(row.use_count),
      revokedAt: toRFC3339((row.revoked_at as string | null) ?? null),
      createdAt: toRFC3339(row.created_at as string) ?? '',
      createdBy: row.created_by as string,
   };
}

function hashToken(token: string): Buffer {
   return createHash('sha256').update(token).digest();
}

export async function createJoinLink(
   q: Queryable,
   workspaceId: string,
   actorId: string,
   input: JoinLinkCreate
): Promise<{ link: JoinLink; token: string }> {
   const token = `${JOIN_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
   const [row] = await q`
      INSERT INTO workspace_join_links (workspace_id, role, token_hash, created_by, expires_at, max_uses)
      VALUES (${workspaceId}, ${input.role}::workspace_role, ${hashToken(token)}, ${actorId},
              CASE WHEN ${input.expiresInDays ?? null}::integer IS NULL THEN NULL
                   ELSE now() + make_interval(days => ${input.expiresInDays ?? 0}) END,
              ${input.maxUses ?? null})
      RETURNING ${q.unsafe(COLUMNS)}`;
   if (!row) throw new NotFound();
   return { link: toLink(row), token };
}

export async function listJoinLinks(q: Queryable, workspaceId: string): Promise<JoinLink[]> {
   const rows = await q`
      SELECT ${q.unsafe(COLUMNS)} FROM workspace_join_links
       WHERE workspace_id = ${workspaceId}
       ORDER BY created_at DESC, id DESC LIMIT 200`;
   return rows.map(toLink);
}

export async function revokeJoinLink(q: Queryable, workspaceId: string, linkId: string): Promise<boolean> {
   const rows = await q`
      UPDATE workspace_join_links SET revoked_at = now()
       WHERE id = ${linkId} AND workspace_id = ${workspaceId} AND revoked_at IS NULL
      RETURNING id`;
   return rows.length === 1;
}

const USABLE = `link.revoked_at IS NULL
   AND (link.expires_at IS NULL OR link.expires_at > now())
   AND (link.max_uses IS NULL OR link.use_count < link.max_uses)`;

/** What the public join page shows. Null for any unusable token, alike. */
export async function lookupJoinLink(
   q: Queryable,
   token: string
): Promise<{ workspaceId: string; workspaceName: string; role: string; expiresAt: string | null } | null> {
   if (!token.startsWith(JOIN_TOKEN_PREFIX) || token.length > 128) return null;
   const [row] = await q`
      SELECT link.workspace_id, workspace.name, link.role::text AS role, link.expires_at
        FROM workspace_join_links AS link
        JOIN workspaces AS workspace ON workspace.id = link.workspace_id AND workspace.deleted_at IS NULL
       WHERE link.token_hash = ${hashToken(token)} AND ${q.unsafe(USABLE)}`;
   if (!row) return null;
   return {
      workspaceId: row.workspace_id as string,
      workspaceName: row.name as string,
      role: row.role as string,
      expiresAt: toRFC3339((row.expires_at as string | null) ?? null),
   };
}

/**
 * Joins the caller. An existing member is answered with `joined: false` and the
 * link's use is not counted, so opening a link twice is harmless.
 */
export async function acceptJoinLink(
   sql: Sql,
   token: string,
   userId: string
): Promise<{ workspaceId: string; role: string; joined: boolean }> {
   if (!token.startsWith(JOIN_TOKEN_PREFIX) || token.length > 128) throw new JoinLinkInvalid();
   return sql.begin(async (tx) => {
      const [link] = await tx`
         SELECT link.id, link.workspace_id, link.role::text AS role,
                (${tx.unsafe(USABLE)}) AS usable
           FROM workspace_join_links AS link
           JOIN workspaces AS workspace ON workspace.id = link.workspace_id AND workspace.deleted_at IS NULL
          WHERE link.token_hash = ${hashToken(token)}
          FOR UPDATE OF link`;
      if (!link) throw new JoinLinkInvalid();
      const workspaceId = link.workspace_id as string;
      const [member] = await tx`
         SELECT role::text AS role FROM workspace_memberships
          WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`;
      if (member) return { workspaceId, role: member.role as string, joined: false };
      if (link.usable !== true) throw new JoinLinkInvalid();
      await tx`
         INSERT INTO workspace_memberships (workspace_id, user_id, role)
         VALUES (${workspaceId}, ${userId}, ${link.role as string}::workspace_role)`;
      await tx`UPDATE workspace_join_links SET use_count = use_count + 1 WHERE id = ${link.id as string}`;
      return { workspaceId, role: link.role as string, joined: true };
   });
}
