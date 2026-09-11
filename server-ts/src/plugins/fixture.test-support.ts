import { randomBytes, randomUUID } from 'node:crypto';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { sealerFromKey, type Sealer } from '../integrations/sealing.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

/** Shared by the plugin and public API tests. Not a test file itself. */

/** Sessions as J builds them in index.ts, minus cookies: tests authenticate with PATs. */
export function testSessions(sql: Sql): SessionService {
   return new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] });
}

export const HELLO = {
   manifest: {
      schemaVersion: 1,
      key: 'hello',
      name: 'Hello',
      version: '1.0.0',
      baseUrl: 'https://hello.example.com',
      scopes: ['issues:read', 'comments:write'],
      config: [{ key: 'greeting', label: 'Greeting', type: 'string', required: true }],
      secrets: [{ name: 'API_KEY' }],
      hooks: [
         { key: 'on-comment', trigger: 'event', events: ['comment.created'], path: '/hooks/comment' },
         { key: 'nightly', trigger: 'schedule', everyMinutes: 1440, path: '/hooks/nightly' },
      ],
      surfaces: [{ key: 'panel', title: 'Hello panel', path: '/ui' }],
      mcp: { path: '/mcp', tools: [{ name: 'say_hello' }] },
   },
   files: [{ path: 'README.md', content: '# Hello' }],
};

export interface World {
   userId: string;
   workspaceId: string;
   boardId: string;
   issueId: string;
   identifier: string;
}

export function testSealer(): Sealer {
   return sealerFromKey(randomBytes(32).toString('base64'));
}

/** A random, letters-only issue prefix, so identifier lookups never collide across runs. */
function randomPrefix(): string {
   return 'G' + Array.from(randomBytes(4), (byte) => String.fromCharCode(65 + (byte % 26))).join('');
}

export async function seedWorld(sql: Sql, label: string): Promise<World> {
   const suffix = randomUUID().slice(0, 8);
   const prefix = randomPrefix();
   const [user] = await sql`
      INSERT INTO users (id, email, name)
      VALUES (${randomUUID()}, ${`${label}-${suffix}@berry.test`}, ${label})
      RETURNING id`;
   const userId = user?.id as string;
   const [workspace] = await sql`
      INSERT INTO workspaces (id, name, slug, settings, created_by)
      VALUES (${randomUUID()}, ${`${label} ${suffix}`}, ${`${label}-${suffix}`},
              ${sql.json({ issuePrefix: prefix, defaultRole: 'member', allowMemberInvites: false } as never)},
              ${userId})
      RETURNING id`;
   const workspaceId = workspace?.id as string;
   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;
   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${workspaceId}, ${label}, ${`b-${suffix}`}, ${userId})
      RETURNING id`;
   const boardId = board?.id as string;
   const [counter] = await sql`
      UPDATE boards SET issue_counter = issue_counter + 1 WHERE id = ${boardId}
      RETURNING issue_counter`;
   const number = Number(counter?.issue_counter);
   const issueId = randomUUID();
   await sql`
      INSERT INTO issues (id, board_id, number, title, created_by)
      VALUES (${issueId}, ${boardId}, ${number}, ${`${label} task`}, ${userId})`;
   return { userId, workspaceId, boardId, issueId, identifier: `${prefix}-${number}` };
}

export async function dropWorld(sql: Sql, world: World): Promise<void> {
   if (!world.workspaceId) return;
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM plugin_installations WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM issues WHERE board_id = ${world.boardId}`;
   await deleteWorkspaceAgents(sql, [world.workspaceId]);
   await sql`DELETE FROM boards WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${world.workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${world.workspaceId}`;
   await sql`DELETE FROM users WHERE id = ${world.userId}`;
}
