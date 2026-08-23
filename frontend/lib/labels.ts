import type { LabelInterface } from '@/data/labels';
import { z } from 'zod';
import { apiFetch } from './api';
import { connectionSchema } from './api-schemas';

const labelSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   name: z.string(),
   description: z.string().nullish(),
   color: z.string(),
   createdAt: z.string(),
   updatedAt: z.string(),
   archivedAt: z.string().nullish(),
});

const labelConnectionSchema = connectionSchema(labelSchema);

export function toUiLabel(label: z.infer<typeof labelSchema>): LabelInterface {
   return {
      id: label.id,
      name: label.name,
      color: label.color,
   };
}

export async function loadWorkspaceLabels(workspaceId: string): Promise<LabelInterface[]> {
   if (!workspaceId) return [];
   const collected: LabelInterface[] = [];
   try {
      let after: string | undefined;
      for (let page = 0; page < 20; page += 1) {
         const params = new URLSearchParams({ first: '100' });
         if (after) params.set('after', after);
         const json: unknown = await apiFetch(
            `/api/v1/catalogs/${encodeURIComponent(workspaceId)}/issue-labels?${params.toString()}`
         );
         const parsed = labelConnectionSchema.safeParse(json);
         if (!parsed.success) break;
         for (const node of parsed.data.nodes) {
            if (node.archivedAt) continue;
            collected.push(toUiLabel(node));
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
