import { randomUUID } from 'node:crypto';
import { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import type { BerryApp } from '../http/app.ts';

/**
 * The world every agent-layer DB test runs against: workspace W with an owner,
 * a plain member, a board, an issue and an agent; and a second workspace owned
 * by an outsider, with its own agent, for leakage checks. Not a test file.
 */

export interface AgentLayerWorld {
   workspaceId: string;
   boardId: string;
   issueId: string;
   agentId: string;
   ownerId: string;
   ownerToken: string;
   memberId: string;
   memberToken: string;
   outsiderId: string;
   outsiderToken: string;
   otherWorkspaceId: string;
   otherAgentId: string;
}

export async function seedAgentLayerWorld(sql: Sql): Promise<AgentLayerWorld> {
   const sessions = new SessionService({ sql, sessionTtlMs: 3_600_000 });
   const suffix = randomUUID().slice(0, 8);

   const user = async (handle: string): Promise<string> => {
      const [row] = await sql`
         INSERT INTO users (id, email, name)
         VALUES (${randomUUID()}, ${`${handle}-${suffix}@berry.test`}, ${handle})
         RETURNING id`;
      return row?.id as string;
   };
   const workspace = async (owner: string, label: string): Promise<string> => {
      const [row] = await sql`
         INSERT INTO workspaces (id, name, slug, settings, created_by)
         VALUES (${randomUUID()}, ${`${label} ${suffix}`}, ${`${label.toLowerCase()}-${suffix}`},
                 ${sql.json({ issuePrefix: 'AGL', defaultRole: 'member', allowMemberInvites: false } as never)},
                 ${owner})
         RETURNING id`;
      return row?.id as string;
   };
   const join = async (workspaceId: string, userId: string, role: string): Promise<void> => {
      await sql`
         INSERT INTO workspace_memberships (workspace_id, user_id, role)
         VALUES (${workspaceId}, ${userId}, ${role})`;
      await sql`UPDATE users SET last_workspace_id = ${workspaceId} WHERE id = ${userId}`;
   };
   const agent = async (workspaceId: string, name: string): Promise<string> => {
      const [row] = await sql`
         INSERT INTO agents (id, workspace_id, name, status)
         VALUES (${randomUUID()}, ${workspaceId}, ${name}, 'available')
         RETURNING id`;
      return row?.id as string;
   };

   const ownerId = await user('owner');
   const memberId = await user('member');
   const outsiderId = await user('outsider');
   const workspaceId = await workspace(ownerId, 'Agl');
   const otherWorkspaceId = await workspace(outsiderId, 'Other');
   await join(workspaceId, ownerId, 'owner');
   await join(workspaceId, memberId, 'member');
   await join(otherWorkspaceId, outsiderId, 'owner');

   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${workspaceId}, 'Agent layer', ${`agl-${suffix}`}, ${ownerId})
      RETURNING id`;
   const boardId = board?.id as string;
   const issueId = randomUUID();
   const [counter] = await sql`
      UPDATE boards SET issue_counter = issue_counter + 1 WHERE id = ${boardId}
      RETURNING issue_counter`;
   await sql`
      INSERT INTO issues (id, board_id, number, title, created_by)
      VALUES (${issueId}, ${boardId}, ${Number(counter?.issue_counter)}, 'Agent layer task', ${ownerId})`;

   return {
      workspaceId,
      boardId,
      issueId,
      agentId: await agent(workspaceId, `Coder ${suffix}`),
      ownerId,
      ownerToken: (await sessions.issueForUser(ownerId)).token,
      memberId,
      memberToken: (await sessions.issueForUser(memberId)).token,
      outsiderId,
      outsiderToken: (await sessions.issueForUser(outsiderId)).token,
      otherWorkspaceId,
      otherAgentId: await agent(otherWorkspaceId, `Foreign ${suffix}`),
   };
}

export async function dropAgentLayerWorld(sql: Sql, world: AgentLayerWorld): Promise<void> {
   const ids = [world.workspaceId, world.otherWorkspaceId];
   await sql`DELETE FROM outbox_events WHERE workspace_id IN ${sql(ids)}`;
   // Rows that hold an agent with ON DELETE RESTRICT go first, or the agent
   // delete below fails: squads (leader), quick actions (target agent), and
   // runs — including chat runs that have no board once A lands.
   await sql`DELETE FROM squads WHERE workspace_id IN ${sql(ids)}`.catch(() => undefined);
   await sql`DELETE FROM quick_action_definitions WHERE workspace_id IN ${sql(ids)}`;
   await sql`DELETE FROM runs WHERE agent_id IN (SELECT id FROM agents WHERE workspace_id IN ${sql(ids)})`;
   await sql`DELETE FROM runs WHERE board_id IN (SELECT id FROM boards WHERE workspace_id IN ${sql(ids)})`;
   await sql`DELETE FROM issues WHERE board_id IN (SELECT id FROM boards WHERE workspace_id IN ${sql(ids)})`;
   await sql`DELETE FROM conversations WHERE workspace_id IN ${sql(ids)}`;
   // Ordinary agents first, so their foreign-key cascades (skill bindings, MCP
   // servers, access lists, avatars, pinned agents) fire as usual.
   await sql`DELETE FROM agents WHERE workspace_id IN ${sql(ids)} AND NOT protected`;
   // Then the protected orchestrators, which refuse deletion by trigger. The
   // trigger is bypassed for this one transaction only (replica mode), never
   // with a table-wide ALTER TABLE ... DISABLE TRIGGER: test files run in
   // parallel, and one file re-enabling the trigger between another's disable
   // and delete made unrelated suites fail with "agent is protected".
   await sql.begin(async (transaction) => {
      const tx = transaction as unknown as Sql;
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`DELETE FROM agents WHERE workspace_id IN ${tx(ids)} AND protected`;
   });
   await sql`DELETE FROM boards WHERE workspace_id IN ${sql(ids)}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id IN ${sql(ids)}`;
   await sql`DELETE FROM workspaces WHERE id IN ${sql(ids)}`;
   await sql`DELETE FROM users WHERE id IN ${sql([world.ownerId, world.memberId, world.outsiderId])}`;
}

/** One request through the real app, as a signed-in user. */
export async function call(
   app: BerryApp,
   token: string,
   method: string,
   path: string,
   body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
   const headers: Record<string, string> = { authorization: `Bearer ${token}` };
   // An idempotent POST fingerprints its body, so a bodiless one sends `{}`,
   // as the web client does.
   if (method === 'POST' && body === undefined) body = {};
   if (body !== undefined) headers['content-type'] = 'application/json';
   if (method === 'POST') headers['idempotency-key'] = `agent-layer-${randomUUID()}`;
   const response = await app.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
   });
   const text = await response.text();
   return {
      status: response.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
   };
}
