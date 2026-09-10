import { z } from 'zod';
import { apiFetch } from './api';
import { connectionSchema } from './api-schemas';

const entrySchema = z.object({
   id: z.string(),
   type: z.string(),
   occurredAt: z.string(),
   actor: z
      .object({ type: z.string(), id: z.string(), name: z.string().nullable(), avatarUrl: z.string().nullable() })
      .nullable(),
   changedFields: z.array(z.string()),
   previousStatus: z.string().nullable(),
   status: z.string().nullable(),
   commentId: z.string().nullable(),
   details: z.record(z.unknown()),
});
export type ActivityEntry = z.infer<typeof entrySchema>;
const pageSchema = connectionSchema(entrySchema);

export async function loadIssueActivity(issueRef: string): Promise<ActivityEntry[]> {
   const collected: ActivityEntry[] = [];
   let after: string | undefined;
   for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ first: '100' });
      if (after) params.set('after', after);
      const parsed = pageSchema.safeParse(
         await apiFetch(`/api/v1/issues/${encodeURIComponent(issueRef)}/activity?${params.toString()}`)
      );
      if (!parsed.success) throw new Error('Activity response was not recognized');
      collected.push(...parsed.data.nodes);
      if (!parsed.data.pageInfo.hasNextPage || !parsed.data.pageInfo.endCursor) break;
      after = parsed.data.pageInfo.endCursor;
   }
   return collected;
}

/** One line for a timeline row; null for events the feed shows another way. */
export function describeActivity(entry: ActivityEntry): { event: string; text: string } | null {
   switch (entry.type) {
      case 'issue.created':
         return { event: 'created', text: 'created the task' };
      case 'issue.updated':
         if (entry.previousStatus && entry.status && entry.previousStatus !== entry.status) {
            return { event: 'status', text: `moved from ${entry.previousStatus} to ${entry.status}` };
         }
         return entry.changedFields.length > 0
            ? { event: 'created', text: `changed ${entry.changedFields.join(', ')}` }
            : null;
      case 'issue.properties.changed':
         return { event: 'label', text: 'changed a field' };
      case 'issue.hierarchy.changed':
         return { event: 'related', text: 'changed sub-tasks' };
      case 'comment.resolved':
         return { event: 'unblocked', text: 'resolved a thread' };
      case 'comment.unresolved':
         return { event: 'blocked', text: 'reopened a thread' };
      default:
         return null;
   }
}
