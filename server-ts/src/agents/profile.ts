import type { Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import type { Sealer } from '../integrations/sealing.ts';
import type { AccessScope } from './access.ts';

/**
 * The parts of an agent's profile that are not its configuration: labels,
 * sealed env, an uploaded avatar, and who may assign or mention it.
 */

export interface AgentAccessSettings {
   assign: AccessScope;
   mention: AccessScope;
   members: string[];
}

const NO_USER = '00000000-0000-0000-0000-000000000000';

export class AgentProfileRepository {
   readonly #sql: Sql;
   readonly #sealer: Sealer;

   constructor(options: { sql: Sql; sealer: Sealer }) {
      this.#sql = options.sql;
      this.#sealer = options.sealer;
   }

   async setLabels(workspaceId: string, agentId: string, labels: string[]): Promise<void> {
      const set = [...new Set(labels.map((label) => label.trim()).filter(Boolean))].sort();
      touch(
         await this.#sql`
            UPDATE agents SET labels = ${set}, updated_at = now()
             WHERE id = ${agentId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`
      );
   }

   async setEnv(workspaceId: string, agentId: string, env: Record<string, string>): Promise<string[]> {
      const names = Object.keys(env).sort();
      // Sealed before the statement, so a missing key fails before anything is written.
      const sealed = names.length === 0 ? null : this.#sealer.seal(JSON.stringify(env));
      touch(
         await this.#sql`
            UPDATE agents SET env_sealed = ${sealed}, env_names = ${names}, updated_at = now()
             WHERE id = ${agentId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`
      );
      return names;
   }

   /** Envelope-only: the one path where env values leave the database opened. */
   async envFor(workspaceId: string, agentId: string): Promise<Record<string, string>> {
      const [row] = await this.#sql`
         SELECT env_sealed FROM agents WHERE id = ${agentId} AND workspace_id = ${workspaceId}`;
      if (!row) throw new NotFound();
      if (!row.env_sealed) return {};
      return JSON.parse(this.#sealer.open(Buffer.from(row.env_sealed as Buffer))) as Record<string, string>;
   }

   async getAccess(workspaceId: string, agentId: string): Promise<AgentAccessSettings> {
      const [row] = await this.#sql`
         SELECT assign_scope, mention_scope,
                COALESCE((SELECT array_agg(user_id::text ORDER BY user_id) FROM agent_access_members
                           WHERE agent_id = ${agentId}), ARRAY[]::text[]) AS members
           FROM agents WHERE id = ${agentId} AND workspace_id = ${workspaceId}`;
      if (!row) throw new NotFound();
      return {
         assign: row.assign_scope as AccessScope,
         mention: row.mention_scope as AccessScope,
         members: row.members as string[],
      };
   }

   /** Members must belong to the workspace; false tells the caller to answer 422. */
   async setAccess(workspaceId: string, agentId: string, access: AgentAccessSettings): Promise<boolean> {
      const members = [...new Set(access.members)];
      return (await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const [count] = await tx`
            SELECT count(*)::int AS n FROM workspace_memberships
             WHERE workspace_id = ${workspaceId}
               AND user_id IN ${tx(members.length > 0 ? members : [NO_USER])}`;
         if (Number(count?.n) !== members.length) return false;
         const updated = await tx`
            UPDATE agents SET assign_scope = ${access.assign}, mention_scope = ${access.mention},
                   updated_at = now()
             WHERE id = ${agentId} AND workspace_id = ${workspaceId}`;
         if (updated.count !== 1) throw new NotFound();
         await tx`DELETE FROM agent_access_members WHERE agent_id = ${agentId}`;
         for (const userId of members) {
            await tx`
               INSERT INTO agent_access_members (agent_id, user_id, workspace_id)
               VALUES (${agentId}, ${userId}, ${workspaceId})`;
         }
         return true;
      })) as boolean;
   }

   async putAvatar(workspaceId: string, agentId: string, contentType: string, bytes: Buffer): Promise<string> {
      const avatarUrl = `/api/v1/agents/${agentId}/avatar?v=${Date.now()}`;
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const updated = await tx`
            UPDATE agents SET avatar_url = ${avatarUrl}, updated_at = now()
             WHERE id = ${agentId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
         if (updated.count !== 1) throw new NotFound();
         await tx`
            INSERT INTO agent_avatars (agent_id, workspace_id, content_type, bytes)
            VALUES (${agentId}, ${workspaceId}, ${contentType}, ${bytes})
            ON CONFLICT (agent_id) DO UPDATE
               SET content_type = EXCLUDED.content_type, bytes = EXCLUDED.bytes, updated_at = now()`;
      });
      return avatarUrl;
   }

   async getAvatar(workspaceId: string, agentId: string): Promise<{ contentType: string; bytes: Buffer }> {
      const [row] = await this.#sql`
         SELECT content_type, bytes FROM agent_avatars
          WHERE agent_id = ${agentId} AND workspace_id = ${workspaceId}`;
      if (!row) throw new NotFound();
      return { contentType: row.content_type as string, bytes: Buffer.from(row.bytes as Buffer) };
   }
}

function touch(result: { count: number }): void {
   if (result.count !== 1) throw new NotFound();
}
