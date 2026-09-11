import type { Hono } from 'hono';
import { ApiError } from '../http/errors.ts';
import { assertValid, fieldError } from '../http/body.ts';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { toApiError } from '../identity/errors.ts';
import type { Permission } from '../identity/roles.ts';
import type { Membership } from '../identity/workspaces.ts';
import {
   resolveWorkspaceContext,
   scopedDb,
   type ScopedDb,
} from '../identity/workspace-context.ts';

/** Helpers shared by the identity mounts, ported from validation.go. */

/**
 * The request-scoped values a workspace-scoped mount carries.
 *
 * Extends {@link AuthVariables} with the one thing {@link mountWorkspaceScope}
 * adds: a {@link ScopedDb} bound to the caller's confirmed workspace. A handler
 * reads it with `context.get('scoped')`, and — because the only constructor of
 * a `ScopedDb` is a membership-confirmed {@link WorkspaceContext} — a handler
 * that has one has already passed the isolation gate.
 */
export interface ScopedVariables extends AuthVariables {
   scoped: ScopedDb;
}

/**
 * Wires the workspace-scope gate onto a `/:workspaceId/...` mount.
 *
 * This is mechanism **B constructing mechanism C** from the design: two
 * middlewares on the `/:workspaceId/*` prefix. The first is
 * {@link requireSession}, which resolves the caller. The second reads the
 * `:workspaceId` path segment as a *lookup key only*, hands it to
 * {@link resolveWorkspaceContext} (which confirms membership before the id is
 * trusted), and attaches the resulting {@link ScopedDb} as `scoped`. A handler
 * therefore cannot reach a workspace-scoped query surface without a
 * membership-confirmed scope — isolation is a structural fact of the wiring,
 * not something each handler must remember.
 *
 * The gate permission is `product.read`: mounting requires only membership, so
 * a read route under the prefix works with membership alone and a write route
 * additionally gates on its own permission through {@link ScopedDb.mutate}.
 * `resolveWorkspaceContext` failures are translated by {@link toApiError}: a
 * non-member or absent workspace is `NotFound` → 404 (indistinguishable), and
 * a member whose role lacks the required permission is `Forbidden` → 403.
 */
export function mountWorkspaceScope(
   route: Hono<{ Variables: ScopedVariables }>,
   options: { sessions: SessionService; sql: Sql }
): void {
   route.use('/:workspaceId/*', requireSession(options.sessions));
   route.use('/:workspaceId/*', async (context, next) => {
      const workspaceId = pathId(context.req.param('workspaceId'), 'Workspace');
      try {
         const ctx = await resolveWorkspaceContext(
            options.sql,
            context.get('user').id,
            workspaceId,
            'product.read'
         );
         context.set('scoped', scopedDb(options.sql, ctx));
      } catch (error) {
         throw toApiError(error, 'Workspace');
      }
      await next();
   });
}

/**
 * Confirms membership for a *lookup* `workspaceId` and returns a `ScopedDb`.
 *
 * The escape hatch for a mount that takes its `workspaceId` from a query
 * parameter rather than a path segment (so it cannot use the `/:workspaceId/*`
 * prefix of {@link mountWorkspaceScope}). Same gate, same translation: a
 * `product.read` `required` needs only membership; a write `required` a
 * member's role lacks raises `Forbidden` → 403; a non-member or absent
 * workspace is `NotFound` → 404, indistinguishable.
 */
export async function resolveScoped(
   sql: Sql,
   userId: string,
   workspaceId: string,
   required: Permission = 'product.read'
): Promise<ScopedDb> {
   try {
      const ctx = await resolveWorkspaceContext(sql, userId, workspaceId, required);
      return scopedDb(sql, ctx);
   } catch (error) {
      throw toApiError(error, 'Workspace');
   }
}

/**
 * {@link resolveScoped} for a route that acts on one resource named by id.
 *
 * The order is the tenant-isolation contract: membership first (a non-member
 * or absent workspace is 404), then `locate` confirms the resource lives in
 * that workspace (an absent or foreign id is 404, whatever the caller's role),
 * and only then is `required` checked (403). A 403 therefore only ever speaks
 * about a resource the caller could already see.
 */
export async function resolveScopedResource(
   sql: Sql,
   userId: string,
   workspaceId: string,
   required: Permission,
   locate: (db: ScopedDb) => Promise<unknown>
): Promise<ScopedDb> {
   const db = await resolveScoped(sql, userId, workspaceId);
   await locate(db);
   try {
      db.authorize(required);
   } catch (error) {
      throw toApiError(error, 'Workspace');
   }
   return db;
}

/** A `locate` for {@link resolveScopedResource}: the row is this workspace's, or 404 `resource`. */
export function owned(table: string, id: string, resource: string): (db: ScopedDb) => Promise<void> {
   return async (db) => {
      try {
         await db.requireResource(table, id);
      } catch (error) {
         throw toApiError(error, resource);
      }
   };
}

/** Identity failures from a scoped write, in the API's words: NotFound → 404 `resource`, Forbidden → 403. */
export function rethrowScoped(resource: string): (error: unknown) => never {
   return (error: unknown) => {
      throw toApiError(error, resource);
   };
}

/**
 * A malformed id is 404, not 400.
 *
 * Go parses the path segment and answers "not found" when it is not a
 * canonical UUID, which is also the answer for an id that simply is not
 * there — so a caller cannot probe which ids exist by their shape.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export function pathId(raw: string | undefined, resource: string): string {
   if (!raw || !UUID.test(raw) || raw.toLowerCase() === NIL_UUID) {
      throw ApiError.notFound(resource);
   }
   return raw.toLowerCase();
}

export function requireIdempotencyKey(headers: Headers): string {
   // Headers.get joins repeats with ", ", so counting entries is the only way
   // to tell one key from two that happen to concatenate into a valid one.
   const values = [...headers].filter(([name]) => name.toLowerCase() === 'idempotency-key');
   const key = values.length === 1 ? (values[0]?.[1] ?? '') : '';
   if (key.length < 16 || key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) {
      assertValid([
         fieldError(
            '/headers/Idempotency-Key',
            'invalid',
            'Idempotency-Key must be one visible ASCII value from 16 to 128 characters.'
         ),
      ]);
   }
   return key;
}

/** Re-exported so every mount fingerprints a body the same way Go does. */
export { fingerprintJSON } from '../http/idempotency.ts';

export async function requireEmptyBody(request: Request): Promise<void> {
   const body = await request.text();
   if (body.trim() !== '') {
      assertValid([
         fieldError('/', 'unrecognized_body', 'This operation does not accept a request body.'),
      ]);
   }
}

/**
 * The workspace the caller is currently in, or 404.
 *
 * Mounts that list "this workspace's" things (agents, skills, squads) scope to
 * it rather than to one named in the query, the way the agents mount always has.
 */
export function currentWorkspace(workspaceId: string | null): string {
   if (!workspaceId) throw ApiError.notFound('Workspace');
   return workspaceId;
}

export function serializeMember(member: Membership): Record<string, unknown> {
   return {
      userId: member.userId,
      workspaceId: member.workspaceId,
      role: member.role,
      email: member.email,
      name: member.name,
      avatarUrl: member.avatarUrl,
      joinedAt: member.joinedAt,
      updatedAt: member.updatedAt,
   };
}
