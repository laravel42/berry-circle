import { Hono } from 'hono';
import { z } from 'zod';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { assertValid, fieldError } from '../http/body.ts';
import { ApiError } from '../http/errors.ts';
import { SealingUnavailable } from '../integrations/sealing.ts';
import type { AgentProfileRepository } from '../agents/profile.ts';
import { readJson } from './zod-body.ts';
import { decodeNameCursor, decodeTimeCursor, encodeCursor } from '../http/cursor.ts';
import { idempotent } from '../http/idempotent.ts';
import type { IdempotencyStore } from '../http/idempotency.ts';
import { Conflict, Forbidden, NotFound } from '../identity/errors.ts';
import type { Mount } from '../http/registry.ts';
import {
   MAX_CONCURRENT_RUNS_PER_AGENT,
   type Agent,
   type AgentRepository,
} from '../agents/repository.ts';
import { PERMISSIONS } from '../agents/permissions.ts';
import type { Logger } from '../observability/log.ts';
import type { RunLedger } from '../runs/ledger.ts';
import type { RunRepository } from '../runs/repository.ts';
import { serializeRun } from './runs.ts';
import {
   CatalogUnavailable,
   normalizeModelId,
   resolveModel,
   type ModelCatalog,
} from '../agents/catalog.ts';

/**
 * `/api/v1/agents`.
 *
 * This mount is what ADR-0008 means in practice. Berry used to reconcile
 * against a separate agent runtime on every request — a workspace sync before
 * a listing, a detail call before a read — so the agent list was a live
 * projection of another process's state rather than a table. Here it is a
 * table, which is why it can be served from PostgreSQL at all.
 *
 * `POST /:agentId/ask` is deliberately absent. It was a chat completion passed
 * through to that runtime, nothing in the product calls it, and what it should
 * mean now that agents run in-process is its own decision.
 */

const STATUSES = new Set(['available', 'busy', 'offline', 'unknown']);
const SCOPE = z.enum(['everyone', 'admins', 'listed']);
const permissionsSchema = z.strictObject({
   permissions: z.array(z.string()).optional(),
   access: z
      .strictObject({ assign: SCOPE, mention: SCOPE, members: z.array(z.string().uuid()).max(200) })
      .optional(),
});
const labelsSchema = z.strictObject({ labels: z.array(z.string().trim().min(1).max(40)).max(20) });
const envSchema = z.strictObject({
   env: z
      .record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), z.string().max(8000))
      .refine((env) => Object.keys(env).length <= 50, 'At most 50 variables.'),
});
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_AVATAR_BYTES = 524_288;
const RUN_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const MAX_NAME = 100;
const MAX_DESCRIPTION = 5_000;
const MAX_INSTRUCTIONS = 20_000;
const MAX_SKILLS = 50;
const SKILL = /^[a-z0-9-]{1,50}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CONFIG_FIELDS = new Set([
   'name',
   'instructions',
   'description',
   'provider',
   'model',
   'skills',
   'starters',
   'maxConcurrency',
]);
const MAX_STARTERS = 3;
const MAX_STARTER = 200;
const MAX_AGENT_CONCURRENCY = 20;
const CREATE_FIELDS = new Set([
   'name',
   'description',
   'instructions',
   'provider',
   'model',
   'skills',
   'avatarUrl',
]);

export interface AgentOptions {
   sessions: SessionService;
   agents: AgentRepository;
   idempotency: IdempotencyStore;
   /** Null when no model credential is configured; the picker then 503s. */
   catalog: ModelCatalog | null;
   /**
    * Optional: records why the catalogue was unreachable. The client only ever
    * sees an opaque 502, so without this the underlying Bedrock cause (bad
    * credentials, a missing IAM permission, a region with no profiles) is lost
    * — which is exactly what makes an empty model picker hard to diagnose.
    */
   logger?: Logger;
   clock?: () => Date;
   /** The agent's task list and "cancel all"; both 503 when absent. */
   runs?: RunRepository;
   ledger?: Pick<RunLedger, 'markCancelled'>;
   /** Labels, sealed env, avatar and access scopes; their routes 503 when absent. */
   profile?: AgentProfileRepository;
}

export function agentMounts(options: AgentOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   const { agents, catalog, logger } = options;
   const clock = options.clock ?? (() => new Date());
   const requireProfile = (): AgentProfileRepository => {
      if (!options.profile) {
         throw new ApiError(503, 'AGENT_PROFILE_UNAVAILABLE', 'Agent profiles are not served here.');
      }
      return options.profile;
   };

   route.get('/', async (context) => {
      const url = new URL(context.req.url);
      const query = parseListQuery(url);
      const workspaceId = currentWorkspace(context.get('user').currentWorkspaceId);
      await agents.authorizeWorkspace(context.get('user').id, workspaceId, 'product.read')
         .catch(rethrowWorkspace);

      const base = query.status === '' ? 'agents.list.all' : `agents.list.${query.status}`;
      const scope = query.archived ? `archived.${base}` : base;
      const after = query.after === '' ? null : decodeNameCursor(query.after, scope);

      const rows = await agents.list(workspaceId, query.status, after, query.first + 1, query.archived);
      const hasNextPage = rows.length > query.first;
      const nodes = hasNextPage ? rows.slice(0, query.first) : rows;
      const last = nodes.at(-1);
      return json({
         nodes: nodes.map(serializeAgent),
         pageInfo: {
            hasNextPage,
            endCursor: last ? encodeCursor(scope, { name: last.name, id: last.id }) : null,
         },
      });
   });

   /**
    * The registry view: what each agent can do and whether it can take work.
    *
    * Registered before `/:agentId` because Hono matches in order and
    * `capabilities` is a valid-looking path segment.
    */
   route.get('/capabilities', async (context) => {
      const workspaceId = currentWorkspace(context.get('user').currentWorkspaceId);
      await agents.authorizeWorkspace(context.get('user').id, workspaceId, 'product.read')
         .catch(rethrowWorkspace);

      const found = await agents.listCapabilities(workspaceId);
      return json({
         nodes: found.map(({ agent, activeRuns }) => ({
            id: agent.id,
            name: agent.name,
            status: agent.status,
            // The planner's vocabulary is `skills`; `tools` is what the
            // runtime gives the agent. Go swapped them onto these two fields
            // and the planner reads them that way round.
            capabilities: agent.skills,
            tools: agent.capabilities,
            repositories: [],
            availability: {
               eligible:
                  (agent.status === 'available' || agent.status === 'busy') &&
                  activeRuns < MAX_CONCURRENT_RUNS_PER_AGENT,
               activeRuns,
               maxConcurrentRuns: MAX_CONCURRENT_RUNS_PER_AGENT,
            },
            limits: agent.limits ?? null,
      permissions: agent.permissions,
            costProfile: agent.modelTier,
            isOrchestrator: agent.protected,
            updatedAt: agent.updatedAt,
         })),
      });
   });

   /**
    * What the agents list needs beyond each agent's own row.
    *
    * Owner, bound runtime, current load, run total, last activity and a short
    * daily history, for every agent at once. The list draws a sparkline and a
    * workload cell per row; doing that from per-agent requests would be one
    * round trip per row, and doing it from the runs the browser happens to
    * hold would be a number that means something different on every screen.
    *
    * Before `/:agentId`, like every other named path on this mount.
    */
   route.get('/roster', async (context) => {
      const workspaceId = currentWorkspace(context.get('user').currentWorkspaceId);
      await agents
         .authorizeWorkspace(context.get('user').id, workspaceId, 'product.read')
         .catch(rethrowWorkspace);
      const raw = new URL(context.req.url).searchParams.get('days');
      const days = raw === null ? 7 : Number(raw);
      if (!Number.isInteger(days) || days < 1 || days > 90) {
         throw ApiError.badRequest('days must be an integer from 1 to 90.');
      }
      return json({ nodes: await agents.roster(workspaceId, days) });
   });

   /** The workspace's guide agent, found by role. Before `/:agentId`, like the rest. */
   route.get('/guide', async (context) => {
      const workspaceId = currentWorkspace(context.get('user').currentWorkspaceId);
      await agents.authorizeWorkspace(context.get('user').id, workspaceId, 'product.read')
         .catch(rethrowWorkspace);
      const guide = await agents.guide(workspaceId);
      if (!guide) throw ApiError.notFound('Agent');
      return json(serializeAgent(guide));
   });

   route.get('/models', async (context) => {
      const workspaceId = currentWorkspace(context.get('user').currentWorkspaceId);
      await agents.authorizeWorkspace(context.get('user').id, workspaceId, 'product.read')
         .catch(rethrowWorkspace);

      const models = await listModels(catalog, logger);
      // Grouped by provider, cheapest first inside it: the list is read as
      // "who serves this, and what does it cost".
      const nodes = models
         .map((model) => ({ ...model, id: normalizeModelId(model.provider, model.id) }))
         .sort(
            (left, right) =>
               left.provider.localeCompare(right.provider) ||
               left.inputCostPerM - right.inputCostPerM ||
               left.displayName.localeCompare(right.displayName)
         );
      return json({ nodes });
   });

   /**
    * Creates an agent.
    *
    * New surface: an agent used to be spawned in the runtime and discovered
    * by a sync, so Berry had no way to author one. Idempotent,
    * because creating two identical agents from a retried request is exactly
    * the sort of duplicate that then cannot be told apart.
    */
   route.post('/', idempotent(options.idempotency), async (context) => {
      const workspaceId = currentWorkspace(context.get('user').currentWorkspaceId);
      await agents.authorizeWorkspace(context.get('user').id, workspaceId, 'product.write')
         .catch(rethrowWorkspace);

      const body = await readBody(context.req.raw, CREATE_FIELDS);
      const name = text(body.name, 'name', MAX_NAME, true);
      const description = optionalText(body, 'description', MAX_DESCRIPTION);
      const instructions = optionalText(body, 'instructions', MAX_INSTRUCTIONS);
      const skills = body.skills === undefined ? undefined : parseSkills(body.skills);
      const pair = await parseModelPair(body, catalog, logger);

      const created = await agents
         .create({
            workspaceId,
            name: name!,
            createdBy: context.get('user').id,
            ...(description === undefined ? {} : { description }),
            ...(instructions === undefined ? {} : { instructions }),
            ...(skills === undefined ? {} : { skills }),
            ...(pair === undefined ? {} : pair),
         })
         .catch(rethrowAgent);
      return json(serializeAgent(created), 201);
   });

   route.get('/:agentId', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const scope = await agents
         .authorizeAgent(context.get('user').id, agentId, 'product.read')
         .catch(rethrowAgent);
      const found = await agents.get(agentId, scope.workspaceId).catch(rethrowAgent);
      return json(serializeAgent(found));
   });

   /**
    * Writes the configuration Berry authors.
    *
    * Go pushed this upstream before storing it, so a save meant the runtime
    * had accepted the change. There is no upstream now: the row is what the
    * agent runs with, and storing it is the whole operation.
    */
   route.put('/:agentId/config', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const scope = await agents
         .authorizeAgent(context.get('user').id, agentId, 'product.write')
         .catch(rethrowAgent);

      const body = await readBody(context.req.raw, CONFIG_FIELDS);
      const instructions = optionalText(body, 'instructions', MAX_INSTRUCTIONS);
      const description = optionalText(body, 'description', MAX_DESCRIPTION);
      // Required when present: renaming to nothing is not a rename, and an
      // agent with no name cannot be referred to anywhere it appears.
      const name = body.name === undefined ? undefined : text(body.name, 'name', MAX_NAME, true);
      const skills = body.skills === undefined ? undefined : parseSkills(body.skills);
      const starters = body.starters === undefined ? undefined : parseStarters(body.starters);
      const maxConcurrency =
         'maxConcurrency' in body ? parseConcurrency(body.maxConcurrency) : undefined;
      const pair = await parseModelPair(body, catalog, logger);

      if (
         name === undefined &&
         instructions === undefined &&
         description === undefined &&
         skills === undefined &&
         starters === undefined &&
         maxConcurrency === undefined &&
         pair === undefined
      ) {
         throw new ApiError(400, 'NO_FIELDS', 'No configuration fields were provided.');
      }

      const updated = await agents
         .setConfig(agentId, scope.workspaceId, {
            ...(name === undefined ? {} : { name }),
            ...(instructions === undefined ? {} : { instructions }),
            ...(description === undefined ? {} : { description }),
            ...(skills === undefined ? {} : { skills }),
            ...(starters === undefined ? {} : { starters }),
            ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
            ...(pair === undefined ? {} : pair),
         })
         .catch(rethrowAgent);
      return json(serializeAgent(updated));
   });

   /**
    * What an agent may do.
    *
    * `workspace.admin`, not `product.write`: granting an agent the ability to
    * merge without a review is an administrative decision about the
    * workspace, not an edit to a piece of work.
    *
    * The whole set is replaced, because every enforcement point reads it as a
    * set — a patch would leave a caller unsure whether an absent name meant
    * "leave it" or "revoke it".
    */
   route.put('/:agentId/permissions', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const scope = await agents
         .authorizeAgent(context.get('user').id, agentId, 'workspace.admin')
         .catch(rethrowAgent);

      const body = await readJson(context, permissionsSchema).catch((error: unknown) => {
         // A malformed permissions list keeps the error it always had.
         if (error instanceof ApiError && error.status === 422) {
            throw new ApiError(400, 'INVALID_REQUEST', 'permissions is a list of permission names.');
         }
         throw error;
      });
      if (!body.permissions && !body.access) {
         throw new ApiError(400, 'NO_FIELDS', 'No permission fields were provided.');
      }
      const given = body.permissions ?? [];
      const unknown = given.filter(
         (name) => !(PERMISSIONS as readonly string[]).includes(name)
      );
      if (unknown.length > 0) {
         // Refused rather than dropped. The runtime ignores a name it does not
         // know, so silently accepting one here would let someone believe they
         // had granted something.
         throw new ApiError(400, 'INVALID_REQUEST', `Unknown permission: ${unknown[0]}.`);
      }

      if (body.access) {
         const ok = await requireProfile()
            .setAccess(scope.workspaceId, agentId, body.access)
            .catch(rethrowAgent);
         if (!ok) {
            assertValid([
               fieldError('/access/members', 'invalid_member', 'Every listed member must belong to this workspace.'),
            ]);
         }
      }
      if (body.permissions) {
         await agents
            .setPermissions(agentId, scope.workspaceId, [...new Set(given)])
            .catch(rethrowAgent);
      }
      return json(serializeAgent(await agents.get(agentId, scope.workspaceId).catch(rethrowAgent)));
   });

   route.put('/:agentId/labels', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const scope = await agents
         .authorizeAgent(context.get('user').id, agentId, 'product.write')
         .catch(rethrowAgent);
      const { labels } = await readJson(context, labelsSchema);
      await requireProfile().setLabels(scope.workspaceId, agentId, labels).catch(rethrowAgent);
      return json(serializeAgent(await agents.get(agentId, scope.workspaceId).catch(rethrowAgent)));
   });

   /** Admin-only: env usually carries credentials the agent acts with. */
   route.put('/:agentId/env', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const user = context.get('user');
      const scope = await agents
         .authorizeAgent(user.id, agentId, 'workspace.admin')
         .catch(rethrowAgent);
      const { env } = await readJson(context, envSchema);
      const profile = requireProfile();
      const envNames = await profile.setEnv(scope.workspaceId, agentId, env).catch(rethrowSealing);
      // After the write, and not awaited into it: the variables are stored
      // either way, and an audit row is the record of a change that happened.
      await profile
         .recordEnvWrite(scope.workspaceId, agentId, { id: user.id, name: user.name }, envNames)
         .catch(() => undefined);
      return json({ envNames });
   });

   /**
    * Opens an agent's environment, and writes down that it was opened.
    *
    * The values are sealed, so "edit one variable" would otherwise mean
    * retyping all of them — which is how a person ends up pasting secrets
    * around to avoid losing the ones they cannot see. Revealing them is
    * therefore a named act with a record, rather than something the editor
    * does quietly on open: a POST, admin-only, and one audit row per call.
    */
   route.post('/:agentId/env/reveal', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const user = context.get('user');
      const scope = await agents
         .authorizeAgent(user.id, agentId, 'workspace.admin')
         .catch(rethrowAgent);
      const env = await requireProfile()
         .revealEnv(scope.workspaceId, agentId, { id: user.id, name: user.name })
         .catch(rethrowSealing);
      return json({ env });
   });

   /** Every reveal and every write, newest first. Admin-only, like the values. */
   route.get('/:agentId/env/audit', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const scope = await agents
         .authorizeAgent(context.get('user').id, agentId, 'workspace.admin')
         .catch(rethrowAgent);
      const raw = new URL(context.req.url).searchParams.get('first');
      const first = raw === null ? 50 : Number(raw);
      if (!Number.isInteger(first) || first < 1 || first > 200) {
         throw ApiError.badRequest('first must be an integer from 1 to 200.');
      }
      const nodes = await requireProfile()
         .envAudit(scope.workspaceId, agentId, first)
         .catch(rethrowAgent);
      return json({ nodes });
   });

   route.put('/:agentId/avatar', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const scope = await agents
         .authorizeAgent(context.get('user').id, agentId, 'product.write')
         .catch(rethrowAgent);
      const type = (context.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (!AVATAR_TYPES.has(type)) {
         throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload a PNG, JPEG, WebP or GIF image.');
      }
      const bytes = Buffer.from(await context.req.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) {
         throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'An avatar is at most 512 KiB.');
      }
      await requireProfile().putAvatar(scope.workspaceId, agentId, type, bytes).catch(rethrowAgent);
      return json(serializeAgent(await agents.get(agentId, scope.workspaceId).catch(rethrowAgent)));
   });

   route.get('/:agentId/avatar', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const scope = await agents
         .authorizeAgent(context.get('user').id, agentId, 'product.read')
         .catch(rethrowAgent);
      const avatar = await requireProfile().getAvatar(scope.workspaceId, agentId).catch(rethrowAgent);
      return new Response(new Uint8Array(avatar.bytes), {
         headers: {
            'content-type': avatar.contentType,
            'cache-control': 'private, max-age=31536000, immutable',
            'x-content-type-options': 'nosniff',
         },
      });
   });

   route.get('/:agentId/access', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const scope = await agents
         .authorizeAgent(context.get('user').id, agentId, 'product.read')
         .catch(rethrowAgent);
      return json(await requireProfile().getAccess(scope.workspaceId, agentId).catch(rethrowAgent));
   });

   route.delete('/:agentId', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const scope = await agents
         .authorizeAgent(context.get('user').id, agentId, 'product.write')
         .catch(rethrowAgent);
      await agents.archive(agentId, scope.workspaceId, clock()).catch((error) => {
         // A protected agent refuses removal. That is the flag's whole point,
         // so it is reported as what it is rather than as a missing agent.
         if (error instanceof Forbidden) {
            throw new ApiError(
               409,
               'AGENT_PROTECTED',
               'This agent is required by its workspace and cannot be removed.'
            );
         }
         return rethrowAgent(error);
      });
      return new Response(null, { status: 204 });
   });

   route.post('/:agentId/restore', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      // authorizeAgent does not filter archived agents, so this reaches them.
      const scope = await agents
         .authorizeAgent(context.get('user').id, agentId, 'product.write')
         .catch(rethrowAgent);
      return json(serializeAgent(await agents.restore(agentId, scope.workspaceId).catch(rethrowAgent)));
   });

   route.post('/:agentId/copy', idempotent(options.idempotency), async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      const scope = await agents
         .authorizeAgent(context.get('user').id, agentId, 'product.write')
         .catch(rethrowAgent);
      return json(serializeAgent(await agents.copy(agentId, scope.workspaceId).catch(rethrowAgent)), 201);
   });

   route.post('/:agentId/cancel-tasks', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      await agents.authorizeAgent(context.get('user').id, agentId, 'product.write').catch(rethrowAgent);
      const { runs, ledger } = options;
      if (!runs || !ledger) throw new ApiError(503, 'RUNS_UNAVAILABLE', 'Runs are not served here.');
      let cancelled = 0;
      for (const status of ['queued', 'running'] as const) {
         for (const run of await runs.listByAgent(agentId, null, 100, { status })) {
            // A run that finished meanwhile is not an error; it simply is not counted.
            const done = await ledger.markCancelled(run.id).then(
               () => true,
               () => false
            );
            if (done) cancelled += 1;
         }
      }
      return json({ cancelled });
   });

   route.get('/:agentId/tasks', async (context) => {
      const agentId = pathId(context.req.param('agentId'));
      await agents.authorizeAgent(context.get('user').id, agentId, 'product.read').catch(rethrowAgent);
      const { runs } = options;
      if (!runs) throw new ApiError(503, 'RUNS_UNAVAILABLE', 'Runs are not served here.');
      const url = new URL(context.req.url);
      const first = Math.min(Math.max(Number(url.searchParams.get('first') ?? '50') || 50, 1), 100);
      const status = url.searchParams.get('status') ?? undefined;
      if (status !== undefined && !RUN_STATUSES.has(status)) {
         throw ApiError.badRequest('status is not supported.');
      }
      const scope = `agents.tasks.${agentId}`;
      const rawAfter = url.searchParams.get('after');
      const after = rawAfter ? decodeTimeCursor(rawAfter, scope) : null;
      const rows = await runs.listByAgent(agentId, after, first + 1, { status });
      const nodes = rows.slice(0, first);
      const last = nodes.at(-1);
      return json({
         nodes: nodes.map(serializeRun),
         pageInfo: {
            hasNextPage: rows.length > first,
            endCursor: last ? encodeCursor(scope, { createdAt: last.createdAt, id: last.id }) : null,
         },
      });
   });

   return [{ prefix: '/api/v1/agents', handler: route }];
}

/** The wire shape Go serves, field for field. */
function serializeAgent(agent: Agent): Record<string, unknown> {
   return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      avatarUrl: agent.avatarUrl,
      status: agent.status,
      capabilities: agent.capabilities,
      skills: agent.skills,
      instructions: agent.instructions,
      limits: agent.limits ?? null,
      permissions: agent.permissions,
      modelProvider: agent.modelProvider,
      modelName: agent.modelName,
      systemRole: agent.systemRole,
      // Who authored the agent. Null for anything a workspace seeded itself,
      // which is a different answer from "the person reading this page".
      ownerId: agent.ownerId,
      conversationStarters: agent.conversationStarters,
      maxConcurrency: agent.maxConcurrency,
      archivedAt: agent.archivedAt,
      labels: agent.labels,
      envNames: agent.envNames,
      access: agent.access,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
   };
}

/**
 * The workspace the caller is currently in.
 *
 * Agents are listed for it rather than for one named in the query, which is
 * how Go scopes this mount. A user in no workspace gets "Workspace not found."
 * — the same answer as naming one they cannot see.
 */
function currentWorkspace(workspaceId: string | null): string {
   if (!workspaceId) throw ApiError.notFound('Workspace');
   return workspaceId;
}

function pathId(raw: string | undefined): string {
   if (!raw || !UUID.test(raw)) throw ApiError.notFound('Agent');
   return raw.toLowerCase();
}

function parseListQuery(url: URL): {
   first: number;
   after: string;
   status: string;
   archived: boolean;
} {
   for (const name of url.searchParams.keys()) {
      if (!['first', 'after', 'status', 'archived'].includes(name)) {
         throw ApiError.badRequest('Unknown query parameter.');
      }
      if (url.searchParams.getAll(name).length !== 1) {
         throw ApiError.badRequest('Query parameter must appear once.');
      }
   }
   const raw = url.searchParams.get('first') ?? '';
   let first = 50;
   if (raw !== '') {
      first = Number(raw);
      if (!Number.isInteger(first) || first < 1 || first > 100) {
         throw ApiError.badRequest('first must be an integer from 1 to 100.');
      }
   }
   const status = url.searchParams.get('status') ?? '';
   if (status !== '' && !STATUSES.has(status)) {
      throw ApiError.badRequest('status is not supported.');
   }
   const archived = url.searchParams.get('archived') ?? 'false';
   if (archived !== 'true' && archived !== 'false') {
      throw ApiError.badRequest('archived must be true or false.');
   }
   return { first, after: url.searchParams.get('after') ?? '', status, archived: archived === 'true' };
}

async function readBody(
   request: Request,
   allowed: Set<string>
): Promise<Record<string, unknown>> {
   const raw = await request.text();
   let parsed: unknown;
   try {
      parsed = JSON.parse(raw === '' ? '{}' : raw);
   } catch {
      throw new ApiError(400, 'INVALID_BODY', 'Request body is not valid JSON.');
   }
   if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ApiError(400, 'INVALID_BODY', 'Request body is not valid JSON.');
   }
   for (const key of Object.keys(parsed)) {
      if (!allowed.has(key)) {
         throw new ApiError(400, 'INVALID_BODY', 'Request body is not valid JSON.');
      }
   }
   return parsed as Record<string, unknown>;
}

function text(value: unknown, field: string, limit: number, required: boolean): string | undefined {
   if (value === undefined || value === null) {
      if (required) throw ApiError.badRequest(`${field} is required.`);
      return undefined;
   }
   if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be a string.`);
   const trimmed = value.trim();
   if (required && trimmed === '') throw ApiError.badRequest(`${field} is required.`);
   // Counted in characters rather than bytes, because that is what the
   // column's CHECK counts — a byte bound would reject a name of emoji that
   // the database would have accepted.
   if ([...trimmed].length > limit) {
      throw new ApiError(400, `${field.toUpperCase()}_TOO_LONG`, 'Value exceeds the maximum length.');
   }
   return trimmed;
}

/**
 * A field the caller omitted is left alone; a field sent empty is cleared.
 *
 * Conflating the two would make "leave unchanged" and "erase" the same
 * request, which is the difference an editor depends on to save one field
 * without blanking the rest.
 */
function optionalText(
   body: Record<string, unknown>,
   field: string,
   limit: number
): string | undefined {
   if (!(field in body) || body[field] === null) return undefined;
   // Empty stays empty rather than becoming null. Go decodes an absent field
   // and a JSON null to the same nil pointer and treats both as "unchanged",
   // so an empty string is the only way to clear one — and it is stored as an
   // empty string, which is what the field then reads as on the wire.
   return text(body[field], field, limit, false) ?? '';
}

function parseSkills(value: unknown): string[] {
   if (!Array.isArray(value) || value.length > MAX_SKILLS) throw skillsInvalid();
   const seen = new Set<string>();
   for (const entry of value) {
      if (typeof entry !== 'string') throw skillsInvalid();
      const skill = entry.trim().toLowerCase();
      if (!SKILL.test(skill)) throw skillsInvalid();
      seen.add(skill);
   }
   return [...seen].sort();
}

/**
 * The openers a new chat offers, in the order they are shown.
 *
 * Blank entries are dropped rather than refused: an editor that keeps three
 * rows on screen sends three, and an empty one means the person did not write
 * a third — not that the request is malformed.
 */
function parseStarters(value: unknown): string[] {
   if (!Array.isArray(value)) throw startersInvalid();
   const starters: string[] = [];
   for (const entry of value) {
      if (typeof entry !== 'string') throw startersInvalid();
      const starter = entry.trim();
      if (starter === '') continue;
      if ([...starter].length > MAX_STARTER) throw startersInvalid();
      starters.push(starter);
   }
   if (starters.length > MAX_STARTERS) throw startersInvalid();
   return starters;
}

function startersInvalid(): ApiError {
   return new ApiError(
      400,
      'STARTERS_INVALID',
      `At most ${MAX_STARTERS} starters of up to ${MAX_STARTER} characters.`
   );
}

/** A whole number of tasks, or null to leave the ceiling to the dispatcher. */
function parseConcurrency(value: unknown): number | null {
   if (value === null) return null;
   if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw ApiError.badRequest('maxConcurrency is a whole number of tasks, or null.');
   }
   if (value < 1 || value > MAX_AGENT_CONCURRENCY) {
      throw ApiError.badRequest(`maxConcurrency is from 1 to ${MAX_AGENT_CONCURRENCY}.`);
   }
   return value;
}

function skillsInvalid(): ApiError {
   return new ApiError(
      400,
      'SKILLS_INVALID',
      'Skills are up to 50 names of lowercase letters, digits and dashes.'
   );
}

/**
 * The provider and model, which are set together or not at all.
 *
 * A model id only means something against the provider serving it, so
 * accepting one alone would store a pairing nothing can resolve.
 */
async function parseModelPair(
   body: Record<string, unknown>,
   catalog: ModelCatalog | null,
   logger?: Logger
): Promise<{ provider: string | null; model: string | null } | undefined> {
   // Both sent as null clears the pairing: an agent that runs on whatever its
   // runtime defaults to. Distinct from omitting them, which changes nothing —
   // without this there is no way back from a model once one is chosen.
   if ('provider' in body && 'model' in body && body.provider === null && body.model === null) {
      return { provider: null, model: null };
   }
   const hasProvider = 'provider' in body && body.provider !== null;
   const hasModel = 'model' in body && body.model !== null;
   if (!hasProvider && !hasModel) return undefined;
   if (hasProvider !== hasModel) {
      throw new ApiError(400, 'MODEL_PAIR_REQUIRED', 'Provider and model must be set together.');
   }

   const provider = text(body.provider, 'provider', 100, true)!;
   const model = text(body.model, 'model', 200, true)!;
   const models = await listModels(catalog, logger);
   if (!resolveModel(models, provider, model)) {
      throw new ApiError(
         400,
         'MODEL_UNAVAILABLE',
         'That model is not available on this runtime.'
      );
   }
   return { provider, model };
}

async function listModels(catalog: ModelCatalog | null, logger?: Logger) {
   if (!catalog) {
      // A picker with nothing behind it would offer models that cannot run.
      throw new ApiError(
         503,
         'MODEL_CATALOG_UNAVAILABLE',
         'This server has no model catalogue configured.'
      );
   }
   try {
      return await catalog.list();
   } catch (error) {
      if (error instanceof CatalogUnavailable) {
         // The 502 the client gets is deliberately opaque; the cause is not.
         // Logging it here is the only place the underlying Bedrock failure
         // (an invalid token, a missing bedrock:ListInferenceProfiles grant, a
         // region with no system profiles) is visible to an operator staring
         // at an empty model picker.
         logger?.error('model catalogue unavailable', { error: error.message });
         throw new ApiError(
            502,
            'DEPENDENCY_UNAVAILABLE',
            'The model catalogue could not be reached.'
         );
      }
      throw error;
   }
}

/** Not being in a workspace and not being allowed in it read the same way. */
function rethrowWorkspace(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Workspace');
   if (error instanceof Forbidden) throw ApiError.forbidden();
   throw error;
}

/** A server with no sealing key cannot hold credentials; that is a 412, not a 500. */
function rethrowSealing(error: unknown): never {
   if (error instanceof SealingUnavailable) {
      throw new ApiError(412, 'INTEGRATIONS_NOT_CONFIGURED', 'This server cannot store credentials.');
   }
   return rethrowAgent(error);
}

function rethrowAgent(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Agent');
   if (error instanceof Forbidden) throw ApiError.forbidden();
   if (error instanceof Conflict) {
      throw new ApiError(409, 'CONFLICT', 'Agent conflicts with an existing resource.');
   }
   throw error;
}
