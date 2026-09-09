import { z } from 'zod';
import { apiFetch } from './api';
import { newIdempotencyKey } from './api-schemas';

/**
 * Workspace onboarding client helpers.
 *
 * These wrap the create / select / invitation-accept endpoints the onboarding
 * flow needs. They call Berry only through `apiFetch`, and the two mutating
 * POSTs carry a fresh `Idempotency-Key` exactly like the other creating calls
 * in `lib/*`. The server sets the creator's owner membership and the selected
 * workspace on create, so the client never has to.
 */

const workspaceSchema = z.object({
   id: z.string(),
   name: z.string(),
   slug: z.string(),
   description: z.string().nullable(),
   role: z.string(),
   createdAt: z.string(),
   updatedAt: z.string(),
});

const memberSchema = z.object({
   userId: z.string(),
   workspaceId: z.string(),
   role: z.string(),
   email: z.string(),
   name: z.string(),
   avatarUrl: z.string().nullable(),
   joinedAt: z.string(),
   updatedAt: z.string(),
});

export type WorkspaceSummary = z.infer<typeof workspaceSchema>;
export type AcceptedMembership = z.infer<typeof memberSchema>;

/**
 * Derive a workspace slug from a display name, matching the server bounds:
 * 2–50 lowercase letters, digits, or hyphens. A single leftover character is
 * padded so the minimum length always holds.
 */
export function slugFromWorkspaceName(name: string): string {
   const normalized = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);
   const slug = normalized || 'workspace';
   if (slug.length === 1) return `${slug}x`;
   return slug;
}

/** Create a workspace; the server records owner membership and selects it. */
export async function createWorkspace(input: {
   name: string;
   slug: string;
   description?: string;
}): Promise<WorkspaceSummary> {
   const body: Record<string, string> = { name: input.name, slug: input.slug };
   const description = input.description?.trim();
   if (description) body.description = description;

   const json: unknown = await apiFetch('/api/v1/workspaces', {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      body: JSON.stringify(body),
   });
   const parsed = workspaceSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Create workspace response was not recognized');
   }
   return parsed.data;
}

/** Set the caller's selected workspace; returns the selected workspace. */
export async function selectWorkspace(workspaceId: string): Promise<WorkspaceSummary> {
   const json: unknown = await apiFetch(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/select`,
      { method: 'POST', body: '' }
   );
   const parsed = workspaceSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Select workspace response was not recognized');
   }
   return parsed.data;
}

/** Accept a single-use invitation; returns the new membership. */
export async function acceptInvitation(
   invitationId: string,
   token: string
): Promise<AcceptedMembership> {
   const json: unknown = await apiFetch(
      `/api/v1/invitations/${encodeURIComponent(invitationId)}/accept`,
      {
         method: 'POST',
         headers: { 'Idempotency-Key': newIdempotencyKey() },
         body: JSON.stringify({ token }),
      }
   );
   const parsed = memberSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Accept invitation response was not recognized');
   }
   return parsed.data;
}
