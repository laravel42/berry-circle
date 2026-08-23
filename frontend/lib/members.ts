import type { User } from '@/data/users';
import { z } from 'zod';
import { apiFetch } from './api';
import { connectionSchema } from './api-schemas';

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

const memberConnectionSchema = connectionSchema(memberSchema);

function roleToUi(role: string): User['role'] {
   switch (role.toLowerCase()) {
      case 'admin':
         return 'Admin';
      case 'guest':
         return 'Guest';
      default:
         return 'Member';
   }
}

export function toUiMember(member: z.infer<typeof memberSchema>): User {
   return {
      id: member.userId,
      name: member.name,
      avatarUrl: member.avatarUrl ?? '',
      email: member.email,
      status: 'offline',
      role: roleToUi(member.role),
      joinedDate: member.joinedAt.slice(0, 10),
      teamIds: [],
      timezone: 'UTC',
   };
}

export async function loadWorkspaceMembers(workspaceId: string): Promise<User[]> {
   if (!workspaceId) return [];
   const collected: User[] = [];
   try {
      let after: string | undefined;
      for (let page = 0; page < 20; page += 1) {
         const params = new URLSearchParams({ first: '100' });
         if (after) params.set('after', after);
         const json: unknown = await apiFetch(
            `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members?${params.toString()}`
         );
         const parsed = memberConnectionSchema.safeParse(json);
         if (!parsed.success) break;
         for (const node of parsed.data.nodes) {
            collected.push(toUiMember(node));
         }
         const { hasNextPage, endCursor } = parsed.data.pageInfo;
         if (!hasNextPage || !endCursor || parsed.data.nodes.length === 0) break;
         after = endCursor;
      }
      return collected;
   } catch {
      return collected;
   }
}
