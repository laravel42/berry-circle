import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import { idempotent } from '../http/idempotent.ts';
import type { IdempotencyStore } from '../http/idempotency.ts';
import type { Mount } from '../http/registry.ts';
import { Conflict, NotFound } from '../identity/errors.ts';
import type { SkillRepository, SkillWithFiles } from '../skills/repository.ts';
import { currentWorkspace, pathId, resolveScoped } from './shared.ts';
import { readJson } from './zod-body.ts';

const fileSchema = z.strictObject({
   path: z
      .string()
      .max(255)
      .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
      .refine((p) => !p.split('/').includes('..'), 'path may not contain ..'),
   content: z.string().max(262_144),
});
export const skillInputSchema = z.strictObject({
   name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
   description: z.string().max(1024).default(''),
   content: z.string().max(262_144).default(''),
   labels: z.array(z.string().min(1).max(40)).max(20).default([]),
   files: z.array(fileSchema).max(100).default([]),
});
const patchSchema = skillInputSchema.partial();
const bindingSchema = z.strictObject({ enabled: z.boolean() });

export interface SkillMountOptions {
   sessions: SessionService;
   sql: Sql;
   skills: SkillRepository;
   idempotency?: IdempotencyStore;
   /** Task 3. */
   importer?: unknown;
}

export function skillMounts(options: SkillMountOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { skills, sql } = options;
   // Idempotency is optional in tests; without a store, POST simply passes through.
   const creating: MiddlewareHandler = options.idempotency
      ? idempotent(options.idempotency)
      : async (_context, next) => {
           await next();
        };

   const scope = async (user: { id: string; currentWorkspaceId: string | null }, write: boolean) =>
      resolveScoped(sql, user.id, currentWorkspace(user.currentWorkspaceId), write ? 'product.write' : 'product.read');

   route.get('/', async (context) => {
      const scoped = await scope(context.get('user'), false);
      const url = new URL(context.req.url);
      const agentId = url.searchParams.get('agentId');
      const nodes = await skills.list(scoped.ctx.workspaceId, {
         ...(url.searchParams.get('q') ? { query: url.searchParams.get('q') as string } : {}),
         ...(url.searchParams.get('label') ? { label: url.searchParams.get('label') as string } : {}),
         ...(agentId ? { agentId: pathId(agentId, 'Agent') } : {}),
      });
      return json({ nodes });
   });

   route.post('/', creating, async (context) => {
      const scoped = await scope(context.get('user'), true);
      const input = await readJson(context, skillInputSchema);
      const created = await skills
         .create(scoped.ctx.workspaceId, input, context.get('user').id)
         .catch(rethrow);
      // List and create answer `files: { path, size }[]`; only GET /:skillId adds content.
      return json({ ...serialize(created), files: created.files }, 201);
   });

   route.get('/:skillId', async (context) => {
      const scoped = await scope(context.get('user'), false);
      const found = await skills
         .get(scoped.ctx.workspaceId, pathId(context.req.param('skillId'), 'Skill'))
         .catch(rethrow);
      return json(serialize(found));
   });

   route.patch('/:skillId', async (context) => {
      const scoped = await scope(context.get('user'), true);
      const patch = await readJson(context, patchSchema);
      const updated = await skills
         .update(scoped.ctx.workspaceId, pathId(context.req.param('skillId'), 'Skill'), patch)
         .catch(rethrow);
      return json(serialize(updated));
   });

   route.delete('/:skillId', async (context) => {
      const scoped = await scope(context.get('user'), true);
      await skills.remove(scoped.ctx.workspaceId, pathId(context.req.param('skillId'), 'Skill')).catch(rethrow);
      return new Response(null, { status: 204 });
   });

   route.put('/:skillId/agents/:agentId', async (context) => {
      const scoped = await scope(context.get('user'), true);
      const { enabled } = await readJson(context, bindingSchema);
      await skills
         .setBinding(
            scoped.ctx.workspaceId,
            pathId(context.req.param('agentId'), 'Agent'),
            pathId(context.req.param('skillId'), 'Skill'),
            enabled
         )
         .catch(rethrow);
      return new Response(null, { status: 204 });
   });

   route.delete('/:skillId/agents/:agentId', async (context) => {
      const scoped = await scope(context.get('user'), true);
      await skills
         .removeBinding(
            scoped.ctx.workspaceId,
            pathId(context.req.param('agentId'), 'Agent'),
            pathId(context.req.param('skillId'), 'Skill')
         )
         .catch(rethrow);
      return new Response(null, { status: 204 });
   });

   return [{ prefix: '/api/v1/skills', handler: route }];
}

export function serialize(skill: SkillWithFiles): Record<string, unknown> {
   const { fileContents, ...rest } = skill;
   return { ...rest, files: fileContents.map((f) => ({ path: f.path, size: Buffer.byteLength(f.content), content: f.content })) };
}

function rethrow(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Skill');
   if (error instanceof Conflict) throw new ApiError(409, 'SKILL_NAME_TAKEN', 'A skill with that name already exists.');
   throw error;
}
