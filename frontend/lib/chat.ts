import { z } from 'zod';
import { apiFetch } from './api';

/**
 * Chat sessions with an agent. Each message a person sends runs as an agent
 * task; the reply arrives when the task ends, so sending never blocks and
 * several messages can queue behind one another.
 */

const summarySchema = z.object({
   id: z.string(),
   kind: z.string(),
   topic: z.string(),
   agentId: z.string().nullish(),
   agentName: z.string().nullish(),
   messageCount: z.number(),
   updatedAt: z.string(),
   pinned: z.boolean().default(false),
   archived: z.boolean().default(false),
   unread: z.number().default(0),
   activeRunId: z.string().nullish(),
   draft: z.string().default(''),
   /**
    * The newest message, for the row preview. Defaulted rather than required
    * so a server that predates the field still parses.
    */
   lastMessage: z.string().nullish(),
   lastMessageAuthor: z.enum(['user', 'agent', 'system']).nullish(),
});

const messageSchema = z.object({
   id: z.string(),
   authorType: z.enum(['user', 'agent', 'system']),
   authorName: z.string(),
   body: z.string(),
   channel: z.string(),
   createdAt: z.string(),
   /** The task whose reply this is, for an agent message. */
   runId: z.string().nullish(),
});

const taskSchema = z.object({
   id: z.string(),
   status: z.enum(['queued', 'running']),
   priority: z.number(),
   createdAt: z.string(),
   startedAt: z.string().nullable(),
});

const taskEventSchema = z.object({
   id: z.string(),
   type: z.string(),
   occurredAt: z.string(),
   sequence: z.number(),
   payload: z.unknown(),
});

const suggestionSchema = z.object({ label: z.string(), prompt: z.string() });

export type ChatThread = z.infer<typeof summarySchema>;
export type ChatMessage = z.infer<typeof messageSchema>;
export type ChatTask = z.infer<typeof taskSchema>;
export type ChatTaskEvent = z.infer<typeof taskEventSchema>;
export type ChatSuggestion = z.infer<typeof suggestionSchema>;

const base = '/api/v1/conversations';
const session = (id: string, rest = '') => `${base}/${encodeURIComponent(id)}${rest}`;

export async function listThreads(options: { archived?: boolean } = {}): Promise<ChatThread[]> {
   const json: unknown = await apiFetch(options.archived ? `${base}?archived=true` : base);
   const parsed = z.object({ nodes: z.array(summarySchema) }).safeParse(json);
   if (!parsed.success) throw new Error('Conversation list was not recognized');
   return parsed.data.nodes;
}

/** One page of history, oldest first; `before` is the oldest message already shown. */
export async function listMessages(
   conversationId: string,
   before?: string
): Promise<ChatMessage[]> {
   const query = new URLSearchParams({ first: '50' });
   if (before) query.set('before', before);
   const json: unknown = await apiFetch(session(conversationId, `/messages?${query}`));
   const parsed = z.object({ nodes: z.array(messageSchema) }).safeParse(json);
   if (!parsed.success) throw new Error('Message list was not recognized');
   return parsed.data.nodes;
}

/** The caller's latest open session with an agent, or a new one. */
export async function openAgentThread(agentId: string): Promise<string> {
   const json: unknown = await apiFetch(`${base}/agents/${encodeURIComponent(agentId)}`, {
      method: 'POST',
      body: '{}',
   });
   return z.object({ id: z.string() }).parse(json).id;
}

/** A new session with an agent. Never deduplicated: "new chat" means a new thread. */
export async function createSession(agentId: string, title?: string): Promise<string> {
   const json: unknown = await apiFetch(base, {
      method: 'POST',
      body: JSON.stringify(title ? { agentId, title } : { agentId }),
   });
   return z.object({ id: z.string() }).parse(json).id;
}

const patchSession = (
   id: string,
   patch: { title?: string; pinned?: boolean; archived?: boolean }
) => apiFetch<void>(session(id), { method: 'PATCH', body: JSON.stringify(patch) });

export const renameSession = (id: string, title: string) => patchSession(id, { title });
export const setSessionPinned = (id: string, pinned: boolean) => patchSession(id, { pinned });
export const setSessionArchived = (id: string, archived: boolean) => patchSession(id, { archived });

export async function deleteSession(id: string): Promise<void> {
   await apiFetch(session(id), { method: 'DELETE' });
}

export async function markSessionRead(id: string): Promise<void> {
   await apiFetch(session(id, '/read'), { method: 'POST', body: '{}' });
}

export async function saveDraft(id: string, draft: string): Promise<void> {
   await apiFetch(session(id, '/draft'), { method: 'PUT', body: JSON.stringify({ draft }) });
}

/**
 * Queues the message as a task on the session's agent. The server answers 202
 * at once; a 503 AGENT_TASKS_UNAVAILABLE means the message was kept but no
 * agent can run it here.
 */
export async function sendMessage(id: string, body: string) {
   const json: unknown = await apiFetch(session(id, '/messages'), {
      method: 'POST',
      body: JSON.stringify({ body }),
   });
   return z
      .object({ messageId: z.string(), runId: z.string(), queued: z.literal(true) })
      .parse(json);
}

export async function listSessionTasks(id: string): Promise<ChatTask[]> {
   const json: unknown = await apiFetch(session(id, '/tasks'));
   return z.object({ nodes: z.array(taskSchema) }).parse(json).nodes;
}

export async function cancelSessionTask(id: string, runId: string): Promise<void> {
   await apiFetch(session(id, `/tasks/${encodeURIComponent(runId)}/cancel`), {
      method: 'POST',
      body: '{}',
   });
}

export async function prioritizeSessionTask(id: string, runId: string): Promise<void> {
   await apiFetch(session(id, `/tasks/${encodeURIComponent(runId)}/prioritize`), {
      method: 'POST',
      body: '{}',
   });
}

export async function listTaskEvents(id: string, runId: string): Promise<ChatTaskEvent[]> {
   const json: unknown = await apiFetch(session(id, `/tasks/${encodeURIComponent(runId)}/events`));
   return z.object({ nodes: z.array(taskEventSchema) }).parse(json).nodes;
}

export async function listSuggestions(agentId: string): Promise<ChatSuggestion[]> {
   const json: unknown = await apiFetch(
      `${base}/suggestions?agentId=${encodeURIComponent(agentId)}`
   );
   return z.object({ nodes: z.array(suggestionSchema) }).parse(json).nodes;
}

export async function getPinnedAgents(): Promise<string[]> {
   const json: unknown = await apiFetch(`${base}/pinned-agents`);
   return z.object({ agentIds: z.array(z.string()) }).parse(json).agentIds;
}

export async function setPinnedAgents(agentIds: string[]): Promise<string[]> {
   const json: unknown = await apiFetch(`${base}/pinned-agents`, {
      method: 'PUT',
      body: JSON.stringify({ agentIds }),
   });
   return z.object({ agentIds: z.array(z.string()) }).parse(json).agentIds;
}
