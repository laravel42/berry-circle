import { z } from 'zod';
import { apiFetch } from './api';
import { parseResponse } from './parse-response';

const actionSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   name: z.string(),
   description: z.string().nullable(),
   targetAgentId: z.string(),
   prompt: z.string(),
   visibility: z.enum(['private', 'workspace']),
   createdBy: z.string(),
   createdAt: z.string(),
   updatedAt: z.string(),
});
export type QuickAction = z.infer<typeof actionSchema>;

const base = (workspaceId: string) => `/api/v1/catalogs/${encodeURIComponent(workspaceId)}/quick-actions`;

export async function loadQuickActions(workspaceId: string): Promise<QuickAction[]> {
   return parseResponse(z.object({ nodes: z.array(actionSchema) }), await apiFetch(base(workspaceId)), 'Quick actions').nodes;
}

export async function createQuickAction(
   workspaceId: string,
   input: { name: string; targetAgentId: string; prompt: string; visibility: 'private' | 'workspace' }
): Promise<QuickAction> {
   return parseResponse(actionSchema, await apiFetch(base(workspaceId), { method: 'POST', body: JSON.stringify(input) }), 'Quick action');
}

export async function archiveQuickAction(workspaceId: string, actionId: string): Promise<void> {
   await apiFetch(`${base(workspaceId)}/${encodeURIComponent(actionId)}`, { method: 'DELETE' });
}
