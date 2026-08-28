import { randomUUID } from 'node:crypto';
import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';
import { Conflict, Forbidden, NotFound } from '../identity/errors.ts';
import { allows, type Permission } from '../identity/roles.ts';
import type { TimeCursor } from '../http/cursor.ts';

/**
 * Boards.
 *
 * A board belongs to a workspace, and every read here joins through
 * `workspace_memberships` — so a board in a workspace the caller does not
 * belong to is invisible rather than forbidden, and cannot be confirmed to
 * exist by probing.
 */

const BOARD_COLUMNS = `boards.id, boards.name, boards.slug, boards.description,
                       boards.columns, boards.created_at, boards.updated_at`;

/** A status column. `id` is an issue status, not free text. */
export type BoardColumn = {
   id: string;
   name: string;
};

export interface Board {
   id: string;
   name: string;
   slug: string;
   description: string | null;
   columns: BoardColumn[];
   createdAt: string;
   updatedAt: string;
}

export interface BoardPatch {
   name?: string;
   slug?: string;
   descriptionSet: boolean;
   description?: string | null;
   columns?: BoardColumn[];
}

/** A column cannot be removed while issues still sit in it. */
export class ColumnInUse extends Error {
   constructor() {
      super('column in use');
      this.name = 'ColumnInUse';
   }
}

export interface Scope {
   workspaceId: string;
   role: string;
}

export class BoardRepository {
   private readonly sql: Sql;
   private readonly clock: () => Date;
   private readonly newId: () => string;

   constructor(sql: Sql, clock: () => Date = () => new Date(), newId = randomUUID) {
      this.sql = sql;
      this.clock = clock;
      this.newId = newId;
   }

   private now(): string {
      return this.clock().toISOString();
   }

   /**
    * Resolves the workspace and role behind a board, or reports it missing.
    *
    * A board the caller cannot see and a board that does not exist return the
    * same error on purpose: distinguishing them would confirm the existence of
    * boards in other people's workspaces.
    */
   async authorize(userId: string, boardId: string, permission: Permission): Promise<Scope> {
      const [row] = await this.sql`
         SELECT board.workspace_id, membership.role::text AS role
           FROM boards AS board
           JOIN workspaces AS workspace
             ON workspace.id = board.workspace_id AND workspace.deleted_at IS NULL
           JOIN workspace_memberships AS membership
             ON membership.workspace_id = workspace.id AND membership.user_id = ${userId}
          WHERE board.id = ${boardId}`;
      if (!row) throw new NotFound();
      const scope = { workspaceId: row.workspace_id as string, role: row.role as string };
      if (!allows(scope.role, permission)) throw new Forbidden();
      return scope;
   }

   /**
    * The caller's role in a workspace, for the one operation with no board yet.
    *
    * Creating a board cannot authorize against a board, so membership is
    * resolved from the workspace directly — same shape, same silence about
    * workspaces the caller is not in.
    */
   async authorizeWorkspace(
      userId: string,
      workspaceId: string,
      permission: Permission
   ): Promise<Scope> {
      const [row] = await this.sql`
         SELECT membership.role::text AS role
           FROM workspace_memberships AS membership
           JOIN workspaces AS workspace
             ON workspace.id = membership.workspace_id AND workspace.deleted_at IS NULL
          WHERE membership.workspace_id = ${workspaceId} AND membership.user_id = ${userId}`;
      if (!row) throw new NotFound();
      const scope = { workspaceId, role: row.role as string };
      if (!allows(scope.role, permission)) throw new Forbidden();
      return scope;
   }

   async list(userId: string, after: TimeCursor | null, limit: number): Promise<Board[]> {
      const rows = await this.sql`
         SELECT ${this.sql.unsafe(BOARD_COLUMNS)}
           FROM boards
           JOIN workspaces
             ON workspaces.id = boards.workspace_id AND workspaces.deleted_at IS NULL
           JOIN workspace_memberships
             ON workspace_memberships.workspace_id = boards.workspace_id
            AND workspace_memberships.user_id = ${userId}
          WHERE (NOT ${after !== null}::boolean OR
                (boards.created_at, boards.id) < (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY boards.created_at DESC, boards.id DESC
          LIMIT ${limit}`;
      return rows.map(toBoard);
   }

   async get(boardId: string, workspaceId: string): Promise<Board> {
      const [row] = await this.sql`
         SELECT ${this.sql.unsafe(BOARD_COLUMNS)}
           FROM boards
          WHERE id = ${boardId} AND workspace_id = ${workspaceId}`;
      if (!row) throw new NotFound();
      return toBoard(row);
   }

   async create(params: {
      createdBy: string;
      workspaceId: string;
      name: string;
      slug: string;
      description: string | null;
      columns: BoardColumn[];
   }): Promise<Board> {
      const now = this.now();
      const rows = await this.sql`
         INSERT INTO boards (
            id, workspace_id, name, slug, description, columns,
            created_by, created_at, updated_at
         ) VALUES (
            ${this.newId()}, ${params.workspaceId}, ${params.name}, ${params.slug},
            ${params.description}, ${this.sql.json(params.columns)}::jsonb,
            ${params.createdBy}, ${now}, ${now}
         )
         RETURNING ${this.sql.unsafe(BOARD_COLUMNS)}`.catch(classifyWrite);
      return toBoard(rows[0]!);
   }

   /**
    * Applies a patch, refusing to remove a column that issues are still in.
    *
    * The board row is locked first: without it, two concurrent patches could
    * each check the columns they are removing, each see no issues, and commit
    * a board whose combined effect strands issues in a status the board no
    * longer has.
    *
    * `done` and `cancelled` are exempt because they are terminal — an issue
    * there is finished, and the column list no longer governs it.
    */
   async update(boardId: string, workspaceId: string, patch: BoardPatch): Promise<Board> {
      return this.sql.begin(async (tx) => {
         const [locked] = await tx`
            SELECT columns FROM boards
             WHERE id = ${boardId} AND workspace_id = ${workspaceId}
             FOR UPDATE`;
         if (!locked) throw new NotFound();

         if (patch.columns !== undefined) {
            const retained = new Set(patch.columns.map((column) => column.id));
            const blocking = (locked.columns as BoardColumn[])
               .filter(
                  (column) =>
                     !retained.has(column.id) && column.id !== 'done' && column.id !== 'cancelled'
               )
               .map((column) => apiStatusToDb(column.id));

            if (blocking.length > 0) {
               const [used] = await tx`
                  SELECT EXISTS (
                     SELECT 1 FROM issues
                      WHERE board_id = ${boardId} AND deleted_at IS NULL
                        AND status::text = ANY(${blocking}::text[])
                  ) AS in_use`;
               if (used?.in_use) throw new ColumnInUse();
            }
         }

         const rows = await tx`
            UPDATE boards SET
               name = CASE WHEN ${patch.name !== undefined} THEN ${patch.name ?? null}::text ELSE name END,
               slug = CASE WHEN ${patch.slug !== undefined} THEN ${patch.slug ?? null}::text ELSE slug END,
               description = CASE WHEN ${patch.descriptionSet} THEN ${patch.description ?? null}::text ELSE description END,
               columns = CASE WHEN ${patch.columns !== undefined}
                              THEN ${patch.columns ? tx.json(patch.columns) : null}::jsonb
                              ELSE columns END,
               updated_at = ${this.now()}
             WHERE id = ${boardId} AND workspace_id = ${workspaceId}
             RETURNING ${tx.unsafe(BOARD_COLUMNS)}`.catch(classifyWrite);
         if (rows.length === 0) throw new NotFound();
         return toBoard(rows[0]!);
      });
   }
}

/** The API spells two statuses in camelCase; the enum spells them with underscores. */
export function apiStatusToDb(status: string): string {
   if (status === 'inProgress') return 'in_progress';
   if (status === 'inReview') return 'in_review';
   return status;
}

function classifyWrite(error: unknown): never {
   if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505') {
      throw new Conflict();
   }
   throw error;
}

function toBoard(row: Record<string, unknown>): Board {
   return {
      id: row.id as string,
      name: row.name as string,
      slug: row.slug as string,
      description: (row.description as string | null) ?? null,
      columns: (row.columns ?? []) as BoardColumn[],
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

export type { Queryable };
