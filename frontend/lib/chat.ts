import { z } from 'zod';
import { apiFetch } from './api';

const summarySchema = z.object({
   id: z.string(),
   kind: z.string(),
   topic: z.string(),
   agentId: z.string().nullish(),
   agentName: z.string().nullish(),
   messageCount: z.number(),
   updatedAt: z.string(),
});

const messageSchema = z.object({
   id: z.string(),
   authorType: z.enum(['user', 'agent', 'system']),
   authorName: z.string(),
   body: z.string(),
   channel: z.string(),
   createdAt: z.string(),
});

export type ChatThread = z.infer<typeof summarySchema>;
export type ChatMessage = z.infer<typeof messageSchema>;

const listSchema = z.object({ nodes: z.array(summarySchema) });
const messagesSchema = z.object({ nodes: z.array(messageSchema) });

export async function listThreads(): Promise<ChatThread[]> {
   const json: unknown = await apiFetch('/api/v1/conversations');
   const parsed = listSchema.safeParse(json);
   if (!parsed.success) throw new Error('Conversation list was not recognized');
   return parsed.data.nodes;
}

export async function listMessages(conversationId: string): Promise<ChatMessage[]> {
   const json: unknown = await apiFetch(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`
   );
   const parsed = messagesSchema.safeParse(json);
   if (!parsed.success) throw new Error('Message list was not recognized');
   return parsed.data.nodes;
}

/**
 * Open the caller's thread with an agent, or return the existing one.
 *
 * Idempotent on the server, so selecting the same agent twice continues one
 * conversation instead of starting a second.
 */
export async function openAgentThread(agentId: string): Promise<string> {
   const json: unknown = await apiFetch(
      `/api/v1/conversations/agents/${encodeURIComponent(agentId)}`,
      { method: 'POST' }
   );
   const parsed = z.object({ id: z.string() }).safeParse(json);
   if (!parsed.success) throw new Error('Conversation response was not recognized');
   return parsed.data.id;
}

export interface SendResult {
   replied: boolean;
   inputTokens?: number;
   outputTokens?: number;
}

/**
 * Send one turn and wait for the agent.
 *
 * This blocks for as long as the agent takes to answer — the server calls the
 * runtime's blocking endpoint rather than streaming, so there is no partial
 * output to render and the caller shows a pending state instead.
 */
export async function sendMessage(
   conversationId: string,
   body: string
): Promise<SendResult> {
   const json: unknown = await apiFetch(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({ body }),
      }
   );
   const parsed = z
      .object({
         replied: z.boolean(),
         inputTokens: z.number().optional(),
         outputTokens: z.number().optional(),
      })
      .safeParse(json);
   if (!parsed.success) throw new Error('Send response was not recognized');
   return parsed.data;
}
