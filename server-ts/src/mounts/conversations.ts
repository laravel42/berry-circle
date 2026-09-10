import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { assertValid, decodeBody, fieldError } from '../http/body.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import type { BoardRepository } from '../core/boards.ts';
import type { Sql } from '../db/pool.ts';
import {
   ResponderUnavailable,
   type ConversationResponder,
} from '../conversations/responder.ts';
import type { ConversationRepository } from '../conversations/repository.ts';
import { pathId } from './shared.ts';

/**
 * `/api/v1/conversations`.
 *
 * Asking an agent something, as opposed to giving it a task. The difference is
 * the point: a run has a workspace, a ledger and a gate, and a conversation
 * has none of them because it does not do anything.
 *
 * `POST /messages` blocks for as long as the model takes. There is no partial
 * output to stream because the turn produces one answer, and a caller that
 * gave up gets the abort rather than a bill.
 */

const MAX_BODY = 20_000;

export interface ConversationOptions {
   sessions: SessionService;
   conversations: ConversationRepository;
   boards: BoardRepository;
   sql: Sql;
   /** Null without a model credential: the product then reads but cannot reply. */
   responder: ConversationResponder | null;
}

export function conversationMounts(options: ConversationOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { conversations } = options;

   route.get('/', async (context) => {
      return json({ nodes: await conversations.list(context.get('user').id) });
   });

   /**
    * Opens the caller's thread with an agent, or returns the one they have.
    *
    * Idempotent without a key, because two threads with the same agent would
    * be two halves of one memory.
    */
   route.post('/agents/:agentId', async (context) => {
      const agentId = pathId(context.req.param('agentId'), 'Agent');
      const user = context.get('user');

      const [agent] = await options.sql`
         SELECT id, workspace_id, name FROM agents
          WHERE id = ${agentId} AND archived_at IS NULL`;
      if (!agent) throw ApiError.notFound('Agent');

      await options.boards
         .authorizeWorkspace(user.id, agent.workspace_id as string, 'product.write')
         .catch((error: unknown) => {
            if (error instanceof NotFound || error instanceof Forbidden) {
               throw ApiError.notFound('Agent');
            }
            throw error;
         });

      const id = await conversations.openWithAgent({
         workspaceId: agent.workspace_id as string,
         userId: user.id,
         agentId,
         agentName: agent.name as string,
      });
      return json({ id });
   });

   route.get('/:conversationId/messages', async (context) => {
      const conversation = await load(context);
      return json({ nodes: await conversations.messages(conversation.id) });
   });

   route.post('/:conversationId/messages', async (context) => {
      const conversation = await load(context);
      const { value } = await decodeBody<{ body?: string }>(context, { body: 'string' });
      const body = (value.body ?? '').trim();
      if (body === '') {
         assertValid([fieldError('/body', 'required', 'body is required.')]);
      }
      if (body.length > MAX_BODY) {
         assertValid([fieldError('/body', 'too_long', `body is at most ${MAX_BODY} characters.`)]);
      }

      // Stored before the model is asked, so a turn that fails leaves the
      // question in the thread rather than losing what the person typed.
      await conversations.append({
         conversationId: conversation.id,
         authorType: 'user',
         authorId: context.get('user').id,
         body,
      });

      if (!conversation.agentId || !options.responder) {
         // A thread with no agent, or a deployment with no model credential.
         // The message is kept either way; there is simply nobody to answer.
         return json({ replied: false });
      }

      const controller = new AbortController();
      context.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true });

      try {
         const reply = await options.responder.reply({
            workspaceId: conversation.workspaceId,
            agentId: conversation.agentId,
            history: await conversations.messages(conversation.id),
            signal: controller.signal,
         });
         await conversations.append({
            conversationId: conversation.id,
            authorType: 'agent',
            authorId: conversation.agentId,
            body: reply.text,
         });
         return json({
            replied: true,
            inputTokens: reply.usage.inputTokens,
            outputTokens: reply.usage.outputTokens,
         });
      } catch (error) {
         if (error instanceof ResponderUnavailable) {
            throw new ApiError(503, 'AGENT_RUNTIME_UNAVAILABLE', `The agent could not answer: ${error.message}.`);
         }
         throw error;
      }
   });

   return [{ prefix: '/api/v1/conversations', handler: route }];

   async function load(context: {
      req: { param: (key: string) => string | undefined };
      get: (key: 'user') => { id: string };
   }) {
      return conversations
         .context(pathId(context.req.param('conversationId'), 'Conversation'), context.get('user').id)
         .catch(() => {
            // "Not yours" and "does not exist" read the same.
            throw ApiError.notFound('Conversation');
         });
   }
}
