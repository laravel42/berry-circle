import { z } from 'zod';
import { apiFetch } from './api';

/**
 * The AI agent builder: describe an agent in a few turns, preview each draft,
 * and create the agent from the one you pick.
 */

export const agentDraftSchema = z.object({
   name: z.string(),
   description: z.string(),
   instructions: z.string(),
   skills: z.array(z.string()),
   mcp: z.array(
      z.object({ name: z.string(), url: z.string(), transport: z.enum(['streamable_http', 'sse']) })
   ),
   model: z.string().nullable(),
});
export type AgentDraft = z.infer<typeof agentDraftSchema>;

const base = '/api/v1/agent-builder/sessions';

export async function startBuilderSession(): Promise<{ id: string }> {
   const json: unknown = await apiFetch(base, { method: 'POST', body: '{}' });
   return z.object({ id: z.string() }).parse(json);
}

export async function getBuilderSession(id: string) {
   const json: unknown = await apiFetch(`${base}/${encodeURIComponent(id)}`);
   return z
      .object({
         id: z.string(),
         status: z.enum(['drafting', 'applied', 'discarded']),
         appliedAgentId: z.string().nullable(),
         drafts: z.array(
            z.object({
               id: z.string(),
               turn: z.number(),
               prompt: z.string(),
               draft: agentDraftSchema,
            })
         ),
      })
      .parse(json);
}

/**
 * One turn of the builder.
 *
 * Takes a signal because drafting is the one call in this client that a person
 * waits on for several seconds, and "stop" has to mean the request is actually
 * abandoned rather than merely ignored when it lands.
 */
export async function sendBuilderTurn(id: string, prompt: string, signal?: AbortSignal) {
   const json: unknown = await apiFetch(`${base}/${encodeURIComponent(id)}/turns`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
      ...(signal ? { signal } : {}),
   });
   return z
      .object({ draftId: z.string(), draft: agentDraftSchema, unknownSkills: z.array(z.string()) })
      .parse(json);
}

export async function applyBuilderDraft(id: string, draftId: string): Promise<{ agentId: string }> {
   const json: unknown = await apiFetch(`${base}/${encodeURIComponent(id)}/apply`, {
      method: 'POST',
      body: JSON.stringify({ draftId }),
   });
   return z.object({ agentId: z.string() }).parse(json);
}

export async function discardBuilderSession(id: string): Promise<void> {
   await apiFetch(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
