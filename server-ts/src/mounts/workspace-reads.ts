import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { assertValid, decodeBody, fieldError } from '../http/body.ts';
import { decodeTimeCursor, encodeCursor, parsePageQuery } from '../http/cursor.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import type { ScopedDb } from '../identity/workspace-context.ts';
import type { BoardRepository } from '../core/boards.ts';
import { toRFC3339, type Sql } from '../db/pool.ts';
import {
   mountWorkspaceScope,
   pathId,
   resolveScoped,
   rethrowScoped,
   type ScopedVariables,
} from './shared.ts';

/**
 * `/search`, `/views` and `/catalogs`.
 *
 * One file rather than three, because each is a thin layer over a single
 * table and splitting them would be three modules of boilerplate. They share
 * the same shape — workspace-scoped, cursor-paged — and are registered as
 * three mounts because the registry addresses by prefix and `/search` and
 * `/views` are not the same resource.
 *
 * `/catalogs` is the only one that writes: it is the workspace's vocabularies,
 * which is what the settings pages edit. Editing a vocabulary needs
 * `settings.write`; reading it needs only membership, because every list in
 * the product renders labels and statuses.
 */

const MAX_QUERY = 200;

/**
 * What the palette may ask for. `board` stays for API callers even though the
 * palette no longer requests it: a board has no page of its own to open.
 */
export const SEARCH_TYPES = ['issue', 'board', 'project', 'agent', 'chat', 'skill'] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

function isSearchType(value: string): value is SearchType {
   return (SEARCH_TYPES as readonly string[]).includes(value);
}

/**
 * The `types` query parameter, as a set. Absent means issues, which is what
 * the parameter meant before it grew; an unknown name is a 422 rather than a
 * silent drop, so a client asking for a type this server lacks finds out.
 */
export function parseSearchTypes(raw: string | null): Set<SearchType> {
   const names = (raw ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
   if (names.length === 0) return new Set<SearchType>(['issue']);
   const types = new Set<SearchType>();
   for (const name of names) {
      if (!isSearchType(name)) {
         assertValid([
            fieldError('/types', 'invalid_value', `types are ${SEARCH_TYPES.join(', ')}.`),
         ]);
      } else {
         types.add(name);
      }
   }
   return types;
}

export interface WorkspaceReadOptions {
   sessions: SessionService;
   sql: Sql;
   boards: BoardRepository;
   /** Extra `/:workspaceId/...` catalog routes (work tracking). */
   catalogExtensions?: Hono<{ Variables: ScopedVariables }> | undefined;
   /** Extra `/api/v1/views` routes (saved-view writes, preferences, query). */
   viewExtensions?: Hono<{ Variables: AuthVariables }> | undefined;
}

export function workspaceReadMounts(options: WorkspaceReadOptions): Mount[] {
   return [
      { prefix: '/api/v1/search', handler: searchRoute(options) },
      { prefix: '/api/v1/views', handler: viewsRoute(options) },
      { prefix: '/api/v1/catalogs', handler: catalogsRoute(options) },
   ];
}

/**
 * What the command palette calls on every keystroke.
 *
 * Prefix matching over titles and identifiers rather than full-text search:
 * someone typing `BER-4` wants BER-4, and a ranking function would have to be
 * taught that. Bounded by `first` and never paged — a palette that needed a
 * second page would be the wrong shape for the question.
 */
function searchRoute(options: WorkspaceReadOptions): Hono<{ Variables: AuthVariables }> {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   route.get('/', async (context) => {
      const url = new URL(context.req.url);
      const db = await requireWorkspace(context, options, url);
      const page = parsePageQuery(url, ['workspaceId', 'query', 'types']);

      const query = (url.searchParams.get('query') ?? '').trim();
      if (query === '') {
         assertValid([fieldError('/query', 'required', 'query is required.')]);
      }
      if (query.length > MAX_QUERY) {
         assertValid([fieldError('/query', 'too_long', `query is at most ${MAX_QUERY} characters.`)]);
      }
      const types = parseSearchTypes(url.searchParams.get('types'));

      // Escaped for LIKE, not for SQL: the value is parameterised, but `%` and
      // `_` inside it would otherwise be wildcards the person did not type.
      const like = `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
      const nodes: Array<Record<string, unknown>> = [];

      if (types.has('issue')) {
         // The workspace predicate is `board.workspace_id = ctx.workspaceId`,
         // the confirmed scope re-derived through the join, not the raw param.
         const rows = await db.list((q) => q.sql`
            SELECT issue.id, issue.title, issue.board_id, board.name AS board_name,
                   issue.status::text AS status,
                   berry_issue_identifier(board.workspace_id, issue.number) AS identifier
              FROM issues AS issue
              JOIN boards AS board ON board.id = issue.board_id
             WHERE board.workspace_id = ${q.workspaceId}
               AND issue.deleted_at IS NULL
               AND (issue.title ILIKE ${like}
                    OR berry_issue_identifier(board.workspace_id, issue.number) ILIKE ${like})
             ORDER BY issue.updated_at DESC, issue.id DESC
             LIMIT ${page.first}`);
         for (const row of rows) {
            nodes.push({
               type: 'issue',
               id: row.id as string,
               title: row.title as string,
               subtitle: (row.board_name as string | null) ?? null,
               identifier: (row.identifier as string | null) ?? null,
               boardId: row.board_id as string,
               agentId: null,
               // What state the task is in. A palette that cannot tell a
               // cancelled task from a live one offers them as equals, which
               // is how a closed task gets reopened by mistake.
               status: (row.status as string | null) ?? null,
            });
         }
      }

      if (types.has('board')) {
         // `scope` is the pre-bound `workspace_id = ctx.workspaceId` fragment.
         const rows = await db.list((q) => q.sql`
            SELECT id, name, description
              FROM boards
             WHERE ${q.scope} AND name ILIKE ${like}
             ORDER BY updated_at DESC, id DESC
             LIMIT ${page.first}`);
         for (const row of rows) {
            nodes.push({
               type: 'board',
               id: row.id as string,
               title: row.name as string,
               subtitle: (row.description as string | null) ?? null,
               identifier: null,
               boardId: row.id as string,
               agentId: null,
            });
         }
      }

      if (types.has('project')) {
         // `scope` is the pre-bound `workspace_id = ctx.workspaceId` fragment.
         const rows = await db.list((q) => q.sql`
            SELECT id, name, description
              FROM projects
             WHERE ${q.scope} AND deleted_at IS NULL AND name ILIKE ${like}
             ORDER BY updated_at DESC, id DESC
             LIMIT ${page.first}`);
         for (const row of rows) {
            nodes.push({
               type: 'project',
               id: row.id as string,
               title: row.name as string,
               subtitle: (row.description as string | null) ?? null,
               identifier: null,
               boardId: null,
               agentId: null,
            });
         }
      }

      if (types.has('agent')) {
         const rows = await db.list((q) => q.sql`
            SELECT id, name, description
              FROM agents
             WHERE ${q.scope} AND archived_at IS NULL AND name ILIKE ${like}
             ORDER BY name ASC, id ASC
             LIMIT ${page.first}`);
         for (const row of rows) {
            nodes.push({
               type: 'agent',
               id: row.id as string,
               title: row.name as string,
               subtitle: (row.description as string | null) ?? null,
               identifier: null,
               boardId: null,
               agentId: row.id as string,
            });
         }
      }

      if (types.has('chat')) {
         // Membership is not enough for a conversation: it is private to its
         // participants, so the caller must be one. The workspace predicate is
         // still the confirmed scope, so a thread in another workspace the
         // caller happens to be in never answers a search here.
         const userId = context.get('user').id;
         const rows = await db.list((q) => q.sql`
            SELECT conversation.id, conversation.topic,
                   agent.id AS agent_id, agent.name AS agent_name
              FROM conversations AS conversation
              JOIN conversation_participants AS me
                ON me.conversation_id = conversation.id
               AND me.participant_type = 'user'
               AND me.participant_id = ${userId}
               AND me.left_at IS NULL
              -- One agent per thread (LATERAL + LIMIT 1), so a thread with two
              -- agents is one row, not two with a duplicate React key. The agent
              -- is re-scoped to the confirmed workspace: participant_id has no
              -- FK, so an unscoped join could surface another tenant's agent name.
              LEFT JOIN LATERAL (
                 SELECT candidate.id, candidate.name
                   FROM conversation_participants AS bot
                   JOIN agents AS candidate
                     ON candidate.id = bot.participant_id
                    AND candidate.workspace_id = ${q.workspaceId}
                  WHERE bot.conversation_id = conversation.id
                    AND bot.participant_type = 'agent'
                    AND bot.left_at IS NULL
                  ORDER BY bot.joined_at ASC, candidate.id ASC
                  LIMIT 1
              ) AS agent ON true
             WHERE conversation.workspace_id = ${q.workspaceId}
               AND conversation.status = 'open'
               AND (conversation.topic ILIKE ${like} OR agent.name ILIKE ${like})
             ORDER BY conversation.updated_at DESC, conversation.id DESC
             LIMIT ${page.first}`);
         for (const row of rows) {
            const agentName = (row.agent_name as string | null) ?? null;
            nodes.push({
               type: 'chat',
               id: row.id as string,
               title: (row.topic as string | null) ?? agentName ?? 'Conversation',
               subtitle: agentName,
               identifier: null,
               boardId: null,
               agentId: (row.agent_id as string | null) ?? null,
            });
         }
      }

      if (types.has('skill') && (await skillsCatalogueExists(options.sql))) {
         const rows = await db.list((q) => q.sql`
            SELECT id, name, description
              FROM skills
             WHERE ${q.scope} AND name ILIKE ${like}
             ORDER BY name ASC, id ASC
             LIMIT ${page.first}`);
         for (const row of rows) {
            nodes.push({
               type: 'skill',
               id: row.id as string,
               title: row.name as string,
               subtitle: (row.description as string | null) ?? null,
               identifier: null,
               boardId: null,
               agentId: null,
            });
         }
      }

      // No cursor: a palette shows what it can and the person types more.
      return json({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
   });

   return route;
}

/**
 * Whether the skills catalogue has been migrated in yet. Skills belong to
 * another workstream's migration; until it lands, a skill search is an empty
 * answer rather than a 500 from a missing relation. A catalogue probe, not
 * workspace data, so it runs on the pool rather than through the scope.
 */
async function skillsCatalogueExists(sql: Sql): Promise<boolean> {
   const [row] = await sql`SELECT to_regclass('public.skills') IS NOT NULL AS present`;
   return row?.present === true;
}

/**
 * Saved views.
 *
 * A person's own, plus the workspace's shared ones. Someone else's private
 * view is not listed and not addressable, which is what `private` means.
 */
function viewsRoute(options: WorkspaceReadOptions): Hono<{ Variables: AuthVariables }> {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   if (options.viewExtensions) route.route('/', options.viewExtensions);

   route.get('/', async (context) => {
      const url = new URL(context.req.url);
      const db = await requireWorkspace(context, options, url);
      const page = parsePageQuery(url, ['workspaceId']);
      // The cursor scope keys off the confirmed workspace, not the raw param.
      const workspaceId = db.ctx.workspaceId;
      const scope = `views.${workspaceId}.${context.get('user').id}`;
      const after = page.after === '' ? null : decodeTimeCursor(page.after, scope);

      // `q.scope` is `workspace_id = ctx.workspaceId`, re-derived scope only.
      const rows = await db.list((q) => q.sql`
         SELECT id, workspace_id, owner_id, name, visibility, definition_version,
                query, display, revision, created_at, updated_at
           FROM saved_issue_views
          WHERE ${q.scope}
            AND (visibility <> 'private' OR owner_id = ${context.get('user').id})
            AND (${after === null} OR (created_at, id) <
                 (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT ${page.first + 1}`);

      return json(
         connection(rows, page.first, scope, (row) => ({
            id: row.id as string,
            workspaceId: row.workspace_id as string,
            ownerId: row.owner_id as string,
            name: row.name as string,
            visibility: row.visibility as string,
            definitionVersion: Number(row.definition_version),
            query: row.query,
            display: row.display,
            revision: Number(row.revision),
            createdAt: toRFC3339(row.created_at as string)!,
            updatedAt: toRFC3339(row.updated_at as string)!,
         }))
      );
   });

   return route;
}

/**
 * The workspace's vocabularies. Today: its issue labels.
 *
 * Addressed as `/catalogs/{workspaceId}/issue-labels` rather than
 * `/issue-labels?workspaceId=` because that is what the shell calls, and
 * because a catalogue belongs to its workspace in a way a filter does not.
 */
function catalogsRoute(options: WorkspaceReadOptions): Hono<{ Variables: ScopedVariables }> {
   const route = new Hono<{ Variables: ScopedVariables }>();
   // Mechanism B constructing C: requireSession + the context resolver attach a
   // membership-confirmed `ScopedDb` as `scoped` for every `/:workspaceId/...`
   // route below, so a handler never touches the database without a scope.
   mountWorkspaceScope(route, { sessions: options.sessions, sql: options.sql });
   if (options.catalogExtensions) route.route('/', options.catalogExtensions);

   /**
    * Labels are workspace vocabulary and a task can carry any of them, so
    * reading is membership and writing is `settings.write`.
    */
   route.get('/:workspaceId/issue-labels', async (context) => {
      const db = context.get('scoped');

      const url = new URL(context.req.url);
      const page = parsePageQuery(url);
      // Key the cursor off the confirmed scope, not the path lookup key.
      const scope = `catalogs.labels.${db.ctx.workspaceId}`;
      const after = page.after === '' ? null : decodeTimeCursor(page.after, scope);

      // `q.scope` is `workspace_id = ctx.workspaceId`, the re-derived scope.
      const rows = await db.list((q) => q.sql`
         SELECT id, workspace_id, name, description, color, created_at, updated_at, archived_at,
                (SELECT count(*) FROM issue_label_memberships AS membership
                  WHERE membership.workspace_id = issue_labels.workspace_id
                    AND membership.label_id = issue_labels.id) AS usage_count
           FROM issue_labels
          WHERE ${q.scope}
            AND (${after === null} OR (created_at, id) <
                 (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT ${page.first + 1}`);

      return json(
         connection(rows, page.first, scope, (row) => ({
            id: row.id as string,
            workspaceId: row.workspace_id as string,
            name: row.name as string,
            description: (row.description as string | null) ?? null,
            color: row.color as string,
            createdAt: toRFC3339(row.created_at as string)!,
            updatedAt: toRFC3339(row.updated_at as string)!,
            // Archived rows are listed rather than hidden: a label already on
            // a task still has to be nameable, and the caller decides whether
            // to offer it for a new one.
            archivedAt: toRFC3339(row.archived_at as string | null),
            // How many tasks carry it. Appended, so the field order the wire
            // contract checks is kept. Counted rather than stored: a label is
            // added and removed often enough that a cached number would be
            // wrong more often than it was right.
            usageCount: Number(row.usage_count ?? 0),
         }))
      );
   });

   route.post('/:workspaceId/issue-labels', async (context) => {
      const db = context.get('scoped');
      const userId = context.get('user').id;
      const input = await readLabel(context);

      // Authorize (`settings.write`) and write in one transaction: a role that
      // lacks the permission is refused with 403 before any row is touched, and
      // the insert against the confirmed scope rolls back on any throw.
      const row = await db.mutate('settings.write', async (tx, ctx) => {
         const [inserted] = await tx`
            INSERT INTO issue_labels (workspace_id, name, description, color, created_by)
            VALUES (${ctx.workspaceId}, ${input.name}, ${input.description}, ${input.color},
                    ${userId})
            ON CONFLICT (workspace_id, lower(name)) WHERE archived_at IS NULL
            DO NOTHING
            RETURNING id, workspace_id, name, description, color, created_at, updated_at, archived_at`;
         // Nothing returned means the name is taken. Reported rather than
         // silently reusing the existing label: someone creating "urgent" when
         // "Urgent" exists wants to know, not to be quietly given the other one.
         if (!inserted) {
            throw new ApiError(409, 'CONFLICT', 'A label with that name already exists.');
         }
         return inserted;
      }).catch(rethrowScoped('Label'));
      return json(serializeLabel(row), 201);
   });

   route.patch('/:workspaceId/issue-labels/:labelId', async (context) => {
      const db = context.get('scoped');
      const labelId = pathId(context.req.param('labelId'), 'Label');
      const input = await readLabel(context, { partial: true });

      // Locate, authorize and update: the label is found in the confirmed
      // scope first, so a label in another workspace or none at all is the
      // same 404 for every role; only then is a role without `settings.write`
      // refused with 403. The update itself runs in one transaction.
      const row = await db.mutate('settings.write', async (tx, ctx) => {
         const [updated] = await tx`
            UPDATE issue_labels
               SET name = COALESCE(${input.name}, name),
                   description = CASE WHEN ${input.describedGiven} THEN ${input.description} ELSE description END,
                   color = COALESCE(${input.color}, color),
                   updated_at = now()
             WHERE id = ${labelId} AND workspace_id = ${ctx.workspaceId}
             RETURNING id, workspace_id, name, description, color, created_at, updated_at, archived_at`;
         if (!updated) throw ApiError.notFound('Label');
         return updated;
      }, { table: 'issue_labels', id: labelId }).catch(rethrowScoped('Label'));
      return json(serializeLabel(row));
   });

   /**
    * Archives a label rather than deleting it.
    *
    * A label already on a task has to stay nameable — deleting the row would
    * leave every task that carries it showing a blank chip, and the unique
    * index only covers live rows, so the name becomes free again either way.
    */
   route.delete('/:workspaceId/issue-labels/:labelId', async (context) => {
      const db = context.get('scoped');
      const labelId = pathId(context.req.param('labelId'), 'Label');

      // Locate, authorize and archive, scoped to the confirmed workspace: a
      // label elsewhere is 404 for every role, a role without `settings.write`
      // is 403 on one of its own, and either rejection leaves the row untouched.
      await db.mutate('settings.write', async (tx, ctx) => {
         const rows = await tx`
            UPDATE issue_labels SET archived_at = now(), updated_at = now()
             WHERE id = ${labelId} AND workspace_id = ${ctx.workspaceId} AND archived_at IS NULL
             RETURNING id`;
         if (rows.length === 0) throw ApiError.notFound('Label');
      }, { table: 'issue_labels', id: labelId }).catch(rethrowScoped('Label'));
      return new Response(null, { status: 204 });
   });

   /**
    * The statuses a task can be in.
    *
    * Seven of them are system rows whose `key` must match their category — the
    * table enforces it — because the board's columns and the run ledger both
    * address them by category. They can be renamed and recoloured; they cannot
    * be removed, and this never offers to.
    */
   route.get('/:workspaceId/issue-statuses', async (context) => {
      const db = context.get('scoped');
      // Archived statuses are off by default, because every caller but the
      // settings page wants the statuses a task can be put into now. The
      // settings page asks for them so that archiving is something a reader
      // can see the result of, and undo.
      const includeArchived =
         new URL(context.req.url).searchParams.get('includeArchived') === 'true';
      // `q.scope` is `workspace_id = ctx.workspaceId`, the re-derived scope.
      const rows = await db.list((q) => q.sql`
         SELECT id, key, name, description, category, color, sort_order, is_system, archived_at
           FROM issue_status_definitions
          WHERE ${q.scope} AND (${includeArchived}::boolean OR archived_at IS NULL)
          ORDER BY sort_order ASC, key ASC`);
      return json({
         nodes: rows.map((row) => ({
            id: row.id as string,
            key: row.key as string,
            name: row.name as string,
            description: (row.description as string | null) ?? null,
            category: row.category as string,
            color: row.color as string,
            sortOrder: Number(row.sort_order),
            isSystem: Boolean(row.is_system),
            // Appended, so the field order the wire contract checks is kept.
            archivedAt: toRFC3339(row.archived_at as string | null),
         })),
      });
   });

   route.patch('/:workspaceId/issue-statuses/:statusId', async (context) => {
      const db = context.get('scoped');
      const statusId = pathId(context.req.param('statusId'), 'Status');

      const { value } = await decodeBody<{
         name?: string;
         description?: string;
         color?: string;
         sortOrder?: number;
         archived?: boolean;
      }>(context, {
         name: 'string',
         description: 'string',
         color: 'string',
         sortOrder: 'number',
         archived: 'boolean',
      });

      const problems = [];
      const name = value.name === undefined ? null : value.name.trim();
      if (name !== null && (name.length < 1 || name.length > 100)) {
         problems.push(fieldError('/name', 'invalid_length', 'name is 1 to 100 characters.'));
      }
      if (value.color !== undefined && !/^#[0-9a-f]{6}$/.test(value.color)) {
         problems.push(fieldError('/color', 'invalid_value', 'color is a hex value like #6366f1.'));
      }
      if (value.sortOrder !== undefined && (!Number.isInteger(value.sortOrder) || value.sortOrder < 0)) {
         problems.push(fieldError('/sortOrder', 'invalid_value', 'sortOrder is a whole number.'));
      }
      // Only `false` — bringing a status back. Archiving is the DELETE route,
      // which also has to detach the tasks that are in the status; doing it
      // from a patch would archive it and leave them pointing at nothing.
      if (value.archived !== undefined && value.archived !== false) {
         problems.push(fieldError('/archived', 'invalid_value', 'archived can only be set to false.'));
      }
      if (problems.length > 0) assertValid(problems);

      // Neither `key` nor `category` is patchable, whatever is sent: the board
      // and the ledger address a status by category, and a rename there would
      // move every task that is in it. Authorize (`settings.write`) and the
      // update run in one transaction scoped to the confirmed workspace.
      const row = await db.mutate('settings.write', async (tx, ctx) => {
         const [updated] = await tx`
            UPDATE issue_status_definitions
               SET archived_at = CASE WHEN ${value.archived === false} THEN NULL ELSE archived_at END,
                   name = COALESCE(${name}, name),
                   description = CASE WHEN ${'description' in value} THEN ${value.description ?? null} ELSE description END,
                   color = COALESCE(${value.color ?? null}, color),
                   sort_order = COALESCE(${value.sortOrder ?? null}, sort_order),
                   updated_at = now()
             WHERE id = ${statusId} AND workspace_id = ${ctx.workspaceId}
             RETURNING id, key, name, description, category, color, sort_order, is_system, archived_at`;
         if (!updated) throw ApiError.notFound('Status');
         return updated;
      }, { table: 'issue_status_definitions', id: statusId }).catch(rethrowScoped('Status'));
      return json({
         id: row.id as string,
         key: row.key as string,
         name: row.name as string,
         description: (row.description as string | null) ?? null,
         category: row.category as string,
         color: row.color as string,
         sortOrder: Number(row.sort_order),
         isSystem: Boolean(row.is_system),
         archivedAt: toRFC3339(row.archived_at as string | null),
      });
   });

   return route;
}

// ------------------------------------------------------------------ helpers

const LABEL_COLOR = /^#[0-9a-f]{6}$/;

function serializeLabel(row: Record<string, unknown>): Record<string, unknown> {
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      color: row.color as string,
      createdAt: toRFC3339(row.created_at as string)!,
      updatedAt: toRFC3339(row.updated_at as string)!,
      archivedAt: toRFC3339((row.archived_at as string | null) ?? null),
   };
}

async function readLabel(
   context: Parameters<typeof decodeBody>[0],
   options: { partial?: boolean } = {}
) {
   const { value } = await decodeBody<{ name?: string; description?: string; color?: string }>(
      context,
      { name: 'string', description: 'string', color: 'string' }
   );
   const problems = [];
   const name = value.name === undefined ? null : value.name.trim();
   if (!options.partial && (name === null || name === '')) {
      problems.push(fieldError('/name', 'required', 'name is required.'));
   }
   if (name !== null && name.length > 100) {
      problems.push(fieldError('/name', 'too_long', 'name is at most 100 characters.'));
   }
   const color = value.color ?? (options.partial ? null : '#6366f1');
   if (color !== null && !LABEL_COLOR.test(color)) {
      problems.push(fieldError('/color', 'invalid_value', 'color is a hex value like #6366f1.'));
   }
   if (problems.length > 0) assertValid(problems);

   return {
      name: name === '' ? null : name,
      color,
      description: (value.description ?? '').trim() || null,
      describedGiven: 'description' in value,
   };
}

function connection<T extends { id: string; createdAt: string }>(
   rows: Array<Record<string, unknown>>,
   first: number,
   scope: string,
   serialize: (row: Record<string, unknown>) => T
): Record<string, unknown> {
   const hasNextPage = rows.length > first;
   const nodes = (hasNextPage ? rows.slice(0, first) : rows).map(serialize);
   const last = nodes.at(-1);
   return {
      nodes,
      pageInfo: {
         hasNextPage,
         endCursor: last ? encodeCursor(scope, { createdAt: last.createdAt, id: last.id }) : null,
      },
   };
}

/**
 * Re-derives a `ScopedDb` for a query-param `workspaceId`.
 *
 * The `workspaceId` search param is only a lookup key: it is validated for
 * presence, then handed to {@link resolveWorkspaceContext}, which confirms the
 * caller's membership before it becomes a trusted scope. A non-member and an
 * absent workspace are indistinguishable (both 404), so the query parameter
 * cannot probe which workspaces exist. The returned surface is bound to the
 * *confirmed* `ctx.workspaceId`, never the raw request string.
 */
async function requireWorkspace(
   context: { get: (key: 'user') => { id: string } },
   options: WorkspaceReadOptions,
   url: URL
): Promise<ScopedDb> {
   const workspaceId = url.searchParams.get('workspaceId');
   if (!workspaceId) {
      assertValid([fieldError('/workspaceId', 'required', 'workspaceId is required.')]);
   }
   // `search` and `views` take `workspaceId` as a query parameter, so they
   // cannot use the `/:workspaceId/*` prefix of `mountWorkspaceScope`; they go
   // through the same gate via `resolveScoped` instead. A read needs only
   // membership, so the permission is the default `product.read`. A non-member
   // or absent workspace is 404 (indistinguishable), so the query parameter
   // cannot probe which workspaces exist.
   return resolveScoped(options.sql, context.get('user').id, workspaceId!);
}
