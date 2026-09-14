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
   /** Optional so a server without the General-page fields still parses. */
   settings: z
      .object({
         issuePrefix: z.string(),
         defaultRole: z.string(),
         allowMemberInvites: z.boolean(),
      })
      .optional(),
   logoUrl: z.string().nullish(),
   agentContext: z.string().nullish(),
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

/**
 * Accept a single-use invitation; returns the new membership.
 *
 * The token comes from the invitation link. It is optional because an
 * invitation addressed to the signed-in account needs no further proof — the
 * server requires the invited address to be the caller's own — which is what
 * lets the invitations page accept several at once without holding tokens it
 * was never given.
 */
export async function acceptInvitation(
   invitationId: string,
   token: string | null = null
): Promise<AcceptedMembership> {
   const json: unknown = await apiFetch(
      `/api/v1/invitations/${encodeURIComponent(invitationId)}/accept`,
      {
         method: 'POST',
         headers: { 'Idempotency-Key': newIdempotencyKey() },
         body: JSON.stringify(token === null ? {} : { token }),
      }
   );
   const parsed = memberSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Accept invitation response was not recognized');
   }
   return parsed.data;
}

// ------------------------------------------------------ workspace settings

const workspacePath = (workspaceId: string) =>
   `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`;

function parseWorkspace(json: unknown): WorkspaceSummary {
   const parsed = workspaceSchema.safeParse(json);
   if (!parsed.success) throw new Error('Workspace response was not recognized');
   return parsed.data;
}

export async function loadWorkspace(workspaceId: string): Promise<WorkspaceSummary> {
   return parseWorkspace(await apiFetch(workspacePath(workspaceId)));
}

/** A null clears that field; omitting it leaves what is there. */
export async function updateWorkspace(
   workspaceId: string,
   patch: {
      name?: string;
      description?: string | null;
      logoUrl?: string | null;
      agentContext?: string | null;
   }
): Promise<WorkspaceSummary> {
   return parseWorkspace(
      await apiFetch(workspacePath(workspaceId), {
         method: 'PATCH',
         body: JSON.stringify(patch),
      })
   );
}

const workspaceSettingsSchema = z.object({
   issuePrefix: z.string(),
   defaultRole: z.string(),
   allowMemberInvites: z.boolean(),
});

export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

/**
 * Changes a workspace setting.
 *
 * `issuePrefix` is the one that is never quietly saved: issue identifiers are
 * derived from it, so every task reference in the workspace changes the moment
 * this returns. The caller confirms first.
 */
export async function updateWorkspaceSettings(
   workspaceId: string,
   patch: { issuePrefix?: string; defaultRole?: string; allowMemberInvites?: boolean }
): Promise<WorkspaceSettings> {
   const json: unknown = await apiFetch(`${workspacePath(workspaceId)}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
   });
   const parsed = workspaceSettingsSchema.safeParse(json);
   if (!parsed.success) throw new Error('Workspace settings response was not recognized');
   return parsed.data;
}

/** The caller removes their own membership. A sole owner is refused (409). */
export async function leaveWorkspace(workspaceId: string): Promise<void> {
   await apiFetch(`${workspacePath(workspaceId)}/leave`, { method: 'POST', body: '' });
}

/** Owner only. Soft-deletes the workspace for everyone in it. */
export async function deleteWorkspace(workspaceId: string): Promise<void> {
   await apiFetch(workspacePath(workspaceId), { method: 'DELETE' });
}

const memberRoleSchema = z.object({
   userId: z.string(),
   role: z.string(),
   name: z.string(),
   email: z.string(),
   avatarUrl: z.string().nullable(),
   joinedAt: z.string(),
});

export type WorkspaceMemberRole = z.infer<typeof memberRoleSchema>;

/**
 * Members with their real roles.
 *
 * `lib/members.ts` maps a member onto the template's `User`, which collapses
 * owner and viewer into "Member" — fine for an avatar list, useless for
 * deciding whether someone is the last owner.
 */
const topAgentSchema = z.object({
   agentId: z.string(),
   name: z.string(),
   runCount: z.number(),
});
export type TopAgent = z.infer<typeof topAgentSchema>;

/**
 * The agents that turn up most on one member's work.
 *
 * `runs` records the agent and the task and never who asked for the run, so
 * the server answers this through the tasks the person filed or holds. An
 * empty list is a real answer — nothing has run on their work — and a 404 is
 * the guard's, for a member or a workspace the caller cannot see.
 */
export async function loadMemberTopAgents(
   workspaceId: string,
   memberId: string
): Promise<TopAgent[]> {
   const json: unknown = await apiFetch(
      `${workspacePath(workspaceId)}/members/${encodeURIComponent(memberId)}/top-agents`
   );
   const parsed = z.object({ nodes: z.array(topAgentSchema) }).safeParse(json);
   if (!parsed.success) throw new Error('Top agents response was not recognized');
   return parsed.data.nodes;
}

export async function listWorkspaceMemberRoles(
   workspaceId: string
): Promise<WorkspaceMemberRole[]> {
   const collected: WorkspaceMemberRole[] = [];
   let after: string | undefined;
   for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ first: '100' });
      if (after) params.set('after', after);
      const json: unknown = await apiFetch(`${workspacePath(workspaceId)}/members?${params}`);
      const parsed = z
         .object({
            nodes: z.array(memberRoleSchema),
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
         })
         .safeParse(json);
      if (!parsed.success) throw new Error('Member list was not recognized');
      collected.push(...parsed.data.nodes);
      const { hasNextPage, endCursor } = parsed.data.pageInfo;
      if (!hasNextPage || !endCursor || parsed.data.nodes.length === 0) break;
      after = endCursor;
   }
   return collected;
}

/** The roles a workspace membership can hold, strongest first. */
export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * Changes one member's role.
 *
 * The rules are the server's and are not re-implemented here: only an owner
 * may grant or touch owner and admin, and the last owner cannot be demoted
 * (409 `LAST_OWNER_REQUIRED`). The page disables what it knows will be
 * refused, and reports what it does not.
 */
export async function updateMemberRole(
   workspaceId: string,
   userId: string,
   role: WorkspaceRole
): Promise<WorkspaceMemberRole> {
   const json: unknown = await apiFetch(
      `${workspacePath(workspaceId)}/members/${encodeURIComponent(userId)}`,
      { method: 'PATCH', body: JSON.stringify({ role }) }
   );
   const parsed = memberRoleSchema.safeParse(json);
   if (!parsed.success) throw new Error('Member response was not recognized');
   return parsed.data;
}

export async function removeMember(workspaceId: string, userId: string): Promise<void> {
   await apiFetch(`${workspacePath(workspaceId)}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
   });
}

// ---------------------------------------------------------------- invitations

const invitationSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   /** Carried on the invitation: an invitee cannot look a workspace up yet. */
   workspaceName: z.string().nullish(),
   email: z.string(),
   role: z.string(),
   invitedBy: z.string().nullish(),
   expiresAt: z.string(),
   acceptedAt: z.string().nullable(),
   revokedAt: z.string().nullable(),
   createdAt: z.string(),
});

export type WorkspaceInvitation = z.infer<typeof invitationSchema>;

/** Invitations for this workspace. Needs `invitations.read`. */
export async function listWorkspaceInvitations(
   workspaceId: string
): Promise<WorkspaceInvitation[]> {
   const json: unknown = await apiFetch(`${workspacePath(workspaceId)}/invitations?first=100`);
   const parsed = z.object({ nodes: z.array(invitationSchema) }).safeParse(json);
   if (!parsed.success) throw new Error('Invitation list was not recognized');
   return parsed.data.nodes;
}

/**
 * Invites an address, and hands back the token once.
 *
 * Berry sends no mail, so the token in this response is the only way the
 * invitation can reach the person it names — the server keeps a hash and will
 * never show it again. A caller that drops it has to revoke and re-invite.
 */
export async function createWorkspaceInvitation(
   workspaceId: string,
   input: { email: string; role: 'admin' | 'member' | 'viewer' }
): Promise<{ invitation: WorkspaceInvitation; token: string | null }> {
   const json: unknown = await apiFetch(`${workspacePath(workspaceId)}/invitations`, {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      body: JSON.stringify(input),
   });
   const parsed = z
      .object({ invitation: invitationSchema, token: z.string().optional() })
      .safeParse(json);
   if (!parsed.success) throw new Error('Invitation response was not recognized');
   return { invitation: parsed.data.invitation, token: parsed.data.token ?? null };
}

/**
 * The invitations waiting for the signed-in account.
 *
 * The server returns only what is still open, unexpired, unrevoked and
 * addressed to this account, so anything absent from it is something there is
 * nothing useful to say about.
 */
export async function listMyInvitations(): Promise<WorkspaceInvitation[]> {
   const json: unknown = await apiFetch('/api/v1/invitations?first=100');
   const parsed = z.object({ nodes: z.array(invitationSchema) }).safeParse(json);
   if (!parsed.success) throw new Error('Invitation list was not recognized');
   return parsed.data.nodes;
}

export async function revokeWorkspaceInvitation(
   workspaceId: string,
   invitationId: string
): Promise<void> {
   await apiFetch(`${workspacePath(workspaceId)}/invitations/${encodeURIComponent(invitationId)}`, {
      method: 'DELETE',
   });
}
