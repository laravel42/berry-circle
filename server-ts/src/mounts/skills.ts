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
import { SkillImportError, type SkillImporter } from '../skills/github-import.ts';
import type { SkillRepository, SkillWithFiles } from '../skills/repository.ts';
import { readZip, skillFromArchive } from '../skills/zip.ts';
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
   importer?: SkillImporter;
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

   const importSchema = z.strictObject({ url: z.string().url().max(2000) });

   route.post('/import', creating, async (context) => {
      const scoped = await scope(context.get('user'), true);
      if (!options.importer) {
         throw new ApiError(503, 'SKILL_IMPORT_UNAVAILABLE', 'Skill import is not configured.');
      }
      const { url } = await readJson(context, importSchema);
      const imported = await options.importer.fromGitHub(url).catch(rethrowImport);
      const created = await skills
         .replaceFromImport(scoped.ctx.workspaceId, null, imported, context.get('user').id)
         .catch(rethrow);
      return json({ ...serialize(created), files: created.files }, 201);
   });

   // No idempotency middleware here: `idempotent()` fingerprints the body with
   // `fingerprintJSON`, which parses it as JSON and would refuse every zip.
   route.post('/import/zip', async (context) => {
      const scoped = await scope(context.get('user'), true);
      const type = (context.req.header('content-type') ?? '').split(';')[0]?.trim();
      if (type !== 'application/zip') {
         throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/zip.');
      }
      const bytes = Buffer.from(await context.req.arrayBuffer());
      if (bytes.length > 2 << 20) {
         throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
      }
      const imported = (() => {
         try {
            return skillFromArchive(readZip(bytes));
         } catch (error) {
            return rethrowImport(error);
         }
      })();
      const created = await skills
         .replaceFromImport(scoped.ctx.workspaceId, null, imported, context.get('user').id)
         .catch(rethrow);
      return json({ ...serialize(created), files: created.files }, 201);
   });

   route.post('/:skillId/refresh', async (context) => {
      const scoped = await scope(context.get('user'), true);
      const id = pathId(context.req.param('skillId'), 'Skill');
      const current = await skills.get(scoped.ctx.workspaceId, id).catch(rethrow);
      if (current.source.kind !== 'github' || !current.source.url || !options.importer) {
         throw new ApiError(
            409,
            'SKILL_NOT_REFRESHABLE',
            'Only a skill imported from GitHub can be refreshed.'
         );
      }
      const imported = await options.importer.fromGitHub(current.source.url).catch(rethrowImport);
      const updated = await skills
         .replaceFromImport(scoped.ctx.workspaceId, id, imported, context.get('user').id)
         .catch(rethrow);
      return json(serialize(updated));
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

function rethrowImport(error: unknown): never {
   if (error instanceof SkillImportError) {
      const status = error.code === 'SKILL_SOURCE_UNAVAILABLE' ? 502 : 422;
      throw new ApiError(status, error.code, error.message);
   }
   throw error;
}

function rethrow(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Skill');
   if (error instanceof Conflict) throw new ApiError(409, 'SKILL_NAME_TAKEN', 'A skill with that name already exists.');
   throw error;
}
