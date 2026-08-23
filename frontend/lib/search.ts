import { z } from 'zod';
import { apiFetch } from './api';
import { connectionSchema } from './api-schemas';

const searchResultSchema = z.object({
   type: z.enum(['board', 'issue']),
   id: z.string(),
   title: z.string(),
   subtitle: z.string().nullable(),
   identifier: z.string().nullable(),
   boardId: z.string().nullable(),
});

const searchConnectionSchema = connectionSchema(searchResultSchema);

export type SearchResult = z.infer<typeof searchResultSchema>;

export async function searchWorkspace(
   workspaceId: string,
   query: string,
   types: Array<'board' | 'issue'> = ['issue']
): Promise<SearchResult[]> {
   const trimmed = query.trim();
   if (!workspaceId || trimmed.length < 1) return [];
   try {
      const params = new URLSearchParams({
         workspaceId,
         query: trimmed,
         types: types.join(','),
         first: '25',
      });
      const json: unknown = await apiFetch(`/api/v1/search?${params.toString()}`);
      const parsed = searchConnectionSchema.safeParse(json);
      if (!parsed.success) return [];
      return parsed.data.nodes;
   } catch {
      return [];
   }
}
