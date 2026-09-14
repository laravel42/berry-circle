import { zodResolver } from '@hookform/resolvers/zod';
import type { FieldValues, Resolver } from 'react-hook-form';
import type { z } from 'zod';

/**
 * `zodResolver` typed for this workspace's version pair.
 *
 * The frontend is on Zod 3 (`zod@3.25`), while `@hookform/resolvers@4` types
 * its `zodResolver` against Zod 4's schema shape. The two are runtime-
 * compatible — the resolver validates a Zod 3 schema correctly — but their
 * `.d.ts` types do not line up nominally, so a direct `zodResolver(schema)`
 * call fails typecheck at the argument boundary.
 *
 * This wrapper is the single, documented seam that reconciles them: it takes a
 * real Zod 3 object schema, produces the resolver, and returns it as the
 * `Resolver<Values>` that `useForm` expects. Keeping the cast here means the
 * form pages stay clean and there is one place to delete when the frontend
 * finishes its Zod 4 migration and the versions agree again.
 */
export function zodFormResolver<Values extends FieldValues>(
   schema: z.ZodType<Values>
): Resolver<Values> {
   return zodResolver(schema as never) as Resolver<Values>;
}
