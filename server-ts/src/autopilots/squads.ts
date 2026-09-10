import type { Sql } from '../db/pool.ts';

/**
 * Who runs an autopilot assigned to a squad: its leading agent.
 *
 * Squads are workstream D's table (migration 088, `leader_agent_id NOT NULL`).
 * This reads it only if it is there, so a server without D's migration — or a
 * squad since archived — answers null, and the firing records
 * SQUAD_UNAVAILABLE rather than failing the whole request.
 */
export async function resolveSquadLeader(
   sql: Sql,
   workspaceId: string,
   squadId: string
): Promise<string | null> {
   const [column] = await sql`
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'squads' AND column_name = 'leader_agent_id'`;
   if (!column) return null;
   const [row] = await sql`
      SELECT leader_agent_id FROM squads
       WHERE id = ${squadId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
   return (row?.leader_agent_id as string | null | undefined) ?? null;
}
