import type { Sql } from '../../db/pool.ts';
import { generateToken, hashToken } from '../../auth/tokens.ts';

/**
 * The credential a runtime calls Berry back with, for one run only.
 *
 * Stored as a SHA-256 like every other Berry token. Valid while the run is
 * queued or running and before its expiry; revoked on the run's terminal
 * state. The expiry is the runtime's own `maxLifetime` horizon: a run cannot
 * outlive its microVM, so neither can its token.
 */
export const TASK_TOKEN_PREFIX = 'berry_task_';

export type TaskScope = 'task:read' | 'task:write';

export interface TaskClaims {
   tokenId: string;
   runId: string;
   workspaceId: string;
   agentId: string;
   issueId: string | null;
   boardId: string | null;
   scopes: TaskScope[];
}

export async function mintTaskToken(
   sql: Sql,
   input: { runId: string; workspaceId: string; agentId: string; scopes: TaskScope[]; ttlSeconds: number }
): Promise<string> {
   const token = `${TASK_TOKEN_PREFIX}${generateToken()}`;
   await sql`
      INSERT INTO task_tokens (workspace_id, run_id, agent_id, token_hash, scopes, expires_at)
      VALUES (${input.workspaceId}, ${input.runId}, ${input.agentId}, ${hashToken(token)},
              ${input.scopes}, now() + ${`${input.ttlSeconds} seconds`}::interval)`;
   return token;
}

export async function resolveTaskToken(sql: Sql, token: string): Promise<TaskClaims | null> {
   if (!token.startsWith(TASK_TOKEN_PREFIX)) return null;
   const [row] = await sql`
      SELECT t.id, t.run_id, t.workspace_id, t.agent_id, t.scopes, r.issue_id, r.board_id
        FROM task_tokens AS t
        JOIN runs AS r ON r.id = t.run_id
       WHERE t.token_hash = ${hashToken(token)}
         AND t.revoked_at IS NULL
         AND t.expires_at > now()
         AND r.status IN ('queued', 'running')`;
   if (!row) return null;
   return {
      tokenId: row.id as string,
      runId: row.run_id as string,
      workspaceId: row.workspace_id as string,
      agentId: row.agent_id as string,
      issueId: (row.issue_id as string | null) ?? null,
      boardId: (row.board_id as string | null) ?? null,
      scopes: (row.scopes as string[]).filter(
         (scope): scope is TaskScope => scope === 'task:read' || scope === 'task:write'
      ),
   };
}

export async function revokeTaskTokens(sql: Sql, runId: string): Promise<void> {
   await sql`UPDATE task_tokens SET revoked_at = now() WHERE run_id = ${runId} AND revoked_at IS NULL`;
}
