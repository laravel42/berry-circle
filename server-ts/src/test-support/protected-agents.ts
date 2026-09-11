import type { Sql } from '../db/pool.ts';

/**
 * Deletes every agent in the given workspaces, the protected Orchestrator
 * included. Test teardown only; not a test file.
 *
 * A protected agent refuses deletion and unprotection by trigger
 * (berry_agents_block_protected_delete / _unprotect), deliberately. Teardown
 * used to take the guard off with `ALTER TABLE agents DISABLE TRIGGER`, but
 * that is table-wide: test files run in parallel, and one file re-enabling the
 * trigger between another's disable and delete failed unrelated suites with
 * "agent is protected and cannot be deleted" (23001).
 *
 * Instead, one transaction:
 *   1. `SET LOCAL session_replication_role = replica` skips ordinary triggers
 *      for this transaction only, so the flag can be cleared;
 *   2. back to `origin`, so the DELETE runs with every trigger live, and the
 *      foreign-key cascades from agents (which replica mode would also skip)
 *      fire as usual.
 * No other session ever sees an unprotected orchestrator: the clear and the
 * delete commit together. Requires a role allowed to set
 * session_replication_role (the test role is a superuser).
 */
export async function deleteWorkspaceAgents(sql: Sql, workspaceIds: readonly string[]): Promise<void> {
   const ids = workspaceIds.filter((id): id is string => Boolean(id));
   if (ids.length === 0) return;
   await sql.begin(async (transaction) => {
      await deleteWorkspaceAgentsInTransaction(transaction as unknown as Sql, ids);
   });
}

/**
 * The same, for a caller already inside a transaction (`sql.begin`). Must not
 * be given a plain pool: SET LOCAL outside a transaction does nothing, and the
 * DELETE would then meet the guard.
 */
export async function deleteWorkspaceAgentsInTransaction(
   tx: Sql,
   workspaceIds: readonly string[]
): Promise<void> {
   const ids = workspaceIds.filter((id): id is string => Boolean(id));
   if (ids.length === 0) return;
   await tx`SET LOCAL session_replication_role = replica`;
   await tx`UPDATE agents SET protected = false WHERE workspace_id IN ${tx(ids)} AND protected`;
   await tx`SET LOCAL session_replication_role = origin`;
   await tx`DELETE FROM agents WHERE workspace_id IN ${tx(ids)}`;
}
