import { z } from 'zod';
import { apiFetch } from './api';
import { connectionSchema } from './api-schemas';

/** Every type `/api/v1/search` answers for. */
export const SEARCH_TYPES = ['issue', 'board', 'project', 'agent', 'chat', 'skill'] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

/** What the palette asks for. Boards are left out: a board has no page to open. */
export const PALETTE_SEARCH_TYPES: SearchType[] = ['issue', 'project', 'agent', 'chat', 'skill'];

const searchResultSchema = z.object({
   type: z.enum(SEARCH_TYPES),
   id: z.string(),
   title: z.string(),
   subtitle: z.string().nullable(),
   identifier: z.string().nullable(),
   boardId: z.string().nullable(),
   // Additive on the server; defaulted so an older server's answer still parses.
   agentId: z.string().nullable().default(null),
   /** API `IssueStatus` on an issue row; null on everything else. */
   status: z.string().nullable().default(null),
});

const searchConnectionSchema = connectionSchema(searchResultSchema);

export type SearchResult = z.infer<typeof searchResultSchema>;

export async function searchWorkspace(
   workspaceId: string,
   query: string,
   types: SearchType[] = ['issue'],
   limit = 25
): Promise<SearchResult[]> {
   const trimmed = query.trim();
   if (!workspaceId || trimmed.length < 1) return [];
   try {
      const params = new URLSearchParams({
         workspaceId,
         query: trimmed,
         types: types.join(','),
         first: String(limit),
      });
      const json: unknown = await apiFetch(`/api/v1/search?${params.toString()}`);
      const parsed = searchConnectionSchema.safeParse(json);
      if (!parsed.success) return [];
      return parsed.data.nodes;
   } catch {
      return [];
   }
}

/** The API status a cancelled task carries. */
const CANCELLED_STATUS = 'cancelled';

/** True for a task nobody is going to work on, which the palette groups apart. */
export function isCancelledResult(result: SearchResult): boolean {
   return result.type === 'issue' && result.status === CANCELLED_STATUS;
}

/**
 * Split a title around the part that matched, so a result can show *why* it
 * matched. Three pieces — before, hit, after — rather than markup, because the
 * caller is the one that knows how a highlight should look.
 *
 * Case-insensitive and literal: the server matched with ILIKE on the raw
 * string, so highlighting anything cleverer here would mark text the server
 * did not actually match on.
 */
export function highlightParts(text: string, query: string): [string, string, string] {
   const needle = query.trim();
   if (!needle) return [text, '', ''];
   const at = text.toLowerCase().indexOf(needle.toLowerCase());
   if (at === -1) return [text, '', ''];
   return [text.slice(0, at), text.slice(at, at + needle.length), text.slice(at + needle.length)];
}

/**
 * Where a result opens, relative to `/{orgId}`. Null when it has no page of
 * its own. The one place a result type is mapped to a route, so a page that
 * moves is fixed here rather than in every caller.
 */
export function searchResultHref(result: SearchResult): string | null {
   switch (result.type) {
      case 'issue':
         return result.identifier ? `/issue/${result.identifier}` : null;
      case 'project':
         return `/project/${result.id}/overview`;
      case 'agent':
         return `/agents/${result.id}`;
      case 'chat':
         return result.agentId ? `/chat?agent=${encodeURIComponent(result.agentId)}` : '/chat';
      case 'skill':
         return `/skills/${result.id}`;
      case 'board':
         return null;
   }
}
