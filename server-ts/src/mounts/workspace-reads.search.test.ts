// Global search over the new result types, against a two-workspace world.
//
// W1 has members U1 (the caller) and U3; W2 has member U2 only. Each workspace
// carries a project and an agent whose names share a random marker, so a
// search for the marker would surface W2's rows if the scope leaked. Driven
// through the real app with U1's session, gated on BERRY_TEST_DATABASE_URL so a
// fresh `pnpm test:server` stays green offline.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import { BoardRepository } from '../core/boards.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { workspaceReadMounts } from './workspace-reads.ts';
import { deleteWorkspaceAgentsInTransaction } from '../test-support/protected-agents.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

interface SearchNode {
   type: string;
   id: string;
   title: string;
   subtitle: string | null;
   agentId: string | null;
}

interface World {
   marker: string;
   u1Token: string;
   u1Id: string;
   u3Id: string;
   w1Id: string;
   w2Id: string;
   w1ProjectId: string;
   w2ProjectId: string;
   w1DeletedProjectId: string;
   w1AgentId: string;
   w2AgentId: string;
   w1ArchivedAgentId: string;
   userIds: string[];
   workspaceIds: string[];
   ownThreadId: string;
   foreignThreadId: string;
   crossTenantThreadId: string;
}

describe(
   'global search: projects, agents, chat and skills',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let app: BerryApp;
      const world = {} as World;

      async function insertUser(label: string): Promise<string> {
         const [row] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`search-${label}-${world.marker}@berry.test`}, ${`Search ${label}`})
            RETURNING id`;
         return row!.id as string;
      }

      async function insertWorkspace(label: string, ownerId: string): Promise<string> {
         const [row] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`${label} ${world.marker}`}, ${`${label.toLowerCase()}-${world.marker}`},
                    ${sql.json({ issuePrefix: `${label}S`, defaultRole: 'member', allowMemberInvites: false } as never)},
                    ${ownerId})
            RETURNING id`;
         return row!.id as string;
      }

      async function insertProject(workspaceId: string, name: string, deleted = false): Promise<string> {
         const [row] = await sql`
            INSERT INTO projects (workspace_id, name, description, deleted_at)
            VALUES (${workspaceId}, ${name}, 'search fixture', ${deleted ? new Date().toISOString() : null})
            RETURNING id`;
         return row!.id as string;
      }

      // The `runtime_agent_id` column was dropped by migration 032; do not insert it.
      async function insertAgent(workspaceId: string, name: string, archived = false): Promise<string> {
         const [row] = await sql`
            INSERT INTO agents (workspace_id, name, description, archived_at)
            VALUES (${workspaceId}, ${name}, 'search fixture', ${archived ? new Date().toISOString() : null})
            RETURNING id`;
         return row!.id as string;
      }

      before(async () => {
         sql = openDatabase({ url: url as string });
         const sessions = new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] });
         const boards = new BoardRepository(sql);
         const registry = new Registry();
         registry.registerAll(workspaceReadMounts({ sessions, sql, boards }));
         app = createApp(registry);

         world.marker = randomUUID().slice(0, 8);
         world.u1Id = await insertUser('u1');
         const u2Id = await insertUser('u2');
         world.u3Id = await insertUser('u3');
         world.userIds = [world.u1Id, u2Id, world.u3Id];

         world.w1Id = await insertWorkspace('W1', world.u1Id);
         world.w2Id = await insertWorkspace('W2', u2Id);
         world.workspaceIds = [world.w1Id, world.w2Id];
         await sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${world.w1Id}, ${world.u1Id}, 'owner'),
                   (${world.w1Id}, ${world.u3Id}, 'member'),
                   (${world.w2Id}, ${u2Id}, 'owner')`;

         world.w1ProjectId = await insertProject(world.w1Id, `proj-${world.marker}-w1`);
         world.w2ProjectId = await insertProject(world.w2Id, `proj-${world.marker}-w2`);
         world.w1DeletedProjectId = await insertProject(world.w1Id, `proj-${world.marker}-gone`, true);

         world.w1AgentId = await insertAgent(world.w1Id, `agent-${world.marker}-w1`);
         world.w2AgentId = await insertAgent(world.w2Id, `agent-${world.marker}-w2`);
         world.w1ArchivedAgentId = await insertAgent(world.w1Id, `agent-${world.marker}-old`, true);

         // U1's own thread with the W1 agent, found by topic and by agent name.
         const [own] = await sql`
            INSERT INTO conversations (workspace_id, kind, topic, created_by)
            VALUES (${world.w1Id}, 'direct', ${`thread-${world.marker}-mine`}, ${world.u1Id})
            RETURNING id`;
         world.ownThreadId = own!.id as string;
         await sql`
            INSERT INTO conversation_participants (conversation_id, participant_type, participant_id, role)
            VALUES (${world.ownThreadId}, 'user', ${world.u1Id}, 'owner'),
                   (${world.ownThreadId}, 'agent', ${world.w1AgentId}, 'member')`;

         // U3's thread in the same workspace. U1 is a fellow member but not a
         // participant, so it must stay private to U3.
         const [foreign] = await sql`
            INSERT INTO conversations (workspace_id, kind, topic, created_by)
            VALUES (${world.w1Id}, 'direct', ${`thread-${world.marker}-theirs`}, ${world.u3Id})
            RETURNING id`;
         world.foreignThreadId = foreign!.id as string;
         await sql`
            INSERT INTO conversation_participants (conversation_id, participant_type, participant_id, role)
            VALUES (${world.foreignThreadId}, 'user', ${world.u3Id}, 'owner')`;

         // A W2 thread that U1 participates in (participant rows carry no
         // membership FK). A W1-scoped search must still never return it, and
         // the W2 agent on it must not leak its name.
         const [crossTenant] = await sql`
            INSERT INTO conversations (workspace_id, kind, topic, created_by)
            VALUES (${world.w2Id}, 'direct', ${`thread-${world.marker}-w2`}, ${world.u1Id})
            RETURNING id`;
         world.crossTenantThreadId = crossTenant!.id as string;
         await sql`
            INSERT INTO conversation_participants (conversation_id, participant_type, participant_id, role)
            VALUES (${world.crossTenantThreadId}, 'user', ${world.u1Id}, 'owner'),
                   (${world.crossTenantThreadId}, 'agent', ${world.w2AgentId}, 'member')`;

         world.u1Token = await issueTestToken(sql, world.u1Id);
      });

      after(async () => {
         if (!sql) return;
         if (world.workspaceIds?.length) {
            const workspaceIds = world.workspaceIds;
            // One transaction; the protected Orchestrator is cleared and deleted
            // inside it, invisible to any suite running in parallel.
            await sql.begin(async (tx) => {
               for (const ws of workspaceIds) {
                  await tx`DELETE FROM outbox_events WHERE workspace_id = ${ws}`;
                  await tx`DELETE FROM conversations WHERE workspace_id = ${ws}`;
                  await tx`DELETE FROM projects WHERE workspace_id = ${ws}`;
                  await deleteWorkspaceAgentsInTransaction(tx as unknown as Sql, [ws]);
                  await tx`DELETE FROM boards WHERE workspace_id = ${ws}`;
                  await tx`DELETE FROM issue_status_definitions WHERE workspace_id = ${ws}`;
                  await tx`DELETE FROM workspace_memberships WHERE workspace_id = ${ws}`;
                  await tx`DELETE FROM workspaces WHERE id = ${ws}`;
               }
            });
         }
         for (const uid of world.userIds ?? []) {
            await sql`DELETE FROM users WHERE id = ${uid}`;
         }
         await closeDatabase(sql);
      });

      async function search(types: string, query: string): Promise<SearchNode[]> {
         const response = await app.request(
            `/api/v1/search?workspaceId=${world.w1Id}&types=${types}&query=${encodeURIComponent(query)}`,
            { headers: { authorization: `Bearer ${world.u1Token}` } }
         );
         assert.equal(response.status, 200);
         return ((await response.json()) as { nodes: SearchNode[] }).nodes;
      }

      test('a project search finds the workspace’s live projects and nothing from another workspace', async () => {
         const nodes = await search('project', `proj-${world.marker}`);
         const ids = nodes.map((node) => node.id);
         assert.ok(ids.includes(world.w1ProjectId), 'W1 project is found');
         assert.ok(!ids.includes(world.w2ProjectId), 'W2 project must not leak into a W1 search');
         assert.ok(!ids.includes(world.w1DeletedProjectId), 'a deleted project is not found');
         assert.ok(nodes.every((node) => node.type === 'project' && node.agentId === null));
      });

      test('an agent search finds live agents of the workspace only', async () => {
         const nodes = await search('agent', `agent-${world.marker}`);
         const ids = nodes.map((node) => node.id);
         assert.ok(ids.includes(world.w1AgentId), 'W1 agent is found');
         assert.ok(!ids.includes(world.w2AgentId), 'W2 agent must not leak into a W1 search');
         assert.ok(!ids.includes(world.w1ArchivedAgentId), 'an archived agent is not found');
         const own = nodes.find((node) => node.id === world.w1AgentId);
         assert.equal(own?.agentId, world.w1AgentId, 'an agent result carries its own id as agentId');
      });

      test('a chat search finds the caller’s own threads by topic', async () => {
         const nodes = await search('chat', `thread-${world.marker}`);
         const ids = nodes.map((node) => node.id);
         assert.ok(ids.includes(world.ownThreadId), 'the caller’s thread is found');
         const own = nodes.find((node) => node.id === world.ownThreadId);
         assert.equal(own?.agentId, world.w1AgentId, 'a thread result names the agent it is with');
      });

      test('a chat search never surfaces a thread the caller is not in, even in their workspace', async () => {
         const nodes = await search('chat', `thread-${world.marker}`);
         assert.ok(!nodes.some((node) => node.id === world.foreignThreadId));
      });

      test('a chat search never surfaces the caller’s own thread from another workspace', async () => {
         const byTopic = await search('chat', `thread-${world.marker}`);
         assert.ok(!byTopic.some((node) => node.id === world.crossTenantThreadId));
         const byAgent = await search('chat', `agent-${world.marker}-w2`);
         assert.ok(!byAgent.some((node) => node.id === world.crossTenantThreadId));
         assert.ok(!byAgent.some((node) => node.agentId === world.w2AgentId));
      });

      test('a chat search also matches the agent’s name', async () => {
         const nodes = await search('chat', `agent-${world.marker}-w1`);
         assert.ok(nodes.some((node) => node.id === world.ownThreadId));
      });

      test('a skill search answers 200 whether or not the skills catalogue exists yet', async () => {
         const nodes = await search('skill', world.marker);
         assert.ok(Array.isArray(nodes));
         assert.ok(nodes.every((node) => node.type === 'skill'));
      });

      test('an unknown type is a 422, not an empty result', async () => {
         const response = await app.request(
            `/api/v1/search?workspaceId=${world.w1Id}&types=initiative&query=x`,
            { headers: { authorization: `Bearer ${world.u1Token}` } }
         );
         assert.equal(response.status, 422);
      });
   }
);
