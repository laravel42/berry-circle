import type { ScmSync } from '../scm/sync.ts';
import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import { UPDATED_CURSOR_KEYS, decodeCursor, encodeCursor, type UpdatedCursor } from '../http/cursor.ts';
import { idempotent } from '../http/idempotent.ts';
import type { IdempotencyStore } from '../http/idempotency.ts';
import type { Broadcaster } from '../realtime/hub.ts';
import { Conflict, Forbidden, NotFound } from '../identity/errors.ts';
import type { Mount } from '../http/registry.ts';
import { cursorScope } from './projects.ts';
import type { IssueRepository } from '../core/issues.ts';
import type { ActorRef } from '../core/comments.ts';
import {
   InvalidTransition,
   isGoalStatus,
   type Goal,
   type GoalEvent,
   type GoalRepository,
   type GoalStatus,
   type Progress,
} from '../core/goals.ts';

/**
 * `/api/v1/goals`.
 *
 * Two of its sub-lists read tables no mount here owns — approvals and
 * approvals belong to AUTOMATE, plans to the planner. They are served anyway
 * because they depend on those *tables* and not on that code: a goal has to
 * be able to say what points at it without owning any of it.
 */

const MAX_TITLE = 500;
const MAX_DESCRIPTION = 20_000;
const MAX_QUERY = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CREATE_FIELDS = new Set(['workspaceId', 'title', 'description', 'projectId']);
const UPDATE_FIELDS = new Set(['title', 'description', 'status', 'projectId']);

export interface GoalOptions {
   sessions: SessionService;
   goals: GoalRepository;
   issues: IssueRepository;
   idempotency: IdempotencyStore;
   /** Mirrors a goal as a milestone. Absent when the deployment runs no git host. */
   scm?: ScmSync | null;
   broadcaster?: Broadcaster | undefined;
   clock?: () => Date;
}

export function goalMounts(options: GoalOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   const { goals, issues } = options;
   const clock = options.clock ?? (() => new Date());

   route.get('/', async (context) => {
      const url = new URL(context.req.url);
      const page = parsePage(url, ['workspaceId', 'query', 'status', 'projectId']);
      const workspaceId = requiredUUID(url, 'workspaceId');
      const filter = parseFilter(url);

      await goals
         .authorizeWorkspace(context.get('user').id, workspaceId, 'product.read')
         .catch(rethrow('Workspace'));

      const scope = cursorScope('goals.list', [
         workspaceId,
         filter.query,
         filter.status ?? '',
         url.searchParams.get('projectId') ?? '',
      ]);
      const after =
         page.after === ''
            ? null
            : decodeCursor<UpdatedCursor>(page.after, scope, UPDATED_CURSOR_KEYS);

      const rows = await goals.list(workspaceId, filter, after, page.first + 1);
      const hasNextPage = rows.length > page.first;
      const nodes = hasNextPage ? rows.slice(0, page.first) : rows;
      const authors = await goals.lookupAuthors(nodes.map((goal) => goal.createdBy ?? ''));
      const last = nodes.at(-1);
      return json({
         // Progress is deliberately absent from a listing: it is five counting
         // subqueries per goal, and a list of a hundred would pay all of them
         // to render a number the list does not show.
         nodes: nodes.map((goal) => serializeGoal(goal, authors, null)),
         pageInfo: {
            hasNextPage,
            endCursor: last ? encodeCursor(scope, { updatedAt: last.updatedAt, id: last.id }) : null,
         },
      });
   });

   route.post('/', idempotent(options.idempotency), async (context) => {
      const body = await readBody(context.req.raw, CREATE_FIELDS);
      const workspaceId = requiredBodyUUID(body.workspaceId, 'workspaceId');
      await goals
         .authorizeWorkspace(context.get('user').id, workspaceId, 'settings.write')
         .catch(rethrow('Workspace'));

      const title = requiredText(body.title, 'title', MAX_TITLE);
      const description = optionalText(body, 'description', MAX_DESCRIPTION);
      const projectId = optionalUUID(body, 'projectId');

      const created = await goals
         .create({
            workspaceId,
            title,
            ...(description === undefined ? {} : { description }),
            ...(projectId === undefined ? {} : { projectId }),
            createdBy: context.get('user').id,
            createdAt: clock().toISOString(),
         })
         .catch(rethrow('Goal'));
      await publish(options, [created.event]);

      // Not awaited: the goal exists and is the answer to this request. The
      // milestone is a mirror of it, and its outcome is recorded on the goal's
      // link rather than held against the response.
      options.scm?.guard('goal.created', options.scm.goalCreated(created.goal.id));

      const authors = await goals.lookupAuthors([created.goal.createdBy ?? '']);
      return json(serializeGoal(created.goal, authors, null), 201);
   });

   route.get('/:goalId', async (context) => {
      const goalId = pathId(context.req.param('goalId'));
      await goals.authorize(context.get('user').id, goalId, 'product.read').catch(rethrow('Goal'));
      const goal = await goals.get(goalId).catch(rethrow('Goal'));
      const [authors, progress] = await Promise.all([
         goals.lookupAuthors([goal.createdBy ?? '']),
         goals.progress(goalId),
      ]);
      return json(serializeGoal(goal, authors, progress));
   });

   /**
    * A patch and a transition in one request.
    *
    * They are separate operations underneath — the fields move under a lock,
    * the status moves through the lifecycle — and each writes its own event,
    * so a client that renamed a goal and started it sees both facts.
    */
   route.patch('/:goalId', async (context) => {
      const goalId = pathId(context.req.param('goalId'));
      await goals.authorize(context.get('user').id, goalId, 'product.write').catch(rethrow('Goal'));

      const body = await readBody(context.req.raw, UPDATE_FIELDS);
      const patch = {
         ...(body.title === undefined ? {} : { title: patchTitle(body.title) }),
         ...('description' in body
            ? { description: optionalText(body, 'description', MAX_DESCRIPTION) ?? null, descriptionSet: true }
            : {}),
         ...('projectId' in body ? { projectId: optionalUUID(body, 'projectId') ?? null, projectSet: true } : {}),
      };
      const status = parseStatus(body.status);
      if (Object.keys(patch).length === 0 && status === undefined) {
         throw invalidField('/', 'At least one field must be provided.', 'too_small');
      }

      const events: GoalEvent[] = [];
      const now = clock();
      let goal: Goal | null = null;
      if (Object.keys(patch).length > 0) {
         const updated = await goals
            .update(goalId, patch, context.get('user').id, now.toISOString())
            .catch(rethrow('Goal'));
         goal = updated.goal;
         events.push(updated.event);
      }
      if (status !== undefined) {
         // A microsecond later, so the two facts order stably: a consumer
         // replaying by time must not see the status change before the rename
         // that shared its request.
         const at = new Date(now.getTime() + 1);
         const moved = await goals
            .transition(goalId, status, context.get('user').id, at.toISOString())
            .catch(rethrow('Goal'));
         goal = moved.goal;
         if (moved.event) events.push(moved.event);
      }
      await publish(options, events);

      const resolved = goal ?? (await goals.get(goalId).catch(rethrow('Goal')));
      const [authors, progress] = await Promise.all([
         goals.lookupAuthors([resolved.createdBy ?? '']),
         goals.progress(goalId),
      ]);
      return json(serializeGoal(resolved, authors, progress));
   });

   route.delete('/:goalId', async (context) => {
      const goalId = pathId(context.req.param('goalId'));
      await goals.authorize(context.get('user').id, goalId, 'settings.write').catch(rethrow('Goal'));
      const event = await goals
         .archive(goalId, context.get('user').id, clock().toISOString())
         .catch(rethrow('Goal'));
      await publish(options, [event]);
      return new Response(null, { status: 204 });
   });

   route.get('/:goalId/issues', async (context) => {
      const goalId = pathId(context.req.param('goalId'));
      await goals.authorize(context.get('user').id, goalId, 'product.read').catch(rethrow('Goal'));
      return json({ nodes: await goals.listIssues(goalId) });
   });

   route.put('/:goalId/issues/:issueRef', async (context) => {
      const goalId = pathId(context.req.param('goalId'));
      const scope = await goals
         .authorize(context.get('user').id, goalId, 'product.write')
         .catch(rethrow('Goal'));
      const issue = await resolveIssue(issues, context.req.param('issueRef'), context.get('user').id, scope.workspaceId);

      await goals
         .linkIssue({
            workspaceId: scope.workspaceId,
            goalId,
            issueId: issue.id,
            actorId: context.get('user').id,
            now: clock().toISOString(),
         })
         .catch(rethrow('Issue'));
      return new Response(null, { status: 204 });
   });

   route.delete('/:goalId/issues/:issueRef', async (context) => {
      const goalId = pathId(context.req.param('goalId'));
      const scope = await goals
         .authorize(context.get('user').id, goalId, 'product.write')
         .catch(rethrow('Goal'));
      const issue = await resolveIssue(issues, context.req.param('issueRef'), context.get('user').id, scope.workspaceId);
      await goals.unlinkIssue(goalId, issue.id).catch(rethrow('Issue'));
      return new Response(null, { status: 204 });
   });

   route.get('/:goalId/approvals', async (context) => {
      const goalId = pathId(context.req.param('goalId'));
      const scope = await goals
         .authorize(context.get('user').id, goalId, 'product.read')
         .catch(rethrow('Goal'));
      return json({ nodes: await goals.listApprovals(goalId, scope.workspaceId) });
   });

   route.get('/:goalId/plans', async (context) => {
      const goalId = pathId(context.req.param('goalId'));
      await goals.authorize(context.get('user').id, goalId, 'product.read').catch(rethrow('Goal'));
      return json({ nodes: await goals.listPlans(goalId) });
   });

   return [{ prefix: '/api/v1/goals', handler: route }];
}

/**
 * The issue named in the path, inside the goal's workspace.
 *
 * The workspace check is what stops a goal linking an issue somebody can see
 * in another workspace: the caller may reach both, and the link would still be
 * wrong.
 */
async function resolveIssue(
   issues: IssueRepository,
   reference: string | undefined,
   userId: string,
   workspaceId: string
) {
   const issue = await issues.get(reference ?? '').catch(rethrow('Issue'));
   await issues.authorize(userId, issue.id, 'product.write').catch(rethrow('Issue'));
   if (issue.workspaceId !== workspaceId) throw ApiError.notFound('Issue');
   return issue;
}

function serializeGoal(
   goal: Goal,
   authors: Map<string, ActorRef>,
   progress: Progress | null
): Record<string, unknown> {
   return {
      id: goal.id,
      workspaceId: goal.workspaceId,
      projectId: goal.projectId,
      title: goal.title,
      description: goal.description,
      status: goal.status,
      source: goal.source,
      sourcePrompt: goal.sourcePrompt,
      // A goal whose author's row is gone still had an author, and naming
      // nobody would read as a goal that created itself.
      createdBy: goal.createdBy
         ? (authors.get(goal.createdBy) ?? {
              type: 'user',
              id: goal.createdBy,
              name: 'Unknown user',
              avatarUrl: null,
           })
         : null,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      startedAt: goal.startedAt,
      completedAt: goal.completedAt,
      // Omitted rather than null when absent, matching Go's `omitempty`.
      ...(progress ? { progress } : {}),
   };
}

function parseFilter(url: URL): { query: string; status: GoalStatus | null; projectId: string | null } {
   const query = (url.searchParams.get('query') ?? '').trim();
   if ([...query].length > MAX_QUERY) {
      throw invalidQuery('/query/query', `query is at most ${MAX_QUERY} characters.`);
   }
   const rawStatus = url.searchParams.get('status') ?? '';
   if (rawStatus !== '' && !isGoalStatus(rawStatus)) {
      throw invalidQuery('/query/status', 'status is not a goal status.');
   }
   const rawProject = url.searchParams.get('projectId') ?? '';
   if (rawProject !== '' && !UUID.test(rawProject)) {
      throw invalidQuery('/query/projectId', 'projectId must be a canonical UUID.');
   }
   return {
      query,
      status: rawStatus === '' ? null : (rawStatus as GoalStatus),
      projectId: rawProject === '' ? null : rawProject,
   };
}

function parsePage(url: URL, allowed: string[]): { first: number; after: string } {
   const permitted = new Set(['first', 'after', ...allowed]);
   for (const name of url.searchParams.keys()) {
      if (!permitted.has(name)) throw invalidQuery(`/query/${name}`, 'Unknown query parameter.');
      if (url.searchParams.getAll(name).length !== 1) {
         throw invalidQuery(`/query/${name}`, 'Query parameter must appear once.');
      }
   }
   const raw = url.searchParams.get('first') ?? '';
   let first = 50;
   if (raw !== '') {
      first = Number(raw);
      if (!Number.isInteger(first) || first < 1 || first > 100) {
         throw invalidQuery('/query/first', 'first must be an integer from 1 to 100.');
      }
   }
   return { first, after: url.searchParams.get('after') ?? '' };
}

async function readBody(request: Request, allowed: Set<string>): Promise<Record<string, unknown>> {
   const raw = await request.text();
   let parsed: unknown;
   try {
      parsed = JSON.parse(raw === '' ? '{}' : raw);
   } catch {
      throw invalidBody('The request body is not valid JSON.');
   }
   if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw invalidBody('The request body is not valid JSON.');
   }
   for (const key of Object.keys(parsed)) {
      if (!allowed.has(key)) {
         throw invalidField('/', 'The request contains an unknown field or invalid value.', 'invalid_value');
      }
   }
   return parsed as Record<string, unknown>;
}

/**
 * A title on a patch may not be null.
 *
 * Absent means "leave it"; null would have to mean "clear it", and a goal with
 * no title is not something the product can render — so it is refused with its
 * own code rather than folded into "invalid".
 */
function patchTitle(value: unknown): string {
   if (value === null) throw invalidField('/title', 'title cannot be null.', 'invalid_type');
   return requiredText(value, 'title', MAX_TITLE);
}

function requiredText(value: unknown, field: string, limit: number): string {
   if (typeof value !== 'string' || value.trim() === '') {
      throw invalidField(`/${field}`, `${field} must contain 1 to ${limit} characters.`);
   }
   const trimmed = value.trim();
   if ([...trimmed].length > limit) {
      throw invalidField(`/${field}`, `${field} must contain 1 to ${limit} characters.`);
   }
   return trimmed;
}

/** Absent leaves the field alone; null or empty clears it. */
function optionalText(
   body: Record<string, unknown>,
   field: string,
   limit: number
): string | null | undefined {
   if (!(field in body)) return undefined;
   if (body[field] === null) return null;
   if (typeof body[field] !== 'string') throw invalidField(`/${field}`, `${field} must be a string.`);
   const trimmed = (body[field] as string).trim();
   if ([...trimmed].length > limit) {
      throw invalidField(`/${field}`, `${field} must contain at most ${limit} characters.`, 'too_big');
   }
   return trimmed === '' ? null : trimmed;
}

function optionalUUID(body: Record<string, unknown>, field: string): string | null | undefined {
   if (!(field in body)) return undefined;
   if (body[field] === null) return null;
   if (typeof body[field] !== 'string' || !UUID.test(body[field] as string)) {
      throw invalidField(`/${field}`, `${field} must be a canonical UUID.`);
   }
   return body[field] as string;
}

function requiredBodyUUID(value: unknown, field: string): string {
   if (typeof value !== 'string' || !UUID.test(value)) {
      throw invalidField(`/${field}`, `${field} must be a canonical UUID.`);
   }
   return value;
}

/**
 * The statuses a caller may ask for.
 *
 * `blocked` is missing on purpose: it is the dispatcher's, set when a goal's
 * work waits on something a person must do, and letting a client set it would
 * let them claim a goal is blocked by nothing.
 */
function parseStatus(value: unknown): GoalStatus | undefined {
   if (value === undefined) return undefined;
   if (typeof value !== 'string' || !isGoalStatus(value) || value === 'blocked') {
      throw invalidField(
         '/status',
         'status is draft, planned, active, completed or cancelled.',
         'invalid_enum_value'
      );
   }
   return value;
}

function requiredUUID(url: URL, name: string): string {
   const raw = url.searchParams.get(name) ?? '';
   if (!UUID.test(raw)) throw invalidQuery(`/query/${name}`, `${name} must be a canonical UUID.`);
   return raw;
}

function pathId(raw: string | undefined): string {
   if (!raw || !UUID.test(raw)) throw ApiError.notFound('Goal');
   return raw.toLowerCase();
}

function invalidQuery(path: string, message: string): ApiError {
   return new ApiError(400, 'INVALID_REQUEST', 'The request query is invalid.', {
      fields: [{ path, code: 'invalid', message }],
   });
}

function invalidField(path: string, message: string, code = 'invalid'): ApiError {
   return new ApiError(422, 'VALIDATION_FAILED', 'The request is invalid.', {
      fields: [{ path, code, message }],
   });
}

function invalidBody(message: string): ApiError {
   return new ApiError(400, 'INVALID_REQUEST', message);
}

function rethrow(resource: string): (error: unknown) => never {
   return (error: unknown) => {
      if (error instanceof InvalidTransition) {
         throw new ApiError(
            422,
            'GOAL_TRANSITION_INVALID',
            `A goal cannot move from "${error.from}" to "${error.to}".`,
            { from: error.from, to: error.to }
         );
      }
      if (error instanceof NotFound) throw ApiError.notFound(resource);
      if (error instanceof Forbidden) {
         throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
      }
      // A conflict on a goal write is always the project: it is the only
      // foreign key a caller supplies, so "conflict" here means they named one
      // that is not in this workspace.
      if (error instanceof Conflict) {
         throw new ApiError(
            422,
            'PROJECT_NOT_FOUND',
            'That project does not exist in this workspace.'
         );
      }
      throw error;
   };
}

async function publish(options: GoalOptions, events: GoalEvent[]): Promise<void> {
   if (!options.broadcaster) return;
   for (const event of events) {
      await options.broadcaster
         .publish({
            id: event.id,
            workspaceId: event.workspaceId,
            type: event.type,
            payload: event.payload,
            occurredAt: event.occurredAt,
         })
         .catch(() => undefined);
   }
}
