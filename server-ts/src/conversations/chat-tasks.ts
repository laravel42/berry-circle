import { z } from 'zod';
import type { CompleteFn, EnqueueTask } from '../agents/seams.ts';
import type { Sql } from '../db/pool.ts';
import type { Run } from '../runs/ledger.ts';
import { onRunTerminal } from '../runs/terminal-hooks.ts';
import type { ConversationContext, ConversationRepository } from './repository.ts';

/**
 * Chat is an agent task.
 *
 * A message queues a run on the session's agent, with the session as its
 * runtime session (A's `(agent, chatSessionId)`), so chat has the same tools,
 * ledger and cancellation as any task. The reply is the run's final message,
 * appended when the run ends. Nothing here calls a model in-process.
 */

export class ChatNotAnswerable extends Error {
   override readonly name = 'ChatNotAnswerable';
}

export async function sendChatMessage(
   deps: { sql: Sql; conversations: ConversationRepository; enqueue: EnqueueTask },
   input: { conversation: ConversationContext; userId: string; body: string }
): Promise<{ messageId: string; runId: string }> {
   const agentId = input.conversation.agentId;
   if (!agentId) throw new ChatNotAnswerable('this conversation has no agent');
   const messageId = await deps.conversations.append({
      conversationId: input.conversation.id,
      authorType: 'user',
      authorId: input.userId,
      body: input.body,
   });
   const { runId } = await deps.enqueue(deps.sql, {
      workspaceId: input.conversation.workspaceId,
      agentId,
      kind: 'agent',
      source: 'chat',
      chatSessionId: input.conversation.id,
      prompt: input.body,
      // The sender asked for this run, so anything the agent files in it is
      // filed in their name rather than in nobody's.
      requestedBy: input.userId,
   });
   return { messageId, runId };
}

/** What the agent says when its task ends, for a run that belonged to a chat session. */
export function chatReplyBody(run: Pick<Run, 'status' | 'failure'>, summary: string | null): string {
   if (run.status === 'succeeded') {
      return (summary ?? '').trim() || '(The agent finished without a reply.)';
   }
   if (run.status === 'cancelled') return '(This task was cancelled.)';
   return `(The task failed: ${run.failure?.message ?? 'unknown error'})`;
}

/**
 * Posts a finished chat task's reply into its session.
 *
 * Reads `runs.chat_session_id`, which is workstream A's column: this hook is
 * registered in Task 13, once A has merged.
 */
export function registerChatReplies(deps: { sql: Sql; conversations: ConversationRepository }): () => void {
   return onRunTerminal(async (run: Run) => {
      const [row] = await deps.sql`SELECT chat_session_id, agent_id, summary FROM runs WHERE id = ${run.id}`;
      const conversationId = row?.chat_session_id as string | null | undefined;
      if (!conversationId) return;
      await deps.conversations.appendAgentReply({
         conversationId,
         agentId: row?.agent_id as string,
         body: chatReplyBody(run, (row?.summary as string | null) ?? null),
         runId: run.id,
      });
   });
}

const titleSchema = z.object({ title: z.string().trim().min(1).max(80) });

/** A short title from the first message; written only while nobody has chosen one. */
export async function generateTitle(
   deps: { sql: Sql; complete: CompleteFn },
   input: { workspaceId: string; conversationId: string; firstMessage: string }
): Promise<string | null> {
   const [row] = await deps.sql`
      SELECT title_source FROM conversations
       WHERE id = ${input.conversationId} AND workspace_id = ${input.workspaceId}`;
   if (row?.title_source !== 'agent') return null;
   const { title } = await deps.complete({
      workspaceId: input.workspaceId,
      purpose: 'chat_title',
      system: 'Name this conversation in at most six words. Return JSON {"title": "..."}.',
      prompt: input.firstMessage.slice(0, 2000),
      schema: titleSchema,
   });
   const updated = await deps.sql`
      UPDATE conversations SET topic = ${title}, title_source = 'generated'
       WHERE id = ${input.conversationId} AND workspace_id = ${input.workspaceId} AND title_source = 'agent'`;
   return updated.count === 1 ? title : null;
}

/** Starters for an empty chat: quick actions aimed at the agent, then its enabled skills. */
export async function chatSuggestions(
   sql: Sql,
   input: { workspaceId: string; agentId: string }
): Promise<{ label: string; prompt: string }[]> {
   const actions = await sql`
      SELECT name, prompt FROM quick_action_definitions
       WHERE workspace_id = ${input.workspaceId} AND target_agent_id = ${input.agentId} AND archived_at IS NULL
       ORDER BY name LIMIT 6`;
   const skills = await sql`
      SELECT s.name, s.description FROM agent_skills AS b JOIN skills AS s ON s.id = b.skill_id
       WHERE b.agent_id = ${input.agentId} AND b.enabled AND s.workspace_id = ${input.workspaceId}
       ORDER BY s.name LIMIT 4`;
   return [
      ...actions.map((action) => ({ label: action.name as string, prompt: action.prompt as string })),
      ...skills.map((skill) => ({
         label: `Use ${skill.name as string}`,
         prompt: `Use the ${skill.name as string} skill: ${skill.description as string}`,
      })),
   ];
}
