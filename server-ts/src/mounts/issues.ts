import type { AgentAccess } from '../agents/access.ts';
import type { ScmSync } from '../scm/sync.ts';
import { Hono } from 'hono';
import { autoDispatch } from '../runs/auto-dispatch.ts';
import type { RunRepository } from '../runs/repository.ts';
import type { StageGate } from '../runs/auto-dispatch.ts';
import type { WorkTrackingHooks } from '../work/hooks.ts';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { ApiError, type FieldError } from '../http/errors.ts';
import {
   UPDATED_CURSOR_KEYS,
   decodeCursor,
   encodeCursor,
   type UpdatedCursor,
} from '../http/cursor.ts';
import { Conflict, Forbidden, NotFound } from '../identity/errors.ts';
import { idempotent } from '../http/idempotent.ts';
import type { IdempotencyStore } from '../http/idempotency.ts';
import type { Broadcaster } from '../realtime/hub.ts';
import type { BoardRepository } from '../core/boards.ts';
import type { GoalLinker } from '../core/goal-linker.ts';
import {
   ApprovalRequired,
   InvalidTransition,
   ProjectNotFound,
   dbStatusToApi,
   escapeSearchLiteral,
   issueCursorScope,
   parseCanonicalUUID,
   type AssigneeInput,
   type Issue,
   type IssueMutationEvent,
   type IssuePatch,
   type IssueRelations,
   type IssueRepository,
} from '../core/issues.ts';
import type { Mount } from '../http/registry.ts';

/**
 * `/api/v1/issues`.
 *
 * Mutations publish through the realtime broadcaster after their transaction
 * commits. The events are already in the outbox by then, so a publish that
 * fails costs open boards their live update rather than the write itself.
 */

const STATUS_TO_DB: Record<string, string> = {
   backlog: 'backlog',
   todo: 'todo',
   inProgress: 'in_progress',
   inReview: 'in_review',
   done: 'done',
   blocked: 'blocked',
   cancelled: 'cancelled',
};

const PRIORITIES = new Set(['none', 'urgent', 'high', 'medium', 'low']);

const PAGE_PARAMS = new Set([
   'first',
   'after',
   'boardId',
   'status',
   'priority',
   'assigneeType',
   'assigneeId',
   'query',
]);

export interface IssueOptions {
   sessions: SessionService;
   issues: IssueRepository;
   boards: BoardRepository;
   idempotency: IdempotencyStore;
   /** Mirrors a task as an issue on the git host. Absent when none is configured. */
   scm?: ScmSync | null;
   /** Absent in a deployment with no relay; mutations then reach only this node. */
   broadcaster?: Broadcaster | undefined;
   /** Who may assign work to which agent. Absent: every member may. */
   agentAccess?: AgentAccess | undefined;
   /** Sub-routes owned by other domains, such as comments. */
   nested?: Hono<{ Variables: AuthVariables }> | undefined;
   /** An issue's dependencies and its AutoGate verdicts. */
   relations?: Hono<{ Variables: AuthVariables }> | undefined;
   /** An issue's runs: the listing, and the request that starts one. */
   runs?: Hono<{ Variables: AuthVariables }> | undefined;
   /** An issue's files: the listing, and the multipart upload. */
   attachments?: Hono<{ Variables: AuthVariables }> | undefined;
   /** What the agents on an issue produced: the listing. */
   artifacts?: Hono<{ Variables: AuthVariables }> | undefined;
   goals?: GoalLinker | undefined;
   /**
    * Where a task assigned to an agent gets its run. Omitted means a task
    * handed to an agent waits for someone to press Run — the behaviour of a
    * deployment with no execution at all.
    */
   dispatch?: RunRepository | undefined;
   /** Work-tracking sub-routes (properties, reactions, children, batch...). */
   tracking?: Hono<{ Variables: AuthVariables }> | undefined;
   /** Holds a staged sub-issue until its earlier stages finish. */
   stages?: StageGate | undefined;
   /** Subscriptions, inbox rows and stage release after a write. */
   hooks?: WorkTrackingHooks | undefined;
}

export function issueMounts(options: IssueOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   // Routes that belong to another domain but hang under an issue. Mounted
   // here rather than registered on their own prefix, because the registry
   // refuses two mounts on `/api/v1/issues` — which is the ambiguity it exists
   // to refuse.
   // First, so its collection routes (`/assignee-frequency`, `/batch`) are
   // matched before `/:issueRef` reads them as an issue reference.
   if (options.tracking) route.route('/', options.tracking);
   if (options.nested) route.route('/', options.nested);
   if (options.relations) route.route('/', options.relations);
   if (options.runs) route.route('/', options.runs);
   if (options.attachments) route.route('/', options.attachments);
   if (options.artifacts) route.route('/', options.artifacts);

   const { issues, boards } = options;

   route.get('/', async (context) => {
      const query = parseIssueQuery(new URL(context.req.url));

      // The board is authorized before the filter is used, so an unreadable
      // board cannot be probed through the shape of its results.
      await boards
         .authorize(context.get('user').id, query.boardId, 'product.read')
         .catch(rethrow(true));

      const scope = issueCursorScope(query);
      const after = query.after === '' ? null : decodeIssueCursor(query.after, scope);

      const rows = await issues.list({
         boardId: query.boardId,
         statuses: query.statuses,
         priorities: query.priorities,
         assignee: query.assignee,
         query: query.query,
         after,
         limit: query.first + 1,
      });
      const hasNextPage = rows.length > query.first;
      const nodes = hasNextPage ? rows.slice(0, query.first) : rows;

      const relations = await issues.loadRelations(nodes.map((issue) => issue.id));
      const last = nodes.at(-1);
      return json({
         nodes: nodes.map((issue) => serializeIssue(issue, relations.get(issue.id))),
         pageInfo: {
            hasNextPage,
            endCursor: last ? encodeCursor(scope, { updatedAt: last.updatedAt, id: last.id }) : null,
         },
      });
   });

   route.get('/:issueRef', async (context) => {
      // Fetched before authorization because the reference may be an
      // identifier, and the issue's own id is what the check needs.
      const issue = await issues.get(context.req.param('issueRef') ?? '').catch(rethrow(false));
      await issues.authorize(context.get('user').id, issue.id, 'product.read').catch(rethrow(false));

      const relations = await issues.loadRelations([issue.id]);
      return json(serializeIssue(issue, relations.get(issue.id)));
   });


   route.post('/', idempotent(options.idempotency), async (context) => {
      const body = await readBody(context.req.raw);
      const input = parseCreate(body);

      // `in_review` and `done` cannot be an issue's first state: both mean
      // work has already been through a stage that never happened.
      if (input.status === 'in_review' || input.status === 'done') {
         throw invalidTransition('backlog', dbStatusToApi(input.status));
      }

      const user = context.get('user');
      const scope = await boards
         .authorize(user.id, input.boardId, 'product.write')
         .catch(rethrow(true));
      if (input.assignee) await assertAssignee(issues, scope.workspaceId, input.assignee);
      if (options.agentAccess && input.assignee?.type === 'agent') {
         await options.agentAccess.assertCanAssign({
            workspaceId: scope.workspaceId,
            agentId: input.assignee.id,
            userId: user.id,
         });
      }

      const created = await issues
         .create({
            boardId: input.boardId,
            title: input.title,
            description: input.description,
            status: input.status,
            priority: input.priority,
            sortOrder: input.sortOrder,
            dueDate: input.dueDate,
            assignee: input.assignee,
            project: input.project,
            createdBy: user.id,
         })
         .catch(rethrowWrite('created'));

      await publish(options, created.events);
      await options.hooks
         ?.afterIssueWrite({
            kind: 'created',
            issue: created.issue,
            previousStatus: null,
            previousAssigneeId: null,
            actorId: user.id,
            workspaceId: scope.workspaceId,
            eventIds: created.events.map((event) => event.id),
         })
         .catch(() => undefined);
      if (input.goalSet) {
         await applyGoal(options, scope.workspaceId, created.issue.id, input.goal, user.id);
      }
      // A task made for an agent starts. Re-read afterwards so the response
      // carries the run the task now has.
      let issueToServe = created.issue;
      if (options.dispatch) {
         const run = await autoDispatch(
            options.dispatch,
            created.issue,
            { workspaceId: scope.workspaceId, requestedBy: user.id },
            options.stages
         );
         if (run) issueToServe = await issues.get(created.issue.id);
      }

      // After the goal is applied, not before: the issue on the host is filed
      // under the goal's milestone, and that link has to exist to be read.
      options.scm?.guard('issue.created', options.scm.issueCreated(created.issue.id));

      const relations = await issues.loadRelations([created.issue.id]);
      const response = json(serializeIssue(issueToServe, relations.get(created.issue.id)), 201);
      response.headers.set('Location', `/api/v1/issues/${created.issue.id}`);
      return response;
   });

   route.patch('/:issueRef', async (context) => {
      const found = await issues.get(context.req.param('issueRef') ?? '').catch(rethrow(false));
      const user = context.get('user');
      const scope = await issues.authorize(user.id, found.id, 'product.write').catch(rethrow(false));

      const { patch, goal, goalSet } = parsePatch(await readBody(context.req.raw));
      if (patch.assigneeSet && patch.assignee) {
         await assertAssignee(issues, scope.workspaceId, patch.assignee);
         if (options.agentAccess && patch.assignee.type === 'agent') {
            await options.agentAccess.assertCanAssign({
               workspaceId: scope.workspaceId,
               agentId: patch.assignee.id,
               userId: user.id,
            });
         }
      }

      let updated = found;
      // A patch naming only a goal changes no column, so the row is left
      // alone and no mutation event is published for it.
      if (touchesIssueRow(patch)) {
         const result = await issues
            .update({ issueId: found.id, patch, actorId: user.id })
            .catch(rethrowWrite('updated'));
         updated = result.issue;
         await publish(options, result.events);
         await options.hooks
            ?.afterIssueWrite({
               kind: 'updated',
               issue: result.issue,
               previousStatus: found.status,
               previousAssigneeId: found.assignee?.id ?? null,
               actorId: user.id,
               workspaceId: scope.workspaceId,
               eventIds: result.events.map((event) => event.id),
            })
            .catch(() => undefined);
         // Assigned to an agent, or moved to todo while assigned to one: the
         // same rule as creation, checked on every edit that touches the row.
         if (options.dispatch) {
            const run = await autoDispatch(
               options.dispatch,
               updated,
               { workspaceId: scope.workspaceId, requestedBy: user.id },
               options.stages
            );
            if (run) updated = await issues.get(found.id);
         }
      }
      if (goalSet) await applyGoal(options, scope.workspaceId, found.id, goal, user.id);

      // Title, body, state and milestone are Berry's to own, so an edit here
      // is pushed outward. The reverse direction arrives by webhook.
      options.scm?.guard('issue.updated', options.scm.issueUpdated(found.id));

      const relations = await issues.loadRelations([found.id]);
      return json(serializeIssue(updated, relations.get(found.id)));
   });

   route.delete('/:issueRef', async (context) => {
      const found = await issues.get(context.req.param('issueRef') ?? '').catch(rethrow(false));
      const user = context.get('user');
      await issues.authorize(user.id, found.id, 'product.write').catch(rethrow(false));

      const removed = await issues
         .remove({ issueId: found.id, deletedBy: user.id })
         .catch(rethrow(false));
      await publish(options, removed.events);
      return new Response(null, { status: 204 });
   });

   return [{ prefix: '/api/v1/issues', handler: route }];
}

interface IssueQuery {
   first: number;
   after: string;
   boardId: string;
   statuses: string[] | null;
   priorities: string[] | null;
   assignee: AssigneeInput | null;
   query: string | null;
}

/**
 * The list filter.
 *
 * Statuses and priorities are sorted, because the cursor scope is a hash of
 * this filter — leaving them in the order the caller wrote them would make
 * `status=todo,done` and `status=done,todo` two different pages of the same
 * query, and a cursor from one invalid against the other.
 */
function parseIssueQuery(url: URL): IssueQuery {
   const seen = new Set<string>();
   for (const name of url.searchParams.keys()) {
      if (!PAGE_PARAMS.has(name) || seen.has(name)) throw invalidQuery();
      seen.add(name);
   }

   let first = 50;
   const rawFirst = url.searchParams.get('first');
   if (rawFirst !== null && rawFirst !== '') {
      const parsed = /^[+-]?\d+$/.test(rawFirst) ? Number(rawFirst) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
         throw invalidQuery([
            { path: '/query/first', code: 'invalid', message: 'first must be an integer from 1 to 100.' },
         ]);
      }
      first = parsed;
   }

   const after = url.searchParams.get('after');
   if (after !== null && after === '') throw invalidCursor();

   const boardId = parseCanonicalUUID(url.searchParams.get('boardId') ?? '');
   if (boardId === null) {
      throw invalidQuery([
         { path: '/query/boardId', code: 'invalid_string', message: 'boardId must be a UUID.' },
      ]);
   }

   let statuses: string[] | null = null;
   if (url.searchParams.has('status')) {
      const values = parseCSV(url.searchParams.get('status') ?? '');
      statuses = values.map((value) => {
         const mapped = STATUS_TO_DB[value];
         if (mapped === undefined) throw invalidQuery();
         return mapped;
      });
      statuses.sort();
   }

   let priorities: string[] | null = null;
   if (url.searchParams.has('priority')) {
      priorities = parseCSV(url.searchParams.get('priority') ?? '');
      for (const value of priorities) if (!PRIORITIES.has(value)) throw invalidQuery();
      priorities.sort();
   }

   // Both halves of an assignee filter or neither: an id without a type could
   // match a user and an agent that happen to share it.
   const hasType = url.searchParams.has('assigneeType');
   const hasId = url.searchParams.has('assigneeId');
   if (hasType !== hasId) throw invalidQuery();
   let assignee: AssigneeInput | null = null;
   if (hasType) {
      const type = url.searchParams.get('assigneeType') ?? '';
      if (type !== 'user' && type !== 'agent') throw invalidQuery();
      const id = parseCanonicalUUID(url.searchParams.get('assigneeId') ?? '');
      if (id === null) throw invalidQuery();
      assignee = { type, id };
   }

   let query: string | null = null;
   if (url.searchParams.has('query')) {
      const raw = url.searchParams.get('query') ?? '';
      const length = [...raw].length;
      if (length < 1 || length > 200) throw invalidQuery();
      query = escapeSearchLiteral(raw);
   }

   return { first, after: after ?? '', boardId, statuses, priorities, assignee, query };
}

/** Go's strings.Split on ",", with every element required to be non-empty. */
function parseCSV(raw: string): string[] {
   const values = raw.split(',');
   if (values.length === 0 || values.some((value) => value === '')) throw invalidQuery();
   return values;
}

function decodeIssueCursor(after: string, scope: string): UpdatedCursor {
   try {
      // Keyed updatedAt, not createdAt: issues page by recency of change, and
      // a cursor issued by either server has to decode on the other.
      return decodeCursor<UpdatedCursor>(after, scope, UPDATED_CURSOR_KEYS);
   } catch {
      throw invalidCursor();
   }
}

function invalidQuery(fields?: FieldError[]): ApiError {
   return new ApiError(
      400,
      'INVALID_REQUEST',
      'The request query is invalid.',
      fields ? { fields } : null
   );
}

function invalidCursor(): ApiError {
   return new ApiError(400, 'INVALID_CURSOR', 'The pagination cursor is invalid.');
}

/**
 * Domain failures in this mount's words.
 *
 * `boardScoped` picks which resource a missing row describes: a filter naming
 * an unreadable board reports the board missing, while a direct read of an
 * issue reports the issue.
 */
function rethrow(boardScoped: boolean): (error: unknown) => never {
   return (error: unknown) => {
      if (error instanceof NotFound) {
         throw new ApiError(404, 'NOT_FOUND', boardScoped ? 'Board not found.' : 'Issue not found.');
      }
      if (error instanceof Forbidden) {
         throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
      }
      throw error;
   };
}

/** Field order follows Go's struct declaration, which is what goes on the wire. */
export function serializeIssue(issue: Issue, relations: IssueRelations | undefined): Record<string, unknown> {
   return {
      id: issue.id,
      boardId: issue.boardId,
      number: issue.number,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      status: issue.status,
      priority: issue.priority,
      sortOrder: issue.sortOrder,
      dueDate: issue.dueDate,
      assignee: issue.assignee,
      activeRunId: issue.activeRunId,
      project: issue.project,
      createdBy: issue.createdBy,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      goal: relations?.goal ?? null,
      // Always arrays: the frontend maps over them without a guard.
      dependsOn: relations?.dependsOn ?? [],
      blocks: relations?.blocks ?? [],
      parentId: issue.parentId,
      stage: issue.stage,
      statusId: issue.statusId,
      childProgress: issue.childProgress,
   };
}

/**
 * Publishes what a mutation produced.
 *
 * Best effort, and deliberately so: the events are already in the outbox
 * inside the transaction that made them, so a relay outage costs open boards
 * their live update, not the write. Failing the request here would mean an
 * issue could not be created because a cache was down.
 */
async function publish(options: IssueOptions, events: IssueMutationEvent[]): Promise<void> {
   if (!options.broadcaster) return;
   for (const event of events) {
      try {
         await options.broadcaster.publish({
            id: event.id,
            workspaceId: event.workspaceId,
            boardId: event.boardId,
            type: event.type,
            payload: event.payload,
            occurredAt: event.occurredAt,
         });
      } catch {
         // Logged by the broadcaster's own observer; nothing to do here.
      }
   }
}

/**
 * An assignee must exist in *this* workspace.
 *
 * The repository only checks that a user row exists at all. Without the
 * workspace check an issue could be assigned to someone from another
 * workspace, whose name would then render on a board they cannot open.
 */
async function assertAssignee(
   issues: IssueRepository,
   workspaceId: string,
   assignee: AssigneeInput
): Promise<void> {
   const present = await issues.assigneeExistsInWorkspace(
      workspaceId,
      assignee.type,
      assignee.id
   );
   if (!present) throw new ApiError(404, 'NOT_FOUND', 'Board or assignee not found.');
}

/** Links, relinks or clears an issue's goal. */
async function applyGoal(
   options: IssueOptions,
   workspaceId: string,
   issueId: string,
   goalId: string | null,
   actorId: string
): Promise<void> {
   if (!options.goals) return;
   if (goalId === null) {
      await options.goals.clearIssueGoal(issueId);
      return;
   }
   // Scoped to the workspace: a goal from elsewhere is reported missing
   // rather than linked.
   const linked = await options.goals.linkIssue(workspaceId, goalId, issueId, actorId);
   if (!linked) {
      throw new ApiError(
         422,
         'GOAL_NOT_FOUND',
         'That goal does not exist in this workspace.'
      );
   }
}

/** Whether a patch changes the issue row, as opposed to only its goal link. */
function touchesIssueRow(patch: IssuePatch): boolean {
   return (
      patch.title !== undefined ||
      patch.descriptionSet ||
      patch.status !== undefined ||
      patch.priority !== undefined ||
      patch.sortOrder !== undefined ||
      patch.dueDateSet ||
      patch.assigneeSet ||
      patch.projectSet
   );
}

interface CreateInput {
   boardId: string;
   title: string;
   description: string | null;
   status: string;
   priority: string;
   sortOrder: number;
   dueDate: string | null;
   assignee: AssigneeInput | null;
   project: string | null;
   goal: string | null;
   goalSet: boolean;
}

function parseCreate(body: Record<string, unknown>): CreateInput {
   const fields: FieldError[] = [];

   let boardId = '';
   if (!('boardId' in body) || body.boardId === null) {
      fields.push(field('/boardId', 'invalid_type', 'Field is required.'));
   } else {
      const parsed = parseCanonicalUUID(String(body.boardId));
      if (parsed === null) {
         fields.push(field('/boardId', 'invalid_string', 'boardId must be a UUID.'));
      } else {
         boardId = parsed;
      }
   }

   let title = '';
   if (!('title' in body) || body.title === null) {
      fields.push(field('/title', 'invalid_type', 'Field is required.'));
   } else {
      title = String(body.title).trim();
      validateLength(title, '/title', 1, 500, 'Title', fields);
   }

   let description: string | null = null;
   if ('description' in body && body.description !== null) {
      const value = String(body.description);
      if ([...value].length > 100000) {
         fields.push(
            field('/description', 'too_big', 'Description must contain at most 100000 characters.')
         );
      }
      description = value;
   }

   const status = enumField(body, 'status', 'backlog', STATUS_TO_DB, 'Status', fields);
   const priority = enumField(body, 'priority', 'none', PRIORITY_IDENTITY, 'Priority', fields);

   let sortOrder = 0;
   if ('sortOrder' in body) {
      if (body.sortOrder === null) {
         fields.push(field('/sortOrder', 'invalid_type', 'sortOrder cannot be null.'));
      } else {
         sortOrder = Number(body.sortOrder);
      }
   }

   const dueDate = optionalDate(body, 'dueDate', fields);
   const assignee = optionalAssignee(body, fields);
   const project = optionalUUID(body, 'projectId', 'projectId must be a UUID.', fields);
   const goal = goalChange(body, fields);

   assertValid(fields);
   return {
      boardId,
      title,
      description,
      status,
      priority,
      sortOrder,
      dueDate,
      assignee,
      project: project.value,
      goal: goal.value,
      goalSet: goal.set,
   };
}

function parsePatch(body: Record<string, unknown>): {
   patch: IssuePatch;
   goal: string | null;
   goalSet: boolean;
} {
   const fields: FieldError[] = [];
   const patch: IssuePatch = {
      descriptionSet: false,
      dueDateSet: false,
      assigneeSet: false,
      projectSet: false,
   };
   let provided = 0;

   const goal = goalChange(body, fields);
   if (goal.set) provided += 1;

   if ('title' in body) {
      provided += 1;
      if (body.title === null) {
         fields.push(field('/title', 'invalid_type', 'Title cannot be null.'));
      } else {
         const title = String(body.title).trim();
         validateLength(title, '/title', 1, 500, 'Title', fields);
         patch.title = title;
      }
   }
   if ('description' in body) {
      provided += 1;
      patch.descriptionSet = true;
      if (body.description !== null) {
         const value = String(body.description);
         if ([...value].length > 100000) {
            fields.push(
               field('/description', 'too_big', 'Description must contain at most 100000 characters.')
            );
         }
         patch.description = value;
      } else {
         patch.description = null;
      }
   }
   if ('status' in body) {
      provided += 1;
      if (body.status === null) {
         fields.push(field('/status', 'invalid_type', 'Status cannot be null.'));
      } else {
         const mapped = STATUS_TO_DB[String(body.status)];
         if (mapped === undefined) {
            fields.push(field('/status', 'invalid_enum_value', 'Status is not supported.'));
         } else {
            patch.status = mapped;
         }
      }
   }
   if ('priority' in body) {
      provided += 1;
      if (body.priority === null) {
         fields.push(field('/priority', 'invalid_type', 'Priority cannot be null.'));
      } else if (!PRIORITIES.has(String(body.priority))) {
         fields.push(field('/priority', 'invalid_enum_value', 'Priority is not supported.'));
      } else {
         patch.priority = String(body.priority);
      }
   }
   if ('sortOrder' in body) {
      provided += 1;
      if (body.sortOrder === null) {
         fields.push(field('/sortOrder', 'invalid_type', 'sortOrder cannot be null.'));
      } else {
         patch.sortOrder = Number(body.sortOrder);
      }
   }
   if ('dueDate' in body) {
      provided += 1;
      patch.dueDateSet = true;
      patch.dueDate = optionalDate(body, 'dueDate', fields);
   }
   if ('assignee' in body) {
      provided += 1;
      patch.assigneeSet = true;
      patch.assignee = optionalAssignee(body, fields);
   }
   if ('projectId' in body) {
      provided += 1;
      // Explicit null unlinks. The set flag is what separates that from an
      // absent field, so patching a title alone does not drop the project.
      patch.projectSet = true;
      patch.project = optionalUUID(body, 'projectId', 'Project id must be a UUID.', fields).value;
   }
   if (provided === 0) {
      fields.push(field('/', 'too_small', 'At least one field must be provided.'));
   }

   assertValid(fields);
   return { patch, goal: goal.value, goalSet: goal.set };
}

const PRIORITY_IDENTITY: Record<string, string> = Object.fromEntries(
   [...PRIORITIES].map((value) => [value, value])
);

function enumField(
   body: Record<string, unknown>,
   name: string,
   fallback: string,
   mapping: Record<string, string>,
   label: string,
   fields: FieldError[]
): string {
   if (!(name in body)) return fallback;
   if (body[name] === null) {
      fields.push(field(`/${name}`, 'invalid_type', `${label} cannot be null.`));
      return fallback;
   }
   const mapped = mapping[String(body[name])];
   if (mapped === undefined) {
      fields.push(field(`/${name}`, 'invalid_enum_value', `${label} is not supported.`));
      return fallback;
   }
   return mapped;
}

function optionalDate(
   body: Record<string, unknown>,
   name: string,
   fields: FieldError[]
): string | null {
   if (!(name in body) || body[name] === null) return null;
   const raw = String(body[name]);
   const parsed = new Date(raw);
   // Date accepts "2026-08-27"; RFC 3339 requires the time and a zone.
   if (
      Number.isNaN(parsed.getTime()) ||
      !/^\d{4}-\d{2}-\d{2}[Tt].+([Zz]|[+-]\d{2}:\d{2})$/.test(raw)
   ) {
      fields.push(field(`/${name}`, 'invalid_string', 'Date must be an RFC 3339 timestamp.'));
      return null;
   }
   return parsed.toISOString();
}

function optionalAssignee(
   body: Record<string, unknown>,
   fields: FieldError[]
): AssigneeInput | null {
   const raw = body.assignee;
   if (raw === undefined || raw === null) return null;
   const value = (raw ?? {}) as { type?: unknown; id?: unknown };

   const type = String(value.type ?? '');
   const validType = type === 'user' || type === 'agent';
   if (!validType) {
      fields.push(field('/assignee/type', 'invalid_enum_value', 'Assignee type must be user or agent.'));
   }
   const id = parseCanonicalUUID(String(value.id ?? ''));
   if (id === null) {
      fields.push(field('/assignee/id', 'invalid_string', 'Assignee id must be a UUID.'));
   }
   return validType && id !== null ? { type, id } : null;
}

function optionalUUID(
   body: Record<string, unknown>,
   name: string,
   message: string,
   fields: FieldError[]
): { set: boolean; value: string | null } {
   if (!(name in body)) return { set: false, value: null };
   if (body[name] === null) return { set: true, value: null };
   // Looser than parseCanonicalUUID on purpose: Go uses uuid.Parse here, not
   // its stricter ParseUUID, so the brace and URN spellings are accepted.
   const raw = String(body[name]).trim();
   const parsed = looseUUID(raw);
   if (parsed === null) {
      fields.push(field(`/${name}`, name === 'projectId' ? 'invalid_string' : 'invalid', message));
      return { set: true, value: null };
   }
   return { set: true, value: parsed };
}

function goalChange(
   body: Record<string, unknown>,
   fields: FieldError[]
): { set: boolean; value: string | null } {
   if (!('goalId' in body)) return { set: false, value: null };
   if (body.goalId === null) return { set: true, value: null };
   const parsed = looseUUID(String(body.goalId).trim());
   if (parsed === null) {
      fields.push(field('/goalId', 'invalid_string', 'goalId must be a UUID.'));
      return { set: true, value: null };
   }
   return { set: true, value: parsed };
}

/** uuid.Parse: canonical, braced or URN, and not the nil UUID. */
function looseUUID(raw: string): string | null {
   const stripped = raw
      .replace(/^urn:uuid:/i, '')
      .replace(/^\{/, '')
      .replace(/\}$/, '');
   if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stripped)) {
      return null;
   }
   const lowered = stripped.toLowerCase();
   return lowered === '00000000-0000-0000-0000-000000000000' ? null : lowered;
}

function validateLength(
   value: string,
   path: string,
   minimum: number,
   maximum: number,
   label: string,
   fields: FieldError[]
): void {
   const length = [...value].length;
   if (length < minimum) {
      fields.push(field(path, 'too_small', `${label} must contain at least ${minimum} character.`));
   } else if (length > maximum) {
      fields.push(field(path, 'too_big', `${label} must contain at most ${maximum} characters.`));
   }
}

function field(path: string, code: string, message: string): FieldError {
   return { path, code, message };
}

function assertValid(fields: FieldError[]): void {
   if (fields.length > 0) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'The request is invalid.', { fields });
   }
}

function invalidTransition(from: string, to: string): ApiError {
   return new ApiError(
      409,
      'INVALID_STATE_TRANSITION',
      `Cannot transition an issue from "${from}" to "${to}".`,
      { from, to }
   );
}

/** Write failures, in this mount's words. */
function rethrowWrite(verb: 'created' | 'updated'): (error: unknown) => never {
   return (error: unknown) => {
      if (error instanceof InvalidTransition) throw invalidTransition(error.from, error.to);
      if (error instanceof ApprovalRequired) {
         throw new ApiError(
            409,
            'APPROVAL_REQUIRED',
            'The issue is waiting for approval and cannot be queued for an agent.',
            { approvalId: null }
         );
      }
      if (error instanceof ProjectNotFound) {
         throw new ApiError(
            422,
            'PROJECT_NOT_FOUND',
            'That project does not exist in this workspace.'
         );
      }
      if (error instanceof NotFound) {
         throw new ApiError(
            404,
            'NOT_FOUND',
            verb === 'created' ? 'Board or assignee not found.' : 'Issue or assignee not found.'
         );
      }
      if (error instanceof Forbidden) {
         throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
      }
      if (error instanceof Conflict) {
         throw new ApiError(
            409,
            'CONFLICT',
            `Issue could not be ${verb} because its state conflicts.`
         );
      }
      throw error;
   };
}

const MAX_ISSUE_BODY_BYTES = 1024 * 1024;

/**
 * Fields a create or patch may carry.
 *
 * Go's decoder is given DisallowUnknownFields, so a typo is a 422 rather than
 * a value silently dropped — a client that sent `assigneeId` and got 201 would
 * believe it had assigned the issue.
 */
const ISSUE_BODY_FIELDS = new Set([
   'boardId',
   'title',
   'description',
   'status',
   'priority',
   'sortOrder',
   'dueDate',
   'assignee',
   'projectId',
   'goalId',
]);

async function readBody(request: Request): Promise<Record<string, unknown>> {
   const raw = await request.clone().text();
   if (Buffer.byteLength(raw, 'utf8') > MAX_ISSUE_BODY_BYTES) {
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
   if (Object.keys(body).some((key) => !ISSUE_BODY_FIELDS.has(key))) {
      assertValid([
         field('/', 'invalid_type', 'The request body contains an unknown field or invalid value.'),
      ]);
   }
   return body;
}
