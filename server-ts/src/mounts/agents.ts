import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import { decodeNameCursor, encodeCursor } from '../http/cursor.ts';
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
const MAX_NAME = 100;
const MAX_DESCRIPTION = 5_000;
const MAX_INSTRUCTIONS = 20_000;
const MAX_SKILLS = 50;
const SKILL = /^[a-z0-9-]{1,50}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CONFIG_FIELDS = new Set(['instructions', 'description', 'provider', 'model', 'skills']);
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
}

export function agentMounts(options: AgentOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   const { agents, catalog, logger } = options;
   const clock = options.clock ?? (() => new Date());

   route.get('/', async (context) => {
      const url = new URL(context.req.url);
      const query = parseListQuery(url);
      const workspaceId = currentWorkspace(context.get('user').currentWorkspaceId);
      await agents.authorizeWorkspace(context.get('user').id, workspaceId, 'product.read')
         .catch(rethrowWorkspace);

      const scope = query.status === '' ? 'agents.list.all' : `agents.list.${query.status}`;
      const after = query.after === '' ? null : decodeNameCursor(query.after, scope);

      const rows = await agents.list(workspaceId, query.status, after, query.first + 1);
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
      const skills = body.skills === undefined ? undefined : parseSkills(body.skills);
      const pair = await parseModelPair(body, catalog, logger);

      if (
         instructions === undefined &&
         description === undefined &&
         skills === undefined &&
         pair === undefined
      ) {
         throw new ApiError(400, 'NO_FIELDS', 'No configuration fields were provided.');
      }

      const updated = await agents
         .setConfig(agentId, scope.workspaceId, {
            ...(instructions === undefined ? {} : { instructions }),
            ...(description === undefined ? {} : { description }),
            ...(skills === undefined ? {} : { skills }),
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

      const body = await readBody(context.req.raw, new Set(['permissions']));
      const given = body.permissions;
      if (!Array.isArray(given) || given.some((entry) => typeof entry !== 'string')) {
         throw new ApiError(400, 'INVALID_REQUEST', 'permissions is a list of permission names.');
      }
      const unknown = (given as string[]).filter(
         (name) => !(PERMISSIONS as readonly string[]).includes(name)
      );
      if (unknown.length > 0) {
         // Refused rather than dropped. The runtime ignores a name it does not
         // know, so silently accepting one here would let someone believe they
         // had granted something.
         throw new ApiError(400, 'INVALID_REQUEST', `Unknown permission: ${unknown[0]}.`);
      }

      const updated = await agents
         .setPermissions(agentId, scope.workspaceId, [...new Set(given as string[])])
         .catch(rethrowAgent);
      return json(serializeAgent(updated));
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

function parseListQuery(url: URL): { first: number; after: string; status: string } {
   for (const name of url.searchParams.keys()) {
      if (!['first', 'after', 'status'].includes(name)) {
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
   return { first, after: url.searchParams.get('after') ?? '', status };
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
): Promise<{ provider: string; model: string } | undefined> {
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

function rethrowAgent(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Agent');
   if (error instanceof Forbidden) throw ApiError.forbidden();
   if (error instanceof Conflict) {
      throw new ApiError(409, 'CONFLICT', 'Agent conflicts with an existing resource.');
   }
   throw error;
}
