import { z } from 'zod';
import { apiFetch } from './api';
import { newIdempotencyKey } from './api-schemas';

/**
 * The invitations waiting for the signed-in account.
 *
 * `/api/v1/invitations` already lists them, but joining from a list is not the
 * same act as joining from an emailed link: the link carries the token, and a
 * list deliberately does not. `/pending` therefore answers with the workspace's
 * name beside each invitation, and `join` accepts on the strength of the
 * session alone — the invitation is addressed to this account's own address,
 * which is the same fact that put it in the list.
 */

const pendingInvitationSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   workspaceName: z.string(),
   role: z.string(),
   expiresAt: z.string(),
   createdAt: z.string(),
});

export type PendingInvitation = z.infer<typeof pendingInvitationSchema>;

const pendingSchema = z.object({ nodes: z.array(pendingInvitationSchema) });

/** Empty rather than throwing: a switcher must open even if this call fails. */
export async function loadPendingInvitations(): Promise<PendingInvitation[]> {
   try {
      const json: unknown = await apiFetch('/api/v1/invitations/pending');
      const parsed = pendingSchema.safeParse(json);
      return parsed.success ? parsed.data.nodes : [];
   } catch {
      return [];
   }
}

/** Accept an invitation addressed to this account. */
export async function joinInvitation(invitationId: string): Promise<void> {
   await apiFetch(`/api/v1/invitations/${encodeURIComponent(invitationId)}/join`, {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      body: JSON.stringify({}),
   });
}

/** Turn one down. It stops being offered, here and everywhere else. */
export async function declineInvitation(invitationId: string): Promise<void> {
   await apiFetch(`/api/v1/invitations/${encodeURIComponent(invitationId)}/decline`, {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      body: JSON.stringify({}),
   });
}
