import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { assertValid, fieldError } from '../http/body.ts';
import { decodeTimeCursor, encodeCursor, parsePageQuery } from '../http/cursor.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import type { BoardRepository } from '../core/boards.ts';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { pathId } from './shared.ts';

/**
 * Three small reads the shell needs before it can draw: `/search`, `/views`
 * and `/catalogs`.
 *
 * One file rather than three, because each is a single query over a single
 * table and splitting them would be three modules of boilerplate around three
 * SELECTs. They share the same shape — workspace-scoped, cursor-paged, read
 * only — and nothing here decides anything.
 *
 * They are registered as three mounts, because the registry addresses by
 * prefix and `/search` and `/views` are not the same resource.
 */

const MAX_QUERY = 200;

export interface WorkspaceReadOptions {
   sessions: SessionService;
   sql: Sql;
   boards: BoardRepository;
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
      const workspaceId = await requireWorkspace(context, options, url);
      const page = parsePageQuery(url, ['workspaceId', 'query', 'types']);

      const query = (url.searchParams.get('query') ?? '').trim();
      if (query === '') {
         assertValid([fieldError('/query', 'required', 'query is required.')]);
      }
      if (query.length > MAX_QUERY) {
         assertValid([fieldError('/query', 'too_long', `query is at most ${MAX_QUERY} characters.`)]);
      }
      const types = new Set((url.searchParams.get('types') ?? 'issue').split(','));
      for (const type of types) {
         if (type !== 'issue' && type !== 'board') {
            assertValid([fieldError('/types', 'invalid_value', 'types are issue and board.')]);
         }
      }

      // Escaped for LIKE, not for SQL: the value is parameterised, but `%` and
      // `_` inside it would otherwise be wildcards the person did not type.
      const like = `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
      const nodes: Array<Record<string, unknown>> = [];

      if (types.has('issue')) {
         const rows = await options.sql`
            SELECT issue.id, issue.title, issue.board_id, board.name AS board_name,
                   berry_issue_identifier(board.workspace_id, issue.number) AS identifier
              FROM issues AS issue
              JOIN boards AS board ON board.id = issue.board_id
             WHERE board.workspace_id = ${workspaceId}
               AND issue.deleted_at IS NULL
               AND (issue.title ILIKE ${like}
                    OR berry_issue_identifier(board.workspace_id, issue.number) ILIKE ${like})
             ORDER BY issue.updated_at DESC, issue.id DESC
             LIMIT ${page.first}`;
         for (const row of rows) {
            nodes.push({
               type: 'issue',
               id: row.id as string,
               title: row.title as string,
               subtitle: (row.board_name as string | null) ?? null,
               identifier: (row.identifier as string | null) ?? null,
               boardId: row.board_id as string,
            });
         }
      }

      if (types.has('board')) {
         const rows = await options.sql`
            SELECT id, name, description
              FROM boards
             WHERE workspace_id = ${workspaceId} AND name ILIKE ${like}
             ORDER BY updated_at DESC, id DESC
             LIMIT ${page.first}`;
         for (const row of rows) {
            nodes.push({
               type: 'board',
               id: row.id as string,
               title: row.name as string,
               subtitle: (row.description as string | null) ?? null,
               identifier: null,
               boardId: row.id as string,
            });
         }
      }

      // No cursor: a palette shows what it can and the person types more.
      return json({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
   });

   return route;
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

   route.get('/', async (context) => {
      const url = new URL(context.req.url);
      const workspaceId = await requireWorkspace(context, options, url);
      const page = parsePageQuery(url, ['workspaceId']);
      const scope = `views.${workspaceId}.${context.get('user').id}`;
      const after = page.after === '' ? null : decodeTimeCursor(page.after, scope);

      const rows = await options.sql`
         SELECT id, workspace_id, owner_id, name, visibility, definition_version,
                query, display, revision, created_at, updated_at
           FROM saved_issue_views
          WHERE workspace_id = ${workspaceId}
            AND (visibility <> 'private' OR owner_id = ${context.get('user').id})
            AND (${after === null} OR (created_at, id) <
                 (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT ${page.first + 1}`;

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
function catalogsRoute(options: WorkspaceReadOptions): Hono<{ Variables: AuthVariables }> {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   route.get('/:workspaceId/issue-labels', async (context) => {
      const workspaceId = pathId(context.req.param('workspaceId'), 'Workspace');
      await authorizeWorkspace(context, options, workspaceId);

      const url = new URL(context.req.url);
      const page = parsePageQuery(url);
      const scope = `catalogs.labels.${workspaceId}`;
      const after = page.after === '' ? null : decodeTimeCursor(page.after, scope);

      const rows = await options.sql`
         SELECT id, workspace_id, name, description, color, created_at, updated_at, archived_at
           FROM issue_labels
          WHERE workspace_id = ${workspaceId}
            AND (${after === null} OR (created_at, id) <
                 (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT ${page.first + 1}`;

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
         }))
      );
   });

   return route;
}

// ------------------------------------------------------------------ helpers

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

async function requireWorkspace(
   context: { get: (key: 'user') => { id: string } },
   options: WorkspaceReadOptions,
   url: URL
): Promise<string> {
   const workspaceId = url.searchParams.get('workspaceId');
   if (!workspaceId) {
      assertValid([fieldError('/workspaceId', 'required', 'workspaceId is required.')]);
   }
   await authorizeWorkspace(context, options, workspaceId!);
   return workspaceId!;
}

async function authorizeWorkspace(
   context: { get: (key: 'user') => { id: string } },
   options: WorkspaceReadOptions,
   workspaceId: string
): Promise<void> {
   await options.boards
      .authorizeWorkspace(context.get('user').id, workspaceId, 'product.read')
      .catch((error: unknown) => {
         if (error instanceof NotFound || error instanceof Forbidden) {
            throw ApiError.notFound('Workspace');
         }
         throw error;
      });
}
