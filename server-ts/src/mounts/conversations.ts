import { Hono } from 'hono';
import { z } from 'zod';
import type { CompleteFn, EnqueueTask } from '../agents/seams.ts';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { BoardRepository } from '../core/boards.ts';
import {
   ChatNotAnswerable,
   chatSuggestions,
   generateTitle,
   sendChatMessage,
} from '../conversations/chat-tasks.ts';
import type { ConversationContext, ConversationRepository } from '../conversations/repository.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import type { Logger } from '../observability/log.ts';
import type { RunLedger } from '../runs/ledger.ts';
import type { RunRepository } from '../runs/repository.ts';
import { serializeRun } from './runs.ts';
import { currentWorkspace, pathId, resolveScoped } from './shared.ts';
import { readJson } from './zod-body.ts';

/**
 * `/api/v1/conversations`: chat sessions whose messages run as agent tasks.
 *
 * A message is stored, then queued as a task on the session's agent through
 * workstream A's `enqueueTask` (injected); the reply arrives when the task
 * ends. The session's tasks can be listed, cancelled and prioritised like any
 * other queued work. Every `/:conversationId` route checks participation, and
 * "not yours" reads the same as "does not exist".
 */

const MAX_BODY = 20_000;

export interface ConversationOptions {
   sessions: SessionService;
   conversations: ConversationRepository;
   boards: BoardRepository;
   sql: Sql;
   /** Workstream A's enqueueTask; null until A is wired in (Task 13). */
   enqueue: EnqueueTask | null;
   /** Workstream A's runCompletion, for titles; null until A is wired in. */
   complete: CompleteFn | null;
   ledger: Pick<RunLedger, 'markCancelled'>;
   runs: RunRepository;
   logger?: Logger;
}

const createSchema = z.strictObject({
   agentId: z.string().uuid(),
   title: z.string().trim().min(1).max(200).optional(),
});
const patchSchema = z
   .strictObject({
      title: z.string().trim().min(1).max(200).optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
   })
   .refine((body) => Object.keys(body).length > 0, 'Provide at least one field.');
const draftSchema = z.strictObject({ draft: z.string().max(20_000) });
const messageSchema = z.strictObject({ body: z.string().trim().min(1).max(MAX_BODY) });
const pinnedSchema = z.strictObject({ agentIds: z.array(z.string().uuid()).max(20) });

export function conversationMounts(options: ConversationOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { conversations, sql } = options;

   /** The workspace of an agent the caller may chat with, or 404 Agent. */
   const agentWorkspace = async (userId: string, agentId: string): Promise<{ workspaceId: string; name: string }> => {
      const [agent] = await sql`
         SELECT workspace_id, name FROM agents WHERE id = ${agentId} AND archived_at IS NULL`;
      if (!agent) throw ApiError.notFound('Agent');
      await options.boards
         .authorizeWorkspace(userId, agent.workspace_id as string, 'product.write')
         .catch((error: unknown) => {
            if (error instanceof NotFound || error instanceof Forbidden) throw ApiError.notFound('Agent');
            throw error;
         });
      return { workspaceId: agent.workspace_id as string, name: agent.name as string };
   };
   const scoped = async (user: { id: string; currentWorkspaceId: string | null }, write: boolean) =>
      (
         await resolveScoped(
            sql,
            user.id,
            currentWorkspace(user.currentWorkspaceId),
            write ? 'product.write' : 'product.read'
         )
      ).ctx.workspaceId;

   route.get('/', async (context) => {
      const archived = new URL(context.req.url).searchParams.get('archived') === 'true';
      return json({ nodes: await conversations.list(context.get('user').id, { archived }) });
   });

   /** A new chat with an agent. Never deduplicated: "new chat" means a new thread. */
   route.post('/', async (context) => {
      const user = context.get('user');
      const input = await readJson(context, createSchema);
      const agent = await agentWorkspace(user.id, input.agentId.toLowerCase());
      const id = await conversations
         .createSession({
            workspaceId: agent.workspaceId,
            userId: user.id,
            agentId: input.agentId.toLowerCase(),
            title: input.title ?? null,
         })
         .catch((error: unknown) => {
            if (error instanceof NotFound) throw ApiError.notFound('Agent');
            throw error;
         });
      return json({ id }, 201);
   });

   /** The caller's latest open thread with an agent, or a new one. */
   route.post('/agents/:agentId', async (context) => {
      const agentId = pathId(context.req.param('agentId'), 'Agent');
      const user = context.get('user');
      const agent = await agentWorkspace(user.id, agentId);
      const id = await conversations.openWithAgent({
         workspaceId: agent.workspaceId,
         userId: user.id,
         agentId,
         agentName: agent.name,
      });
      return json({ id });
   });

   // Registered before `/:conversationId` so neither name is read as an id.
   route.get('/suggestions', async (context) => {
      const workspaceId = await scoped(context.get('user'), false);
      const agentId = pathId(new URL(context.req.url).searchParams.get('agentId') ?? undefined, 'Agent');
      return json({ nodes: await chatSuggestions(sql, { workspaceId, agentId }) });
   });

   route.get('/pinned-agents', async (context) => {
      const user = context.get('user');
      const workspaceId = await scoped(user, false);
      return json({ agentIds: await conversations.pinnedAgents(user.id, workspaceId) });
   });

   route.put('/pinned-agents', async (context) => {
      const user = context.get('user');
      const workspaceId = await scoped(user, true);
      const { agentIds } = await readJson(context, pinnedSchema);
      await conversations
         .setPinnedAgents(
            user.id,
            workspaceId,
            agentIds.map((id) => id.toLowerCase())
         )
         .catch((error: unknown) => {
            if (error instanceof NotFound) throw ApiError.notFound('Agent');
            throw error;
         });
      return json({ agentIds: await conversations.pinnedAgents(user.id, workspaceId) });
   });

   route.patch('/:conversationId', async (context) => {
      const conversation = await load(context);
      const userId = context.get('user').id;
      const patch = await readJson(context, patchSchema);
      if (patch.title !== undefined) await conversations.rename(conversation.id, userId, patch.title).catch(gone);
      if (patch.pinned !== undefined) await conversations.setPinned(conversation.id, userId, patch.pinned).catch(gone);
      if (patch.archived !== undefined) {
         await conversations.setArchived(conversation.id, userId, patch.archived).catch(gone);
      }
      return new Response(null, { status: 204 });
   });

   route.delete('/:conversationId', async (context) => {
      const conversation = await load(context);
      await conversations.remove(conversation.id, context.get('user').id).catch(gone);
      return new Response(null, { status: 204 });
   });

   route.post('/:conversationId/read', async (context) => {
      const conversation = await load(context);
      await conversations.markRead(conversation.id, context.get('user').id).catch(gone);
      return new Response(null, { status: 204 });
   });

   route.put('/:conversationId/draft', async (context) => {
      const conversation = await load(context);
      const { draft } = await readJson(context, draftSchema);
      await conversations.saveDraft(conversation.id, context.get('user').id, draft).catch(gone);
      return new Response(null, { status: 204 });
   });

   route.get('/:conversationId/messages', async (context) => {
      const conversation = await load(context);
      const url = new URL(context.req.url);
      const rawBefore = url.searchParams.get('before');
      const before = rawBefore ? pathId(rawBefore, 'Message') : undefined;
      const first = Math.min(Math.max(Number(url.searchParams.get('first') ?? '200') || 200, 1), 200);
      return json({ nodes: await conversations.messages(conversation.id, { before, limit: first }) });
   });

   route.post('/:conversationId/messages', async (context) => {
      const conversation = await load(context);
      const userId = context.get('user').id;
      const { body } = await readJson(context, messageSchema);
      if (!options.enqueue) {
         // Kept, so what the person typed is not lost; nobody can run it here.
         await conversations.append({ conversationId: conversation.id, authorType: 'user', authorId: userId, body });
         throw new ApiError(503, 'AGENT_TASKS_UNAVAILABLE', 'This server cannot run agent tasks.');
      }
      const first = (await conversations.messages(conversation.id, { limit: 1 })).length === 0;
      const sent = await sendChatMessage(
         { sql, conversations, enqueue: options.enqueue },
         { conversation, userId, body }
      ).catch((error: unknown) => {
         if (error instanceof ChatNotAnswerable) {
            throw new ApiError(409, 'CONVERSATION_HAS_NO_AGENT', 'This conversation has no agent to answer it.');
         }
         throw error;
      });
      await conversations.saveDraft(conversation.id, userId, '');
      const complete = options.complete;
      if (first && complete) {
         // Best effort, after the response: a title is a nicety, never a failed send.
         void generateTitle(
            { sql, complete },
            { workspaceId: conversation.workspaceId, conversationId: conversation.id, firstMessage: body }
         ).catch((error: unknown) => options.logger?.error('chat title failed', { error: String(error) }));
      }
      return json({ messageId: sent.messageId, runId: sent.runId, queued: true }, 202);
   });

   // The session's task queue. These read `runs.chat_session_id` and
   // `runs.priority`, which are workstream A's columns.
   route.get('/:conversationId/tasks', async (context) => {
      const conversation = await load(context);
      const rows = await sql`
         SELECT id, status, priority, created_at, started_at FROM runs
          WHERE chat_session_id = ${conversation.id} AND status IN ('queued', 'running')
          ORDER BY priority DESC, created_at ASC`;
      return json({
         nodes: rows.map((row) => ({
            id: row.id as string,
            status: row.status as string,
            priority: Number(row.priority),
            createdAt: new Date(row.created_at as string).toISOString(),
            startedAt: row.started_at ? new Date(row.started_at as string).toISOString() : null,
         })),
      });
   });

   route.post('/:conversationId/tasks/:runId/cancel', async (context) => {
      const conversation = await load(context);
      const runId = await sessionRun(conversation, context.req.param('runId'));
      const run = await options.ledger.markCancelled(runId);
      return json(serializeRun(run), 202);
   });

   route.post('/:conversationId/tasks/:runId/prioritize', async (context) => {
      const conversation = await load(context);
      const runId = await sessionRun(conversation, context.req.param('runId'));
      const updated = await sql`
         UPDATE runs SET priority = 100
          WHERE id = ${runId} AND chat_session_id = ${conversation.id} AND status = 'queued'`;
      if (updated.count === 0) throw new ApiError(409, 'TASK_NOT_QUEUED', 'Only a queued task can be moved up.');
      return new Response(null, { status: 204 });
   });

   route.get('/:conversationId/tasks/:runId/events', async (context) => {
      const conversation = await load(context);
      const runId = await sessionRun(conversation, context.req.param('runId'));
      return json({ nodes: await options.runs.events(runId, null, 500) });
   });

   return [{ prefix: '/api/v1/conversations', handler: route }];

   async function load(context: {
      req: { param: (key: string) => string | undefined };
      get: (key: 'user') => { id: string };
   }): Promise<ConversationContext> {
      return conversations
         .context(pathId(context.req.param('conversationId'), 'Conversation'), context.get('user').id)
         .catch(() => {
            // "Not yours" and "does not exist" read the same.
            throw ApiError.notFound('Conversation');
         });
   }

   /** A run of this session, or 404: a run id from elsewhere is not reachable here. */
   async function sessionRun(conversation: ConversationContext, raw: string | undefined): Promise<string> {
      const runId = pathId(raw, 'Task');
      const [row] = await sql`SELECT 1 FROM runs WHERE id = ${runId} AND chat_session_id = ${conversation.id}`;
      if (!row) throw ApiError.notFound('Task');
      return runId;
   }
}

function gone(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Conversation');
   throw error;
}
