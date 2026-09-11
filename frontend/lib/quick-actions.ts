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
   /** Optional so a server without the usage columns still parses. */
   useCount: z.number().optional(),
   lastUsedAt: z.string().nullish(),
   archivedAt: z.string().nullish(),
});
export type QuickAction = z.infer<typeof actionSchema>;

/**
 * The template variables Berry fills when an action runs, mirroring the
 * server's own list so the form can refuse one it cannot fill while the author
 * is still there to fix it.
 */
export const FILLABLE_VARIABLES = ['issue.identifier', 'issue.title', 'issue.description'];

/** The variables in a prompt that Berry has no value for, in order. */
export function unfillableVariables(prompt: string): string[] {
   const unknown: string[] = [];
   for (const match of prompt.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
      const name = match[1] ?? '';
      if (!FILLABLE_VARIABLES.includes(name) && !unknown.includes(name)) unknown.push(name);
   }
   return unknown;
}

/** A quick action nobody has run in this long is flagged as stale. */
export const STALE_AFTER_DAYS = 90;

export function isStale(action: QuickAction, now = Date.now()): boolean {
   const last = action.lastUsedAt ?? action.createdAt;
   return now - new Date(last).getTime() > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

const base = (workspaceId: string) =>
   `/api/v1/catalogs/${encodeURIComponent(workspaceId)}/quick-actions`;

export async function loadQuickActions(
   workspaceId: string,
   includeArchived = false
): Promise<QuickAction[]> {
   const query = includeArchived ? '?includeArchived=true' : '';
   return parseResponse(
      z.object({ nodes: z.array(actionSchema) }),
      await apiFetch(`${base(workspaceId)}${query}`),
      'Quick actions'
   ).nodes;
}

export async function updateQuickAction(
   workspaceId: string,
   actionId: string,
   patch: {
      name?: string;
      description?: string | null;
      targetAgentId?: string;
      prompt?: string;
      visibility?: 'private' | 'workspace';
      /** `false` restores an archived action; archiving is `archiveQuickAction`. */
      archived?: false;
   }
): Promise<QuickAction> {
   return parseResponse(
      actionSchema,
      await apiFetch(`${base(workspaceId)}/${encodeURIComponent(actionId)}`, {
         method: 'PATCH',
         body: JSON.stringify(patch),
      }),
      'Quick action'
   );
}

/** Removes an archived action for good. An action still in use is refused. */
export async function deleteQuickAction(workspaceId: string, actionId: string): Promise<void> {
   await apiFetch(`${base(workspaceId)}/${encodeURIComponent(actionId)}/delete`, {
      method: 'POST',
      body: '',
   });
}

export async function createQuickAction(
   workspaceId: string,
   input: {
      name: string;
      targetAgentId: string;
      prompt: string;
      visibility: 'private' | 'workspace';
   }
): Promise<QuickAction> {
   return parseResponse(
      actionSchema,
      await apiFetch(base(workspaceId), { method: 'POST', body: JSON.stringify(input) }),
      'Quick action'
   );
}

export async function archiveQuickAction(workspaceId: string, actionId: string): Promise<void> {
   await apiFetch(`${base(workspaceId)}/${encodeURIComponent(actionId)}`, { method: 'DELETE' });
}
