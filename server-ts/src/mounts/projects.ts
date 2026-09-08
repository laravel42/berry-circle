import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { ApiError, type FieldError } from '../http/errors.ts';
import {
   SORT_ORDER_CURSOR_KEYS,
   decodeCursor,
   encodeCursor,
   type SortOrderCursor,
} from '../http/cursor.ts';
import { idempotent } from '../http/idempotent.ts';
import type { IdempotencyStore } from '../http/idempotency.ts';
import { Conflict, Forbidden, NotFound } from '../identity/errors.ts';
import type {
   Project,
   ProjectPatch,
   ProjectRepository,
   ProjectResource,
   ResourcePatch,
} from '../core/projects.ts';
import type { ScmProvisioning } from '../scm/provisioning.ts';
import type { ScmLink } from '../scm/links.ts';
import type { ScmWorkspaces } from '../scm/workspaces.ts';
import type { Logger } from '../observability/log.ts';
import type { Mount } from '../http/registry.ts';

/**
 * `/api/v1/projects`.
 *
 * `POST /:projectId/generated-issues` is deliberately absent. It decomposes a
 * project into issues with an agent, and what it should mean now that agents
 * run in-process is its own decision. See SCOPE.md.
 */

const STATUSES = new Set(['planned', 'active', 'paused', 'completed', 'cancelled']);
const PRIORITIES = new Set(['none', 'low', 'medium', 'high', 'urgent']);
const RESOURCE_KINDS = new Set(['link', 'document', 'repository']);

/** `owner/name`, and nothing that could be a path or a URL. */
const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PROJECT_BODY_FIELDS = new Set([
   'workspaceId',
   'name',
   'description',
   'status',
   'priority',
   'startDate',
   'targetDate',
   'githubRepo',
]);
const RESOURCE_BODY_FIELDS = new Set(['kind', 'url', 'label', 'description', 'sortOrder']);

export interface ProjectOptions {
   sessions: SessionService;
   projects: ProjectRepository;
   idempotency: IdempotencyStore;
   /**
    * Berry's own git host. Absent when the deployment runs none, and then a
    * project simply has no repository of its own.
    */
   scm: ScmProvisioning | null;
   /** Resolves the organization a workspace's repositories belong under. */
   scmWorkspaces: ScmWorkspaces | null;
   logger: Logger;
}

export function projectMounts(options: ProjectOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   const { projects } = options;

   route.get('/', async (context) => {
      const url = new URL(context.req.url);
      const page = parsePage(url, ['workspaceId', 'query', 'status', 'priority']);
      const workspaceId = requiredQueryUUID(url, 'workspaceId');
      const filter = parseListFilter(url);

      await projects.authorize(context.get('user').id, workspaceId, 'product.read').catch(rethrow);

      const scope = cursorScope('projects.list', [
         workspaceId,
         filter.query,
         filter.status ?? '',
         filter.priority ?? '',
      ]);
      const after = page.after === '' ? null : decodeProjectCursor(page.after, scope);

      const rows = await projects.list(workspaceId, filter, after, page.first + 1).catch(rethrow);
      const hasNextPage = rows.length > page.first;
      const nodes = hasNextPage ? rows.slice(0, page.first) : rows;
      const last = nodes.at(-1);
      return json({
         nodes: nodes.map((node) => serializeProject(node)),
         pageInfo: {
            hasNextPage,
            endCursor: last ? encodeCursor(scope, { updatedAt: last.updatedAt, id: last.id }) : null,
         },
      });
   });

   route.post('/', idempotent(options.idempotency), async (context) => {
      const body = await readBody(context.req.raw, PROJECT_BODY_FIELDS);
      const input = parseCreate(body);
      const userId = context.get('user').id;
      await projects.authorize(userId, input.workspaceId, 'product.write').catch(rethrow);

      const created = await projects
         .create({
            workspaceId: input.workspaceId,
            name: input.name,
            description: input.description,
            status: input.status,
            priority: input.priority,
            startDate: input.startDate,
            targetDate: input.targetDate,
            // Berry stores the repository id alongside the name, and the id
            // only exists once GitHub has resolved it. Without that resolver
            // here, only the name is recorded.
            githubRepoId: null,
            githubRepoFullName: input.githubRepo,
            createdBy: userId,
         })
         .catch(rethrow);

      // No repository is created. A GitHub repository belongs to the
      // workspace's organization, and making one because somebody made a Berry
      // project would be a surprising thing for a task tracker to do. A project
      // is linked to a repository that already exists, through `githubRepo`.
      const project = created;

      const response = json(
         serializeProject(project, await options.scm?.linkFor('project', created.id)),
         201
      );
      response.headers.set('Location', `/api/v1/projects/${created.id}`);
      return response;
   });

   route.get('/:projectId', async (context) => {
      const { workspaceId, projectId } = await scopeOf(context, projects, 'product.read');
      const found = await projects.get(workspaceId, projectId).catch(rethrow);
      return json(serializeProject(found, await options.scm?.linkFor('project', found.id)));
   });

   route.patch('/:projectId', async (context) => {
      const { workspaceId, projectId } = await scopeOf(context, projects, 'product.write');
      const patch = parsePatch(await readBody(context.req.raw, PROJECT_BODY_FIELDS));
      return json(
         serializeProject(await projects.update(workspaceId, projectId, patch).catch(rethrow))
      );
   });

   route.delete('/:projectId', async (context) => {
      const { workspaceId, projectId } = await scopeOf(context, projects, 'product.write');
      await projects.archive(workspaceId, projectId).catch(rethrow);
      return new Response(null, { status: 204 });
   });

   route.get('/:projectId/resources', async (context) => {
      const { workspaceId, projectId } = await scopeOf(context, projects, 'product.read');
      const url = new URL(context.req.url);
      const page = parsePage(url, []);
      const scope = cursorScope('projects.resources', [projectId]);
      const after = page.after === '' ? null : decodeResourceCursor(page.after, scope);

      const rows = await projects
         .listResources(workspaceId, projectId, after, page.first + 1)
         .catch(rethrow);
      const hasNextPage = rows.length > page.first;
      const nodes = hasNextPage ? rows.slice(0, page.first) : rows;
      const last = nodes.at(-1);
      return json({
         nodes: nodes.map(serializeResource),
         pageInfo: {
            hasNextPage,
            endCursor: last
               ? encodeCursor(scope, { sortOrder: last.sortOrder, id: last.id })
               : null,
         },
      });
   });

   route.post('/:projectId/resources', idempotent(options.idempotency), async (context) => {
      const { workspaceId, projectId, userId } = await scopeOf(context, projects, 'product.write');
      const input = parseCreateResource(await readBody(context.req.raw, RESOURCE_BODY_FIELDS));

      const created = await projects
         .createResource({ workspaceId, projectId, ...input, createdBy: userId })
         .catch(rethrow);
      const response = json(serializeResource(created), 201);
      response.headers.set('Location', `/api/v1/projects/${projectId}/resources/${created.id}`);
      return response;
   });

   route.patch('/:projectId/resources/:resourceId', async (context) => {
      const { workspaceId, projectId } = await scopeOf(context, projects, 'product.write');
      const resourceId = pathUUID(context.req.param('resourceId'), 'Project resource');
      const patch = parseResourcePatch(await readBody(context.req.raw, RESOURCE_BODY_FIELDS));

      return json(
         serializeResource(
            await projects.updateResource(workspaceId, projectId, resourceId, patch).catch(rethrowAs('Project resource'))
         )
      );
   });

   route.delete('/:projectId/resources/:resourceId', async (context) => {
      const { workspaceId, projectId } = await scopeOf(context, projects, 'product.write');
      const resourceId = pathUUID(context.req.param('resourceId'), 'Project resource');
      await projects.archiveResource(workspaceId, projectId, resourceId).catch(rethrowAs('Project resource'));
      return new Response(null, { status: 204 });
   });

   return [{ prefix: '/api/v1/projects', handler: route }];
}

/**
 * The project's workspace, resolved from the project itself.
 *
 * A project is addressed by id alone, so the workspace has to be looked up
 * before it can be authorized — and a project in a workspace the caller is not
 * in reports missing rather than forbidden, because saying "forbidden" would
 * confirm it exists.
 */
async function scopeOf(
   context: { req: { param(name: string): string | undefined }; get(key: 'user'): { id: string } },
   projects: ProjectRepository,
   permission: 'product.read' | 'product.write'
): Promise<{ workspaceId: string; projectId: string; userId: string }> {
   const projectId = pathUUID(context.req.param('projectId'), 'Project');
   const userId = context.get('user').id;
   const workspaceId = await projectWorkspace(projects, projectId);
   await projects.authorize(userId, workspaceId, permission).catch(rethrow);
   return { workspaceId, projectId, userId };
}

async function projectWorkspace(projects: ProjectRepository, projectId: string): Promise<string> {
   const workspaceId = await projects.workspaceFor(projectId);
   if (workspaceId === null) throw notFound('Project');
   return workspaceId;
}

interface CreateInput {
   workspaceId: string;
   name: string;
   description: string | null;
   status: string;
   priority: string;
   startDate: string | null;
   targetDate: string | null;
   githubRepo: string | null;
}

function parseCreate(body: Record<string, unknown>): CreateInput {
   const fields: FieldError[] = [];

   let workspaceId = '';
   if (!('workspaceId' in body) || body.workspaceId === null) {
      fields.push(field('/workspaceId', 'invalid_type', 'Field is required.'));
   } else if (!UUID.test(String(body.workspaceId))) {
      fields.push(field('/workspaceId', 'invalid_format', 'Value must be a canonical UUID.'));
   } else {
      workspaceId = String(body.workspaceId);
   }

   const name = requiredText(body, 'name', 'Name', 1, 200, fields);
   const description = optionalText(body, 'description', 'Description', 20000, fields);
   const status = enumField(body, 'status', 'planned', STATUSES, 'Status', fields);
   const priority = enumField(body, 'priority', 'none', PRIORITIES, 'Priority', fields);
   const startDate = optionalDate(body, 'startDate', fields);
   const targetDate = optionalDate(body, 'targetDate', fields);

   // A project that ends before it starts is a typo, not a schedule.
   if (startDate && targetDate && startDate > targetDate) {
      fields.push(field('/targetDate', 'invalid_range', 'targetDate must be on or after startDate.'));
   }

   let githubRepo: string | null = null;
   if ('githubRepo' in body && body.githubRepo !== null) {
      const trimmed = String(body.githubRepo).trim();
      if (trimmed !== '') {
         if (!GITHUB_REPO.test(trimmed)) {
            fields.push(field('/githubRepo', 'invalid_string', 'Repository must be owner/name.'));
         } else {
            githubRepo = trimmed;
         }
      }
   }

   assertValid(fields);
   if (githubRepo !== null) requireRepositoryResolver();
   return { workspaceId, name, description, status, priority, startDate, targetDate, githubRepo };
}

function parsePatch(body: Record<string, unknown>): ProjectPatch {
   const fields: FieldError[] = [];
   const patch: ProjectPatch = {
      descriptionSet: false,
      startDateSet: false,
      targetDateSet: false,
      githubRepoSet: false,
   };
   let provided = 0;

   if ('name' in body) {
      provided += 1;
      if (body.name === null) {
         fields.push(field('/name', 'invalid_type', 'Name cannot be null.'));
      } else {
         patch.name = text(String(body.name), '/name', 'Name', 1, 200, fields);
      }
   }
   if ('description' in body) {
      provided += 1;
      patch.descriptionSet = true;
      patch.description =
         body.description === null
            ? null
            : text(String(body.description), '/description', 'Description', 0, 20000, fields);
   }
   if ('status' in body) {
      provided += 1;
      if (body.status === null || !STATUSES.has(String(body.status))) {
         fields.push(field('/status', 'invalid_enum_value', 'Status is not supported.'));
      } else {
         patch.status = String(body.status);
      }
   }
   if ('priority' in body) {
      provided += 1;
      if (body.priority === null || !PRIORITIES.has(String(body.priority))) {
         fields.push(field('/priority', 'invalid_enum_value', 'Priority is not supported.'));
      } else {
         patch.priority = String(body.priority);
      }
   }
   if ('startDate' in body) {
      provided += 1;
      patch.startDateSet = true;
      patch.startDate = body.startDate === null ? null : date(body.startDate, '/startDate', fields);
   }
   if ('targetDate' in body) {
      provided += 1;
      patch.targetDateSet = true;
      patch.targetDate =
         body.targetDate === null ? null : date(body.targetDate, '/targetDate', fields);
   }
   if ('githubRepo' in body) {
      provided += 1;
      patch.githubRepoSet = true;
      if (body.githubRepo !== null) {
         const trimmed = String(body.githubRepo).trim();
         if (!GITHUB_REPO.test(trimmed)) {
            fields.push(field('/githubRepo', 'invalid_string', 'Repository must be owner/name.'));
         } else {
            assertValid(fields);
            requireRepositoryResolver();
            patch.githubRepoFullName = trimmed;
         }
      }
      // Clearing is always allowed: unlinking needs no resolver.
   }
   if (provided === 0) {
      fields.push(field('/', 'too_small', 'At least one field must be provided.'));
   }

   assertValid(fields);
   return patch;
}

function parseCreateResource(body: Record<string, unknown>): {
   kind: string;
   url: string;
   label: string | null;
   description: string | null;
   sortOrder: number;
} {
   const fields: FieldError[] = [];

   let kind = 'link';
   if (!('kind' in body) || body.kind === null) {
      fields.push(field('/kind', 'invalid_type', 'Kind is required.'));
   } else if (!RESOURCE_KINDS.has(String(body.kind))) {
      fields.push(field('/kind', 'invalid_enum_value', 'Kind is not supported.'));
   } else {
      kind = String(body.kind);
   }

   let url = '';
   if (!('url' in body) || body.url === null) {
      fields.push(field('/url', 'invalid_type', 'URL is required.'));
   } else {
      url = externalURL(String(body.url), '/url', fields);
   }

   const label = optionalText(body, 'label', 'Label', 200, fields);
   const description = optionalText(body, 'description', 'Description', 2000, fields);
   // Absent means zero. Validating an absent field would report an error the
   // caller cannot act on, and would hide the one they can.
   const sortOrder = 'sortOrder' in body ? sortOrderField(body, fields) : 0;

   assertValid(fields);
   return { kind, url, label, description, sortOrder };
}

function parseResourcePatch(body: Record<string, unknown>): ResourcePatch {
   const fields: FieldError[] = [];
   const patch: ResourcePatch = { labelSet: false, descriptionSet: false };
   let provided = 0;

   if ('kind' in body) {
      provided += 1;
      if (body.kind === null || !RESOURCE_KINDS.has(String(body.kind))) {
         fields.push(field('/kind', 'invalid_enum_value', 'Kind is not supported.'));
      } else {
         patch.kind = String(body.kind);
      }
   }
   if ('url' in body) {
      provided += 1;
      if (body.url === null) {
         fields.push(field('/url', 'invalid_type', 'URL cannot be null.'));
      } else {
         patch.url = externalURL(String(body.url), '/url', fields);
      }
   }
   if ('label' in body) {
      provided += 1;
      patch.labelSet = true;
      patch.label = body.label === null ? null : text(String(body.label), '/label', 'Label', 0, 200, fields);
   }
   if ('description' in body) {
      provided += 1;
      patch.descriptionSet = true;
      patch.description =
         body.description === null
            ? null
            : text(String(body.description), '/description', 'Description', 0, 2000, fields);
   }
   if ('sortOrder' in body) {
      provided += 1;
      patch.sortOrder = sortOrderField(body, fields);
   }
   if (provided === 0) {
      fields.push(field('/', 'too_small', 'At least one field must be provided.'));
   }

   assertValid(fields);
   return patch;
}

/**
 * The cursor scope, hashed over the filter.
 *
 * A different scheme from the issues mount — six bytes of SHA-256 over the
 * filters joined by NUL — because the two mounts were written separately. Both
 * are ported as they are, because a cursor issued by either server has to
 * decode on the other.
 */
export function cursorScope(base: string, filters: string[]): string {
   const digest = createHash('sha256').update(filters.join('\0')).digest('hex');
   return `${base}.${digest.slice(0, 12)}`;
}

function parsePage(url: URL, allowed: string[]): { first: number; after: string } {
   const permitted = new Set(['first', 'after', ...allowed]);
   const seen = new Set<string>();
   for (const name of url.searchParams.keys()) {
      if (!permitted.has(name)) {
         throw invalidQuery(`/query/${name}`, 'Unknown query parameter.');
      }
      if (seen.has(name)) {
         throw invalidQuery(`/query/${name}`, 'Query parameter must appear once.');
      }
      seen.add(name);
   }

   let first = 50;
   const raw = url.searchParams.get('first');
   if (raw !== null && raw !== '') {
      const parsed = /^[+-]?\d+$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
         throw invalidQuery('/query/first', 'first must be an integer from 1 to 100.');
      }
      first = parsed;
   }
   const after = url.searchParams.get('after');
   if (after !== null && after === '') throw invalidCursor();
   return { first, after: after ?? '' };
}

function parseListFilter(url: URL): { query: string; status: string | null; priority: string | null } {
   const query = (url.searchParams.get('query') ?? '').trim();
   if (url.searchParams.has('query') && ([...query].length < 1 || [...query].length > 200)) {
      throw invalidQuery('/query/query', 'query must contain 1 to 200 characters.');
   }

   // Lowercase, naming the query parameter rather than the field label: the
   // query and body validators word these differently in Go.
   const status = url.searchParams.get('status');
   if (status !== null && status !== '' && !STATUSES.has(status)) {
      throw invalidQuery('/query/status', 'status is not supported.');
   }
   const priority = url.searchParams.get('priority');
   if (priority !== null && priority !== '' && !PRIORITIES.has(priority)) {
      throw invalidQuery('/query/priority', 'priority is not supported.');
   }
   return { query, status, priority };
}

function requiredQueryUUID(url: URL, name: string): string {
   const raw = url.searchParams.get(name);
   if (raw === null || raw === '') {
      throw invalidQuery(`/query/${name}`, `${name} is required.`);
   }
   // "canonical" is load-bearing in Go's message: braced and URN spellings
   // are refused, not merely unrecognised.
   if (!UUID.test(raw)) throw invalidQuery(`/query/${name}`, `${name} must be a canonical UUID.`);
   return raw;
}

function decodeProjectCursor(after: string, scope: string): { updatedAt: string; id: string } {
   try {
      return decodeCursor<{ updatedAt: string; id: string }>(after, scope, ['updatedAt', 'id']);
   } catch {
      throw invalidCursor();
   }
}

function decodeResourceCursor(after: string, scope: string): SortOrderCursor {
   try {
      const decoded = decodeCursor<SortOrderCursor>(after, scope, SORT_ORDER_CURSOR_KEYS);
      // Go refuses a negative position outright rather than paging from it.
      if (decoded.sortOrder < 0) throw new Error('negative sort order');
      return decoded;
   } catch {
      throw invalidCursor();
   }
}

// ---- field helpers ---------------------------------------------------------

function requiredText(
   body: Record<string, unknown>,
   name: string,
   label: string,
   minimum: number,
   maximum: number,
   fields: FieldError[]
): string {
   if (!(name in body) || body[name] === null) {
      fields.push(field(`/${name}`, 'invalid_type', `${label} is required.`));
      return '';
   }
   return text(String(body[name]), `/${name}`, label, minimum, maximum, fields);
}

function optionalText(
   body: Record<string, unknown>,
   name: string,
   label: string,
   maximum: number,
   fields: FieldError[]
): string | null {
   if (!(name in body) || body[name] === null) return null;
   return text(String(body[name]), `/${name}`, label, 0, maximum, fields);
}

/** Trimmed, and bounded by rune count as Go bounds it. */
function text(
   value: string,
   path: string,
   label: string,
   minimum: number,
   maximum: number,
   fields: FieldError[]
): string {
   const normalized = value.trim();
   const length = [...normalized].length;
   if (length < minimum) fields.push(field(path, 'too_small', `${label} is too short.`));
   if (length > maximum) fields.push(field(path, 'too_big', `${label} is too long.`));
   return normalized;
}

function enumField(
   body: Record<string, unknown>,
   name: string,
   fallback: string,
   allowed: Set<string>,
   label: string,
   fields: FieldError[]
): string {
   if (!(name in body)) return fallback;
   if (body[name] === null || !allowed.has(String(body[name]))) {
      fields.push(field(`/${name}`, 'invalid_enum_value', `${label} is not supported.`));
      return fallback;
   }
   return String(body[name]);
}

function optionalDate(
   body: Record<string, unknown>,
   name: string,
   fields: FieldError[]
): string | null {
   if (!(name in body) || body[name] === null) return null;
   return date(body[name], `/${name}`, fields);
}

/**
 * A calendar day in exactly `YYYY-MM-DD`.
 *
 * Go re-formats the parsed date and compares it to the input, which rejects
 * `2026-02-30` — a string Date would happily roll forward to March.
 */
function date(value: unknown, path: string, fields: FieldError[]): string | null {
   const raw = String(value);
   if (!ISO_DATE.test(raw)) {
      fields.push(field(path, 'invalid_format', 'Date must use YYYY-MM-DD.'));
      return null;
   }
   const parsed = new Date(`${raw}T00:00:00Z`);
   if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
      fields.push(field(path, 'invalid_format', 'Date must use YYYY-MM-DD.'));
      return null;
   }
   return raw;
}

function externalURL(value: string, path: string, fields: FieldError[]): string {
   const normalized = value.trim();
   let parsed: URL;
   try {
      parsed = new URL(normalized);
   } catch {
      fields.push(
         field(path, 'invalid_format', 'URL must be an HTTP(S) URL without embedded credentials.')
      );
      return normalized;
   }
   if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.host === '' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      normalized.length > 2048
   ) {
      fields.push(
         field(path, 'invalid_format', 'URL must be an HTTP(S) URL without embedded credentials.')
      );
      return normalized;
   }
   return parsed.toString();
}

function sortOrderField(body: Record<string, unknown>, fields: FieldError[]): number {
   const value = body.sortOrder;
   if (value === null || typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
      fields.push(
         field('/sortOrder', 'out_of_range', 'sortOrder must be an integer from 0 to 1000000000.')
      );
      return 0;
   }
   return value;
}

function field(path: string, code: string, message: string): FieldError {
   return { path, code, message };
}

function assertValid(fields: FieldError[]): void {
   if (fields.length > 0) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'The request is invalid.', { fields });
   }
}

/**
 * Refuses to link a repository, because this server cannot resolve one.
 *
 * Berry stores the repository id beside its name, and the id is resolved
 * through GitHub rather than accepted from the caller — a caller-supplied id
 * could name a repository the connection cannot see, and the stored pair would
 * then disagree about where the project delivers. A database constraint keeps
 * the two columns together, so writing a name without an id is not merely
 * incomplete, it is rejected.
 *
 * This is the answer for a deployment without the resolver. A deployment that
 * has one answers 422 REPOSITORY_UNAVAILABLE instead, which is the case this
 * server does not yet cover. Recorded in ROUTING.md.
 */
function requireRepositoryResolver(): never {
   throw new ApiError(
      412,
      'INTEGRATIONS_NOT_CONFIGURED',
      'This deployment cannot resolve GitHub repositories.'
   );
}

function invalidQuery(path: string, message: string): ApiError {
   return new ApiError(400, 'INVALID_REQUEST', 'The request query is invalid.', {
      fields: [field(path, 'invalid', message)],
   });
}

function invalidCursor(): ApiError {
   return new ApiError(400, 'INVALID_CURSOR', 'The pagination cursor is invalid.');
}

function notFound(resource: string): ApiError {
   return new ApiError(404, 'NOT_FOUND', `${resource} not found.`);
}

function pathUUID(raw: string | undefined, resource: string): string {
   if (!raw || !UUID.test(raw.toLowerCase())) throw notFound(resource);
   return raw.toLowerCase();
}

function rethrow(error: unknown): never {
   return rethrowAs('Project')(error);
}

/** The same mapping, naming whichever resource the route was addressing. */
function rethrowAs(resource: string): (error: unknown) => never {
   return (error: unknown) => rethrowResource(error, resource);
}

function rethrowResource(error: unknown, resource: string): never {
   if (error instanceof NotFound) throw notFound(resource);
   if (error instanceof Forbidden) {
      throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
   }
   if (error instanceof Conflict) {
      throw new ApiError(
         409,
         'CONFLICT',
         'The requested project change conflicts with existing data.'
      );
   }
   throw error;
}

const MAX_BODY_BYTES = 64 * 1024;

async function readBody(
   request: Request,
   allowed: Set<string>
): Promise<Record<string, unknown>> {
   const raw = await request.clone().text();
   if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
   }
   let parsed: unknown;
   try {
      parsed = JSON.parse(raw);
   } catch {
      throw ApiError.badRequest('Request body must contain one valid JSON value.');
   }
   if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw ApiError.badRequest('Request body must contain one valid JSON value.');
   }
   const body = parsed as Record<string, unknown>;
   if (Object.keys(body).some((key) => !allowed.has(key))) {
      assertValid([
         field('/', 'invalid_value', 'The request contains an unknown field or invalid value.'),
      ]);
   }
   return body;
}

/**
 * A project as the API renders it, with how its repository provisioning went.
 *
 * `scm` is present so a page never has to infer failure from `gitRepo` being
 * null: "no repository was asked for" and "the repository could not be
 * created" look identical from the column alone, and only one of them is
 * something a person should be told about.
 */
function serializeProject(project: Project, link?: ScmLink | null): Record<string, unknown> {
   return {
      scm: link
         ? {
              provider: link.provider,
              status: link.status,
              url: link.externalUrl,
              error: link.error,
              lastSyncedAt: link.lastSyncedAt,
           }
         : null,
      id: project.id,
      workspaceId: project.workspaceId,
      name: project.name,
      description: project.description,
      status: project.status,
      priority: project.priority,
      startDate: project.startDate,
      targetDate: project.targetDate,
      githubRepo: project.githubRepo,
      gitRepo: project.gitRepo,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
   };
}

function serializeResource(resource: ProjectResource): Record<string, unknown> {
   return {
      id: resource.id,
      projectId: resource.projectId,
      kind: resource.kind,
      url: resource.url,
      label: resource.label,
      description: resource.description,
      sortOrder: resource.sortOrder,
      createdAt: resource.createdAt,
      updatedAt: resource.updatedAt,
   };
}
