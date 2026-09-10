import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { EnqueueInput, EnqueueTask } from '../agents/seams.ts';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { ConversationRepository } from '../conversations/repository.ts';
import { BoardRepository } from '../core/boards.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { RunLedger } from '../runs/ledger.ts';
import { RunRepository } from '../runs/repository.ts';
import { call, dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from './agent-layer.fixture.ts';
import { conversationMounts } from './conversations.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

function buildApp(sql: Sql, enqueue: EnqueueTask | null): BerryApp {
   const registry = new Registry();
   registry.registerAll(
      conversationMounts({
         sessions: new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] }),
         conversations: new ConversationRepository(sql),
         boards: new BoardRepository(sql),
         sql,
         enqueue,
         complete: null,
         ledger: new RunLedger({ sql }),
         runs: new RunRepository(sql),
      })
   );
   return createApp(registry);
}

describe('conversations mount', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let offline: BerryApp;
   let world: AgentLayerWorld;
   let hasChatColumn = false;
   const enqueued: EnqueueInput[] = [];

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      // The fake returns a real run row, because a session's active run is a
      // foreign key to runs.
      const enqueue: EnqueueTask = async (_sql, input) => {
         enqueued.push(input);
         const [run] = await sql`
            INSERT INTO runs (issue_id, board_id, agent_id, requested_by, status, completed_at)
            VALUES (${world.issueId}, ${world.boardId}, ${world.agentId}, ${world.ownerId}, 'cancelled', now())
            RETURNING id`;
         return { runId: run?.id as string };
      };
      app = buildApp(sql, enqueue);
      offline = buildApp(sql, null);
      const [column] = await sql`
         SELECT 1 FROM information_schema.columns WHERE table_name = 'runs' AND column_name = 'chat_session_id'`;
      hasChatColumn = Boolean(column);
   });
   after(async () => {
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   const newSession = async (token = world.ownerToken): Promise<string> => {
      const res = await call(app, token, 'POST', '/api/v1/conversations', { agentId: world.agentId });
      assert.equal(res.status, 201);
      return res.body.id as string;
   };

   test('each new chat is its own session', async () => {
      assert.notEqual(await newSession(), await newSession());
   });

   test('a message is queued as a task and answered 202', async () => {
      const id = await newSession();
      const res = await call(app, world.ownerToken, 'POST', `/api/v1/conversations/${id}/messages`, { body: 'hi' });
      assert.equal(res.status, 202);
      assert.equal(res.body.queued, true);
      assert.equal(enqueued.at(-1)?.source, 'chat');
      assert.equal(enqueued.at(-1)?.chatSessionId, id);
   });

   test('without the runtime the message is kept and the send refused with a stable code', async () => {
      const id = await newSession();
      const res = await call(offline, world.ownerToken, 'POST', `/api/v1/conversations/${id}/messages`, { body: 'kept' });
      assert.equal(res.status, 503);
      assert.equal((res.body.error as { code: string }).code, 'AGENT_TASKS_UNAVAILABLE');
      const messages = await call(app, world.ownerToken, 'GET', `/api/v1/conversations/${id}/messages`);
      assert.deepEqual(
         (messages.body.nodes as { body: string }[]).map((m) => m.body),
         ['kept']
      );
   });

   test('a rename shows in the list, and a draft is kept per person', async () => {
      const id = await newSession();
      assert.equal((await call(app, world.ownerToken, 'PATCH', `/api/v1/conversations/${id}`, { title: 'Renamed' })).status, 204);
      assert.equal((await call(app, world.ownerToken, 'PUT', `/api/v1/conversations/${id}/draft`, { draft: 'wip' })).status, 204);
      const list = await call(app, world.ownerToken, 'GET', '/api/v1/conversations');
      const found = (list.body.nodes as { id: string; topic: string; draft: string }[]).find((c) => c.id === id);
      assert.equal(found?.topic, 'Renamed');
      assert.equal(found?.draft, 'wip');
   });

   test('a deleted session is gone', async () => {
      const id = await newSession();
      assert.equal((await call(app, world.ownerToken, 'DELETE', `/api/v1/conversations/${id}`)).status, 204);
      assert.equal((await call(app, world.ownerToken, 'GET', `/api/v1/conversations/${id}/messages`)).status, 404);
   });

   test('an outsider cannot read a session', async () => {
      const id = await newSession();
      assert.equal((await call(app, world.outsiderToken, 'GET', `/api/v1/conversations/${id}/messages`)).status, 404);
      assert.equal((await call(app, world.memberToken, 'GET', `/api/v1/conversations/${id}/messages`)).status, 404);
   });

   test('a chat with another workspace’s agent is not found', async () => {
      const res = await call(app, world.ownerToken, 'POST', '/api/v1/conversations', { agentId: world.otherAgentId });
      assert.equal(res.status, 404);
   });

   test('pinned agents are the caller’s own and stay inside the workspace', async () => {
      const put = await call(app, world.ownerToken, 'PUT', '/api/v1/conversations/pinned-agents', {
         agentIds: [world.agentId],
      });
      assert.equal(put.status, 200);
      const get = await call(app, world.ownerToken, 'GET', '/api/v1/conversations/pinned-agents');
      assert.deepEqual(get.body.agentIds, [world.agentId]);
      const foreign = await call(app, world.ownerToken, 'PUT', '/api/v1/conversations/pinned-agents', {
         agentIds: [world.otherAgentId],
      });
      assert.equal(foreign.status, 404);
      const member = await call(app, world.memberToken, 'GET', '/api/v1/conversations/pinned-agents');
      assert.deepEqual(member.body.agentIds, []);
   });

   test('suggestions are scoped to the caller’s workspace', async () => {
      const res = await call(app, world.ownerToken, 'GET', `/api/v1/conversations/suggestions?agentId=${world.agentId}`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.nodes));
   });

   test('a task id from outside the session is not found', async (t) => {
      if (!hasChatColumn) {
         t.skip('runs.chat_session_id is not present (workstream A not merged)');
         return;
      }
      const id = await newSession();
      const res = await call(app, world.ownerToken, 'POST', `/api/v1/conversations/${id}/tasks/${randomUUID()}/cancel`);
      assert.equal(res.status, 404);
   });

   test('a session lists, prioritises and cancels its queued tasks', async (t) => {
      if (!hasChatColumn) {
         t.skip('runs.chat_session_id is not present (workstream A not merged)');
         return;
      }
      const id = await newSession();
      const [run] = await sql`
         INSERT INTO runs (issue_id, board_id, agent_id, requested_by, chat_session_id)
         VALUES (${world.issueId}, ${world.boardId}, ${world.agentId}, ${world.ownerId}, ${id}) RETURNING id`;
      const runId = run?.id as string;
      const tasks = await call(app, world.ownerToken, 'GET', `/api/v1/conversations/${id}/tasks`);
      assert.ok((tasks.body.nodes as { id: string }[]).some((task) => task.id === runId));
      const up = await call(app, world.ownerToken, 'POST', `/api/v1/conversations/${id}/tasks/${runId}/prioritize`);
      assert.equal(up.status, 204);
      const [row] = await sql`SELECT priority FROM runs WHERE id = ${runId}`;
      assert.equal(Number(row?.priority), 100);
      const cancel = await call(app, world.ownerToken, 'POST', `/api/v1/conversations/${id}/tasks/${runId}/cancel`);
      assert.equal(cancel.status, 202);
   });
});
