import { z } from 'zod';
import { apiFetch } from './api';
import { parseResponse } from './parse-response';

const linkSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   role: z.string(),
   expiresAt: z.string().nullable(),
   maxUses: z.number().nullable(),
   useCount: z.number(),
   revokedAt: z.string().nullable(),
   createdAt: z.string(),
   createdBy: z.string(),
});
export type JoinLink = z.infer<typeof linkSchema>;

const base = (workspaceId: string) => `/api/v1/catalogs/${encodeURIComponent(workspaceId)}/join-links`;

export async function loadJoinLinks(workspaceId: string): Promise<JoinLink[]> {
   return parseResponse(z.object({ nodes: z.array(linkSchema) }), await apiFetch(base(workspaceId)), 'Join links').nodes;
}

/** The token is returned once; the caller shows it now or never. */
export async function createJoinLink(
   workspaceId: string,
   input: { role: 'admin' | 'member' | 'viewer'; expiresInDays?: number; maxUses?: number }
): Promise<JoinLink & { token: string }> {
   return parseResponse(
      linkSchema.extend({ token: z.string() }),
      await apiFetch(base(workspaceId), { method: 'POST', body: JSON.stringify(input) }),
      'Join link'
   );
}

export async function revokeJoinLink(workspaceId: string, linkId: string): Promise<void> {
   await apiFetch(`${base(workspaceId)}/${encodeURIComponent(linkId)}`, { method: 'DELETE' });
}

export async function lookupJoinLink(
   token: string
): Promise<{ workspace: { id: string; name: string }; role: string; expiresAt: string | null }> {
   return parseResponse(
      z.object({ workspace: z.object({ id: z.string(), name: z.string() }), role: z.string(), expiresAt: z.string().nullable() }),
      await apiFetch(`/api/v1/join-links/${encodeURIComponent(token)}`),
      'Join link'
   );
}

export async function acceptJoinLink(token: string): Promise<{ workspaceId: string; role: string; joined: boolean }> {
   return parseResponse(
      z.object({ workspaceId: z.string(), role: z.string(), joined: z.boolean() }),
      await apiFetch(`/api/v1/join-links/${encodeURIComponent(token)}/accept`, { method: 'POST' }),
      'Join'
   );
}

export function joinLinkUrl(token: string): string {
   return `${window.location.origin}/join/${encodeURIComponent(token)}`;
}
