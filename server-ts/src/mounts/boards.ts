import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { ApiError, type FieldError } from '../http/errors.ts';
import { decodeCursor, encodeCursor, TIME_CURSOR_KEYS } from '../http/cursor.ts';
import { idempotent } from '../http/idempotent.ts';
import type { IdempotencyStore } from '../http/idempotency.ts';
import { boundedLength } from '../http/validation.ts';
import { ColumnInUse, type Board, type BoardColumn, type BoardRepository } from '../core/boards.ts';
import { Conflict, Forbidden, NotFound } from '../identity/errors.ts';
import type { Mount } from '../http/registry.ts';

/**
 * `/api/v1/boards`.
 *
 * This mount answers its own error shapes rather than the identity mount's:
 * a bad page query is 400 INVALID_REQUEST here and 422 VALIDATION_FAILED
 * there. The two grew separately and the frontend was written against both, so
 * the difference ports across as-is.
 */

const CURSOR_SCOPE = 'boards.list';
const MAX_BODY_BYTES = 64 * 1024;

/** Statuses a column may name. Not free text: each maps to an issue status. */
const VALID_STATUS = new Set([
   'backlog',
   'todo',
   'inProgress',
   'inReview',
   'done',
   'blocked',
   'cancelled',
]);

const DEFAULT_COLUMNS: BoardColumn[] = [
   { id: 'backlog', name: 'Backlog' },
   { id: 'todo', name: 'Todo' },
   { id: 'inProgress', name: 'In progress' },
   { id: 'inReview', name: 'In review' },
   { id: 'done', name: 'Done' },
];

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,10}[a-z0-9])$/;

export interface BoardOptions {
   sessions: SessionService;
   boards: BoardRepository;
   idempotency: IdempotencyStore;
   /**
    * Routes that hang under a board and belong to it — today, its runs.
    *
    * Attached here rather than mounted separately because the registry refuses
    * overlapping prefixes, and `/api/v1/boards/:id/runs` sits inside this one.
    */
   nested?: Hono<{ Variables: AuthVariables }> | undefined;
}

export function boardMounts(options: BoardOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   if (options.nested) route.route('/', options.nested);

   const { boards } = options;

   route.get('/', async (context) => {
      const { first, after } = parsePage(new URL(context.req.url));
      const cursor = after === '' ? null : decodeBoardCursor(after);

      const rows = await boards.list(context.get('user').id, cursor, first + 1);
      const hasNextPage = rows.length > first;
      const nodes = hasNextPage ? rows.slice(0, first) : rows;
      const last = nodes.at(-1);
      return json({
         nodes: nodes.map(serializeBoard),
         pageInfo: {
            hasNextPage,
            endCursor: last ? encodeCursor(CURSOR_SCOPE, { createdAt: last.createdAt, id: last.id }) : null,
         },
      });
   });

   route.post('/', idempotent(options.idempotency), async (context) => {
      const body = await readBody(context.req.raw);
      const input = parseCreate(body);

      const user = context.get('user');
      // A board is created in the workspace the caller is currently in, so
      // having no current workspace is indistinguishable from the board's
      // workspace not existing.
      if (!user.currentWorkspaceId) throw boardNotFound();
      await boards
         .authorizeWorkspace(user.id, user.currentWorkspaceId, 'product.write')
         .catch(rethrowBoardError);

      const created = await boards
         .create({
            createdBy: user.id,
            workspaceId: user.currentWorkspaceId,
            name: input.name,
            slug: input.slug,
            description: input.description,
            columns: input.columns,
         })
         .catch(rethrowBoardError);

      const response = json(serializeBoard(created), 201);
      response.headers.set('Location', `/api/v1/boards/${created.id}`);
      return response;
   });

   route.get('/:boardId', async (context) => {
      const boardId = boardIdOf(context.req.param('boardId'));
      const scope = await boards
         .authorize(context.get('user').id, boardId, 'product.read')
         .catch(rethrowBoardError);
      const board = await boards.get(boardId, scope.workspaceId).catch(rethrowBoardError);
      return json(serializeBoard(board));
   });

   route.patch('/:boardId', async (context) => {
      const boardId = boardIdOf(context.req.param('boardId'));
      const scope = await boards
         .authorize(context.get('user').id, boardId, 'product.write')
         .catch(rethrowBoardError);
      const patch = parsePatch(await readBody(context.req.raw));

      const board = await boards.update(boardId, scope.workspaceId, patch).catch(rethrowBoardError);
      return json(serializeBoard(board));
   });

   return [{ prefix: '/api/v1/boards', handler: route }];
}

interface CreateInput {
   name: string;
   slug: string;
   description: string | null;
   columns: BoardColumn[];
}

function parseCreate(body: Record<string, unknown>): CreateInput {
   const fields: FieldError[] = [];

   const name = requiredString(body, 'name', 1, 100, 'Name', fields);
   if (!('slug' in body) || body.slug === null) {
      fields.push(field('/slug', 'invalid_type', 'Field is required.'));
   } else {
      validateSlug(body.slug, fields);
   }

   let description: string | null = null;
   if ('description' in body && body.description !== null) {
      if (typeof body.description !== 'string' || !boundedLength(body.description, 0, 5000)) {
         fields.push(
            field('/description', 'too_big', 'Description must contain at most 5000 characters.')
         );
      } else {
         description = body.description;
      }
   }

   let columns = DEFAULT_COLUMNS;
   if ('columns' in body) {
      if (body.columns === null) {
         fields.push(field('/columns', 'invalid_type', 'Columns cannot be null.'));
      } else {
         columns = (body.columns ?? []) as BoardColumn[];
         validateColumns(columns, fields);
      }
   }

   assertValid(fields);
   return {
      name,
      slug: body.slug as string,
      description,
      columns,
   };
}

function parsePatch(body: Record<string, unknown>): {
   name?: string;
   slug?: string;
   descriptionSet: boolean;
   description?: string | null;
   columns?: BoardColumn[];
} {
   const fields: FieldError[] = [];
   const patch: {
      name?: string;
      slug?: string;
      descriptionSet: boolean;
      description?: string | null;
      columns?: BoardColumn[];
   } = { descriptionSet: false };
   let provided = 0;

   if ('name' in body) {
      provided += 1;
      if (body.name === null) {
         fields.push(field('/name', 'invalid_type', 'Name cannot be null.'));
      } else {
         validateString(body.name, '/name', 1, 100, 'Name', fields);
         patch.name = body.name as string;
      }
   }
   if ('slug' in body) {
      provided += 1;
      if (body.slug === null) {
         fields.push(field('/slug', 'invalid_type', 'Slug cannot be null.'));
      } else {
         validateSlug(body.slug, fields);
         patch.slug = body.slug as string;
      }
   }
   if ('description' in body) {
      provided += 1;
      patch.descriptionSet = true;
      if (body.description !== null) {
         if (typeof body.description !== 'string' || !boundedLength(body.description, 0, 5000)) {
            fields.push(
               field('/description', 'too_big', 'Description must contain at most 5000 characters.')
            );
         }
         patch.description = body.description as string;
      }
   }
   if ('columns' in body) {
      provided += 1;
      if (body.columns === null) {
         fields.push(field('/columns', 'invalid_type', 'Columns cannot be null.'));
      } else {
         const columns = (body.columns ?? []) as BoardColumn[];
         validateColumns(columns, fields);
         patch.columns = columns;
      }
   }
   if (provided === 0) {
      fields.push(field('/', 'too_small', 'At least one field must be provided.'));
   }

   assertValid(fields);
   return patch;
}

function validateColumns(columns: unknown, fields: FieldError[]): void {
   if (!Array.isArray(columns) || columns.length === 0) {
      fields.push(field('/columns', 'too_small', 'Columns must contain at least one item.'));
      return;
   }
   const seen = new Set<string>();
   columns.forEach((column: unknown, index) => {
      const base = `/columns/${index}`;
      const entry = (column ?? {}) as Partial<BoardColumn>;
      if (typeof entry.id !== 'string' || !VALID_STATUS.has(entry.id)) {
         fields.push(field(`${base}/id`, 'invalid_enum_value', 'Column id is not a supported issue status.'));
      } else if (seen.has(entry.id)) {
         fields.push(field(`${base}/id`, 'duplicate', 'Column ids must be unique.'));
      }
      if (typeof entry.id === 'string') seen.add(entry.id);
      validateString(entry.name, `${base}/name`, 1, 50, 'Column name', fields);
   });
}

function validateSlug(slug: unknown, fields: FieldError[]): void {
   if (typeof slug !== 'string' || !SLUG.test(slug)) {
      fields.push(
         field('/slug', 'invalid_format', 'Slug must be 2-12 lowercase letters, digits, or hyphens.')
      );
   }
}

function requiredString(
   body: Record<string, unknown>,
   name: string,
   minimum: number,
   maximum: number,
   label: string,
   fields: FieldError[]
): string {
   if (!(name in body) || body[name] === null) {
      fields.push(field(`/${name}`, 'invalid_type', 'Field is required.'));
      return '';
   }
   validateString(body[name], `/${name}`, minimum, maximum, label, fields);
   return typeof body[name] === 'string' ? (body[name] as string) : '';
}

function validateString(
   value: unknown,
   path: string,
   minimum: number,
   maximum: number,
   label: string,
   fields: FieldError[]
): void {
   if (typeof value !== 'string') {
      fields.push(field(path, 'invalid_type', `${label} must be a string.`));
      return;
   }
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

/** This mount reports validation as 422 VALIDATION_FAILED, as identity does. */
function assertValid(fields: FieldError[]): void {
   if (fields.length > 0) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'The request is invalid.', { fields });
   }
}

/** `?first=&after=`, with this mount's 400 INVALID_REQUEST shape. */
function parsePage(url: URL): { first: number; after: string } {
   const seen = new Set<string>();
   for (const name of url.searchParams.keys()) {
      if ((name !== 'first' && name !== 'after') || seen.has(name)) throw invalidQuery();
      seen.add(name);
   }

   let first = 50;
   const raw = url.searchParams.get('first');
   if (raw !== null && raw !== '') {
      const parsed = /^[+-]?\d+$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
         throw new ApiError(400, 'INVALID_REQUEST', 'The request query is invalid.', {
            fields: [field('/query/first', 'invalid', 'first must be an integer from 1 to 100.')],
         });
      }
      first = parsed;
   }

   const after = url.searchParams.get('after');
   // Present but empty is a malformed cursor, not an absent one.
   if (after !== null && after === '') throw invalidCursor();
   return { first, after: after ?? '' };
}

function decodeBoardCursor(after: string) {
   try {
      return decodeCursor<{ createdAt: string; id: string }>(after, CURSOR_SCOPE, TIME_CURSOR_KEYS);
   } catch {
      throw invalidCursor();
   }
}

function invalidQuery(): ApiError {
   return new ApiError(400, 'INVALID_REQUEST', 'The request query is invalid.');
}

function invalidCursor(): ApiError {
   return new ApiError(400, 'INVALID_CURSOR', 'The pagination cursor is invalid.');
}

function boardNotFound(): ApiError {
   return new ApiError(404, 'NOT_FOUND', 'Board not found.');
}

function forbidden(): ApiError {
   return new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
}

function boardIdOf(raw: string | undefined): string {
   const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
   if (!raw || !UUID.test(raw)) throw boardNotFound();
   return raw.toLowerCase();
}

/** Domain failures answered in this mount's words. */
function rethrowBoardError(error: unknown): never {
   if (error instanceof NotFound) throw boardNotFound();
   if (error instanceof Forbidden) throw forbidden();
   if (error instanceof Conflict) {
      throw new ApiError(409, 'CONFLICT', 'A board with this slug already exists.');
   }
   if (error instanceof ColumnInUse) {
      throw new ApiError(
         409,
         'CONFLICT',
         'A status column cannot be removed while non-terminal issues use it.'
      );
   }
   throw error;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
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
   return parsed as Record<string, unknown>;
}

function serializeBoard(board: Board): Record<string, unknown> {
   return {
      id: board.id,
      name: board.name,
      slug: board.slug,
      description: board.description,
      columns: board.columns,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
   };
}
