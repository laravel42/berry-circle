import { z } from 'zod';
import type { Queryable } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';

/**
 * Free key/value pairs on an issue, for agents and integrations. Scalars only,
 * so a filter or a UI can show any value without knowing its producer.
 */
const KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
export const MAX_METADATA_KEYS = 50;

export const metadataPatchSchema = z
   .object({
      set: z
         .record(z.string().regex(KEY), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))
         .optional(),
      remove: z.array(z.string().regex(KEY)).max(MAX_METADATA_KEYS).optional(),
   })
   .strict()
   .refine((value) => value.set !== undefined || value.remove !== undefined, {
      message: 'Provide set or remove.',
   });
export type MetadataPatch = z.infer<typeof metadataPatchSchema>;

export class MetadataTooLarge extends Error {
   constructor() {
      super('issue metadata is too large');
      this.name = 'MetadataTooLarge';
   }
}

export async function readMetadata(q: Queryable, issueId: string): Promise<Record<string, unknown>> {
   const [row] = await q`SELECT metadata FROM issues WHERE id = ${issueId} AND deleted_at IS NULL`;
   if (!row) throw new NotFound();
   return row.metadata as Record<string, unknown>;
}

/** Run inside a transaction: a refused key count rolls the merge back. */
export async function patchMetadata(
   q: Queryable,
   issueId: string,
   patch: MetadataPatch
): Promise<Record<string, unknown>> {
   const rows = await q`
      UPDATE issues
         SET metadata = (metadata - ${patch.remove ?? []}::text[]) || ${q.json((patch.set ?? {}) as never)}::jsonb,
             updated_at = now()
       WHERE id = ${issueId} AND deleted_at IS NULL
      RETURNING metadata`.catch((error: unknown) => {
      if ((error as { code?: string }).code === '23514') throw new MetadataTooLarge();
      throw error;
   });
   const [row] = rows;
   if (!row) throw new NotFound();
   const metadata = row.metadata as Record<string, unknown>;
   if (Object.keys(metadata).length > MAX_METADATA_KEYS) throw new MetadataTooLarge();
   return metadata;
}
