import { Hono } from 'hono';
import { z } from 'zod';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import type { Sealer } from '../integrations/sealing.ts';
import { lifecycleFor } from '../runtime/runtime-control.ts';
import {
   RuntimeNotFound,
   RuntimeProtected,
   RuntimeRepository,
   RuntimeSealingUnavailable,
   type ProfileView,
   type RuntimeView,
} from '../runtime/runtimes.ts';
import type { RuntimeTarget } from '../runtime/transport.ts';
import type { Permission } from '../identity/roles.ts';
import type { ScopedDb } from '../identity/workspace-context.ts';
import { currentWorkspace, owned, pathId, resolveScoped, resolveScopedResource } from './shared.ts';

const seconds = z.number().int().min(60).max(28_800);
const runtimeBody = z.object({
   name: z.string().trim().min(1).max(100).optional(),
   driver: z.enum(['agentcore', 'http']).optional(),
   arn: z
      .string()
      .regex(/^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/[A-Za-z0-9_-]+$/)
      .nullable()
      .optional(),
   endpointUrl: z.url({ protocol: /^https?$/ }).nullable().optional(),
   qualifier: z.string().min(1).max(100).optional(),
   region: z.string().min(1).max(40).nullable().optional(),
   concurrencyLimit: z.number().int().positive().max(1000).nullable().optional(),
   visibility: z.enum(['private', 'workspace']).optional(),
   idleTimeoutS: seconds.optional(),
   isDefault: z.boolean().optional(),
   status: z.enum(['active', 'disabled']).optional(),
});
const profileBody = z.object({
   name: z.string().trim().min(1).max(100).optional(),
   env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(8192)).optional(),
   modelDefault: z.string().min(1).max(200).nullable().optional(),
   timeoutS: z.number().int().min(30).max(28_800).nullable().optional(),
   maxConcurrency: z.number().int().positive().max(1000).nullable().optional(),
   idleTimeoutS: seconds.nullable().optional(),
});

type Lifecycle = { idleRuntimeSessionTimeout: number; maxLifetime: number };

/**
 * `/api/v1/runtimes`: where a workspace's agents run, and how.
 *
 * Scoped to the caller's current workspace. Reads need `product.read`; every
 * write needs `settings.write` (owners and admins). A runtime, profile or
 * agent from another workspace is a 404, never a 403.
 */
export function runtimeMounts(options: {
   sessions: SessionService;
   sql: Sql;
   sealer: Sealer | null;
   /** Probes a target; throws with the reason when it is not healthy. */
   health: (target: RuntimeTarget) => Promise<void>;
   /** The deployment's own runtime, which a platform row stands for. */
   defaultTarget?: RuntimeTarget | null;
   /** Writes a session lifecycle onto an AgentCore runtime. Absent without AgentCore. */
   applyLifecycle?: (arn: string, lifecycle: Lifecycle) => Promise<void>;
}): Mount[] {
   const repository = new RuntimeRepository(options.sql, options.sealer);
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   const scope = async (userId: string, workspaceId: string | null, write: boolean): Promise<string> => {
      if (!workspaceId) throw ApiError.notFound('Workspace');
      const scoped = await resolveScoped(options.sql, userId, workspaceId, write ? 'settings.write' : 'product.read');
      return scoped.ctx.workspaceId;
   };
   /**
    * The scope for a write on named rows. Each row is found in the caller's
    * workspace before `settings.write` is checked, so an absent or foreign id
    * is the same 404 for every role, and a 403 only ever speaks of a row the
    * caller could already see.
    */
   const scopeFor = async (
      user: { id: string; currentWorkspaceId: string | null },
      required: Permission,
      ...rows: Array<(db: ScopedDb) => Promise<void>>
   ): Promise<string> => {
      const scoped = await resolveScopedResource(
         options.sql,
         user.id,
         currentWorkspace(user.currentWorkspaceId),
         required,
         async (db) => {
            for (const row of rows) await row(db);
         }
      );
      return scoped.ctx.workspaceId;
   };
   // Every miss is "Runtime not found", as the repository's own misses are,
   // so which row was absent is not told apart either.
   const runtimeRow = (id: string) => owned('agent_runtimes', id, 'Runtime');
   const profileRow = (id: string) => owned('runtime_profiles', id, 'Runtime');
   const agentRow = (id: string) => owned('agents', id, 'Runtime');
   const parse = async <S extends z.ZodType>(request: Request, schema: S): Promise<z.output<S>> => {
      const parsed = schema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
         throw ApiError.badRequest('the request is not valid', {
            fields: parsed.error.issues.map((issue) => ({ path: `/${issue.path.join('/')}`, message: issue.message })),
         });
      }
      return parsed.data;
   };
   const guard = <T>(work: Promise<T>): Promise<T> =>
      work.catch((error: unknown) => {
         if (error instanceof RuntimeNotFound) throw ApiError.notFound('Runtime');
         if (error instanceof RuntimeProtected) {
            throw new ApiError(409, 'RUNTIME_PROTECTED', 'the platform runtime cannot be removed');
         }
         if (error instanceof RuntimeSealingUnavailable) {
            throw new ApiError(503, 'SEALING_UNAVAILABLE', 'this deployment cannot store profile environment');
         }
         throw error;
      });

   /**
    * A profile's idle timeout lives on the AgentCore runtime, not the session,
    * so saving it writes the runtime. Its failure never fails the save: the
    * profile is stored and the response says the runtime was not updated.
    */
   const withLifecycle = async (
      runtime: RuntimeView,
      profile: ProfileView
   ): Promise<ProfileView & { lifecycleApplied?: boolean; lifecycleError?: string }> => {
      if (runtime.kind !== 'custom' || runtime.driver !== 'agentcore' || !runtime.arn || !options.applyLifecycle) {
         return profile;
      }
      try {
         await options.applyLifecycle(runtime.arn, lifecycleFor(runtime, profile));
         return { ...profile, lifecycleApplied: true };
      } catch (error) {
         return { ...profile, lifecycleApplied: false, lifecycleError: error instanceof Error ? error.message : String(error) };
      }
   };

   route.get('/', async (context) => {
      const user = context.get('user');
      const workspaceId = await scope(user.id, user.currentWorkspaceId, false);
      return json({ nodes: await repository.list(workspaceId, user.id) });
   });

   route.post('/', async (context) => {
      const user = context.get('user');
      const workspaceId = await scope(user.id, user.currentWorkspaceId, true);
      const body = await parse(context.req.raw, runtimeBody);
      if ((body.driver ?? 'agentcore') === 'agentcore' ? !body.arn : !body.endpointUrl) {
         throw ApiError.badRequest('an agentcore runtime needs an ARN; an http runtime needs an endpoint URL');
      }
      return json(await repository.create(workspaceId, user.id, body), 201);
   });

   /**
    * Which agents have somewhere to run. Registered before `/:id` so the word
    * is read as this route rather than as a runtime id (which it is not).
    */
   route.get('/agent-coverage', async (context) => {
      const user = context.get('user');
      const workspaceId = await scope(user.id, user.currentWorkspaceId, false);
      return json(await repository.agentCoverage(workspaceId));
   });

   route.get('/:id', async (context) => {
      const user = context.get('user');
      const workspaceId = await scope(user.id, user.currentWorkspaceId, false);
      const id = pathId(context.req.param('id'), 'Runtime');
      const view = await guard(repository.get(workspaceId, id));
      const [activity, servingAgents] = await Promise.all([
         repository.activity(workspaceId, id),
         repository.servingAgents(workspaceId, id),
      ]);
      return json({ ...view, activity, servingAgents });
   });

   route.patch('/:id', async (context) => {
      const user = context.get('user');
      const id = pathId(context.req.param('id'), 'Runtime');
      const workspaceId = await scopeFor(user, 'settings.write', runtimeRow(id));
      const body = await parse(context.req.raw, runtimeBody);
      return json(await guard(repository.update(workspaceId, id, body)));
   });

   route.delete('/:id', async (context) => {
      const user = context.get('user');
      const id = pathId(context.req.param('id'), 'Runtime');
      const workspaceId = await scopeFor(user, 'settings.write', runtimeRow(id));
      await guard(repository.remove(workspaceId, id));
      return new Response(null, { status: 204 });
   });

   route.post('/:id/health', async (context) => {
      const user = context.get('user');
      const workspaceId = await scope(user.id, user.currentWorkspaceId, false);
      const view = await guard(repository.get(workspaceId, pathId(context.req.param('id'), 'Runtime')));
      const target = repository.target(view, options.defaultTarget ?? null);
      let error: string | null = target ? null : 'no runtime is configured behind this entry';
      if (target) {
         await options.health(target).catch((cause: unknown) => {
            error = cause instanceof Error ? cause.message : String(cause);
         });
      }
      await repository.recordHealth(workspaceId, view.id, error);
      return json(await repository.get(workspaceId, view.id));
   });

   route.get('/:id/profiles', async (context) => {
      const user = context.get('user');
      const workspaceId = await scope(user.id, user.currentWorkspaceId, false);
      const id = pathId(context.req.param('id'), 'Runtime');
      await guard(repository.get(workspaceId, id));
      return json({ nodes: await repository.profiles(workspaceId, id) });
   });

   route.post('/:id/profiles', async (context) => {
      const user = context.get('user');
      const id = pathId(context.req.param('id'), 'Runtime');
      const workspaceId = await scopeFor(user, 'settings.write', runtimeRow(id));
      const body = await parse(context.req.raw, profileBody);
      const profile = await guard(repository.saveProfile(workspaceId, id, null, body));
      return json(await withLifecycle(await repository.get(workspaceId, id), profile), 201);
   });

   route.patch('/:id/profiles/:profileId', async (context) => {
      const user = context.get('user');
      const id = pathId(context.req.param('id'), 'Runtime');
      const profileId = pathId(context.req.param('profileId'), 'Profile');
      const workspaceId = await scopeFor(user, 'settings.write', runtimeRow(id), profileRow(profileId));
      const body = await parse(context.req.raw, profileBody);
      const profile = await guard(repository.saveProfile(workspaceId, id, profileId, body));
      return json(await withLifecycle(await repository.get(workspaceId, id), profile));
   });

   route.delete('/:id/profiles/:profileId', async (context) => {
      const user = context.get('user');
      const id = pathId(context.req.param('id'), 'Runtime');
      const profileId = pathId(context.req.param('profileId'), 'Profile');
      const workspaceId = await scopeFor(user, 'settings.write', runtimeRow(id), profileRow(profileId));
      await guard(repository.removeProfile(workspaceId, id, profileId));
      return new Response(null, { status: 204 });
   });

   route.put('/:id/agents/:agentId', async (context) => {
      const user = context.get('user');
      const id = pathId(context.req.param('id'), 'Runtime');
      const agentId = pathId(context.req.param('agentId'), 'Agent');
      const workspaceId = await scopeFor(user, 'settings.write', runtimeRow(id), agentRow(agentId));
      const body = await parse(context.req.raw, z.object({ profileId: z.uuid().nullable().optional() }));
      await guard(repository.bind(workspaceId, id, agentId, body.profileId ?? null));
      return new Response(null, { status: 204 });
   });

   route.delete('/:id/agents/:agentId', async (context) => {
      const user = context.get('user');
      const id = pathId(context.req.param('id'), 'Runtime');
      const agentId = pathId(context.req.param('agentId'), 'Agent');
      // The runtime in the path must still be this workspace's, and so must the agent.
      const workspaceId = await scopeFor(user, 'settings.write', runtimeRow(id), agentRow(agentId));
      await guard(repository.bind(workspaceId, null, agentId, null));
      return new Response(null, { status: 204 });
   });

   return [{ prefix: '/api/v1/runtimes', handler: route }];
}
