import { z } from 'zod';
import { apiFetch } from './api';

/**
 * Squads: agents and people under one leader agent. Giving an issue to a squad
 * assigns it to the leader, who delegates to the members.
 */

export const squadMemberSchema = z.object({
   type: z.enum(['agent', 'user']),
   id: z.string(),
   name: z.string(),
   role: z.string(),
   /** An agent's own status; `'person'` for a member who is one. */
   status: z.string().default('unknown'),
   /** Tasks assigned to this member that are neither done nor cancelled. */
   openIssues: z.number().default(0),
   /** An agent's last run. People have none: Berry does not track their presence. */
   lastActiveAt: z.string().nullable().default(null),
});
export type SquadMember = z.infer<typeof squadMemberSchema>;

export const squadSchema = z.object({
   id: z.string(),
   name: z.string(),
   description: z.string(),
   /** The standing brief the leader carries into every delegation. */
   instructions: z.string().default(''),
   avatarUrl: z.string().nullable().default(null),
   leaderAgentId: z.string(),
   members: z.array(squadMemberSchema),
   createdBy: z.string().nullable().default(null),
   archivedAt: z.string().nullable(),
   createdAt: z.string(),
   updatedAt: z.string(),
});
export type Squad = z.infer<typeof squadSchema>;

export interface SquadRosterEntry {
   type: 'agent' | 'user';
   id: string;
   role: string;
}

export interface SquadDraft {
   name: string;
   description: string;
   leaderAgentId: string;
   instructions?: string;
   avatarUrl?: string | null;
   /** The roster to start with; written with the squad or not at all. */
   members?: SquadRosterEntry[];
}

const path = (id = '', rest = '') =>
   `/api/v1/squads${id ? `/${encodeURIComponent(id)}` : ''}${rest}`;

export async function listSquads(): Promise<Squad[]> {
   return z.object({ nodes: z.array(squadSchema) }).parse(await apiFetch(path())).nodes;
}

export const getSquad = async (id: string) => squadSchema.parse(await apiFetch(path(id)));

export const createSquad = async (input: SquadDraft) =>
   squadSchema.parse(await apiFetch(path(), { method: 'POST', body: JSON.stringify(input) }));

export const updateSquad = async (
   id: string,
   patch: Partial<{
      name: string;
      description: string;
      instructions: string;
      avatarUrl: string | null;
      leaderAgentId: string;
   }>
) => squadSchema.parse(await apiFetch(path(id), { method: 'PATCH', body: JSON.stringify(patch) }));

export async function archiveSquad(id: string): Promise<void> {
   await apiFetch(path(id), { method: 'DELETE' });
}

/** Replaces the whole roster. */
export const setSquadMembers = async (id: string, members: SquadRosterEntry[]) =>
   squadSchema.parse(
      await apiFetch(path(id, '/members'), { method: 'PUT', body: JSON.stringify({ members }) })
   );

/** Gives an issue (by key or id) to the squad: its leader becomes the assignee and is queued. */
export async function assignIssueToSquad(squadId: string, issueRef: string) {
   const json: unknown = await apiFetch(path(squadId, '/assign'), {
      method: 'POST',
      body: JSON.stringify({ issueRef }),
   });
   return z
      .object({ issueId: z.string(), leaderAgentId: z.string(), runId: z.string().nullable() })
      .parse(json);
}
