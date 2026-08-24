import { z } from 'zod';
import { apiFetch } from './api';
import { connectionSchema, newIdempotencyKey } from './api-schemas';
import { BOARD_ID } from './config';

const boardSchema = z.object({
   id: z.string(),
   name: z.string(),
   slug: z.string(),
   description: z.string().nullable(),
   createdAt: z.string().optional(),
   updatedAt: z.string().optional(),
});

const boardConnectionSchema = connectionSchema(boardSchema);

export type BoardSummary = z.infer<typeof boardSchema>;

export type CreateBoardBody = {
   name: string;
   slug: string;
   description?: string;
};

/** Derive a board slug from a display name (matches server validation bounds). */
export function slugFromBoardName(name: string): string {
   const normalized = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 12);
   const slug = normalized || 'board';
   if (slug.length === 1) return `${slug}x`;
   return slug;
}

async function fetchBoardPage(after?: string): Promise<{ boards: BoardSummary[]; nextCursor?: string }> {
   const params = new URLSearchParams({ first: '100' });
   if (after) params.set('after', after);

   const json: unknown = await apiFetch(`/api/v1/boards?${params.toString()}`);
   const parsed = boardConnectionSchema.safeParse(json);
   if (!parsed.success) return { boards: [] };

   const { hasNextPage, endCursor } = parsed.data.pageInfo;
   return {
      boards: parsed.data.nodes,
      nextCursor: hasNextPage && endCursor ? endCursor : undefined,
   };
}

export async function listBoards(): Promise<BoardSummary[]> {
   const collected: BoardSummary[] = [];
   try {
      let after: string | undefined;
      for (let page = 0; page < 20; page += 1) {
         const batch = await fetchBoardPage(after);
         collected.push(...batch.boards);
         if (!batch.nextCursor) break;
         after = batch.nextCursor;
      }
      return collected;
   } catch {
      return collected;
   }
}

export async function createBoard(body: CreateBoardBody): Promise<BoardSummary> {
   const json: unknown = await apiFetch('/api/v1/boards', {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      body: JSON.stringify(body),
   });
   const parsed = boardSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Create board response was not recognized');
   }
   return parsed.data;
}

/** Env override wins; otherwise the first board the session can see. */
export function selectBoardId(boards: BoardSummary[]): string | null {
   return BOARD_ID || boards[0]?.id || null;
}
