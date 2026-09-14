import type { Queryable, Sql } from '../db/pool.ts';
import { Forbidden, NotFound } from './errors.ts';
import { allows, type Permission } from './roles.ts';

/**
 * Server-derived workspace scope.
 *
 * A `workspaceId` arriving from a path or query string is only ever a *lookup
 * key*. It becomes a trusted scope exclusively through
 * {@link resolveWorkspaceContext}, which confirms the caller's membership
 * against `workspace_memberships` before returning. Isolation therefore rests
 * on a structural fact — a handler cannot obtain a `WorkspaceContext` without a
 * confirmed membership — rather than on each handler remembering to check.
 */
export interface WorkspaceContext {
   /** The confirmed scope. Trusted only because membership was verified. */
   readonly workspaceId: string;
   /** The resolved caller, carried from the session, never from the request. */
   readonly userId: string;
   /** The caller's role in this workspace; an unknown value grants nothing via {@link allows}. */
   readonly role: string;
}

/**
 * Permissions that read-only access satisfies with membership alone.
 *
 * A `required` naming one of these needs only a confirmed membership: any
 * member may read. Any other (write) permission is additionally checked with
 * {@link allows}, so a member whose role lacks it is refused with `Forbidden`.
 */
const READ_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
   'workspace.read',
   'settings.read',
   'members.read',
   'invitations.read',
   'product.read',
]);

/**
 * Resolves the caller's context for a *lookup* `workspaceId`.
 *
 * Membership is confirmed against `workspace_memberships` (joined to a live
 * workspace) before anything is returned. A non-member and an absent workspace
 * are **indistinguishable**: both raise {@link NotFound} (→ 404), so a caller
 * cannot probe which workspaces exist (Requirement 5.5).
 *
 * The `required` permission decides the second gate. A read permission is
 * satisfied by membership alone. A write permission is additionally checked
 * with {@link allows}; a member whose role lacks it raises {@link Forbidden}
 * (→ 403), which is safe to distinguish because membership is already
 * established (Requirement 8.3). The `workspaceId` is never trusted as a scope,
 * and the caller's role is never read from the request, until this returns
 * (Requirements 5.1, 5.2).
 */
export async function resolveWorkspaceContext(
   sql: Queryable,
   userId: string,
   workspaceId: string,
   required: Permission
): Promise<WorkspaceContext> {
   const [row] = await sql`
      SELECT m.role::text AS role
        FROM workspace_memberships AS m
        JOIN workspaces AS w ON w.id = m.workspace_id
       WHERE m.workspace_id = ${workspaceId}
         AND m.user_id = ${userId}
         AND w.deleted_at IS NULL`;
   // Non-member and absent workspace look identical: no membership row either way.
   if (!row) throw new NotFound();

   const role = row.role as string;
   // Reads need only membership; a write permission the role lacks is a genuine 403.
   if (!READ_PERMISSIONS.has(required) && !allows(role, required)) {
      throw new Forbidden();
   }

   return { workspaceId, userId, role };
}

/**
 * The executor and pre-bound scope handed to a {@link ScopedDb.list} builder.
 *
 * The builder writes its own `SELECT`, but it never sees a raw pool and never
 * gets to choose the workspace value. `workspaceId` is `ctx.workspaceId` — the
 * *confirmed* scope, not the lookup key from the request — and `scope` is that
 * value already wrapped as the fragment `workspace_id = <ctx.workspaceId>`,
 * ready to drop into a `WHERE`. A builder that embeds `scope` (directly, or
 * against a joined alias via `sql`) cannot widen past the one workspace the
 * caller was proven to belong to; a builder that omits it is the deliberate
 * bypass the wrapper exists to make visible to review.
 */
export interface ScopedQuery {
   /** The scoped tagged-template executor the builder issues its SELECT on. */
   readonly sql: Queryable;
   /** `ctx.workspaceId`, the confirmed scope — never the request's lookup key. */
   readonly workspaceId: string;
   /** `workspace_id = <ctx.workspaceId>` as an embeddable fragment. */
   readonly scope: PendingScope;
}

/** A `postgres.js` template fragment carrying the workspace predicate. */
type PendingScope = ReturnType<Sql>;

/**
 * A query surface bound to exactly one confirmed workspace.
 *
 * Every method injects `workspace_id = ctx.workspaceId` (directly or through a
 * membership join). There is deliberately no method that returns a row outside
 * `ctx.workspaceId`: a leak requires abandoning this surface for the raw handle,
 * which a review and a lint rule can flag (design §4, mechanism C).
 */
export interface ScopedDb {
   /** The confirmed scope this surface is bound to. */
   readonly ctx: WorkspaceContext;
   /**
    * Runs a caller-provided `SELECT` builder with the workspace predicate
    * supplied by the wrapper, so no cross-workspace row can be returned
    * (Requirements 6.1, 6.4, 7.2).
    */
   list<T>(build: (q: ScopedQuery) => Promise<T[]>): Promise<T[]>;
   /**
    * Resolves a resource's *stored* owning workspace and confirms it is
    * `ctx`'s. A missing row and a row owned by another workspace both raise
    * {@link NotFound} (→ 404), indistinguishably, so an id cannot probe across
    * the tenant boundary (Requirements 5.3, 6.5, 7.4).
    */
   requireResource(table: string, id: string): Promise<void>;
   /**
    * Refuses a role that lacks `required` with {@link Forbidden} (→ 403).
    *
    * Only meaningful once the resource being acted on is known to exist in
    * this workspace: a caller must never learn from a 403 that an id they
    * cannot reach exists.
    */
   authorize(required: Permission): void;
   /**
    * Runs locate + authorize + write. When `resource` is given, the row is
    * first confirmed to live in this workspace — {@link NotFound} (→ 404),
    * whatever the caller's role, if it is absent or foreign — and only then is
    * `allows(ctx.role, required)` checked — {@link Forbidden} (→ 403). `work`
    * runs inside a single `sql.begin` that rolls back on any throw, so a
    * refused or failed write leaves nothing behind (Requirements 7.6, and the
    * RBAC gate of design §5).
    */
   mutate<T>(
      required: Permission,
      work: (tx: Queryable, ctx: WorkspaceContext) => Promise<T>,
      resource?: OwnedResource
   ): Promise<T>;
}

/** A row named by id, owned by this workspace through a `workspace_id` column. */
export interface OwnedResource {
   readonly table: string;
   readonly id: string;
}

/**
 * Table names {@link ScopedDb.requireResource} may look up.
 *
 * A closed allow-list rather than an interpolated identifier: `requireResource`
 * has to name a table in the SQL text (a parameter cannot stand in for an
 * identifier), and validating against this set keeps a caller-influenced string
 * from ever reaching the query. Each table here owns its workspace directly
 * through a `workspace_id` column.
 */
const OWNED_TABLES: ReadonlySet<string> = new Set<string>([
   'boards',
   'projects',
   'goals',
   'saved_issue_views',
   'issue_labels',
   'issue_status_definitions',
   'issue_property_definitions',
   'quick_action_definitions',
   'workspace_join_links',
   'agents',
   'agent_runtimes',
   'runtime_profiles',
   'mcp_servers',
   'skills',
   'squads',
   'autopilots',
   'autopilot_triggers',
   'plugin_installations',
   'workspace_repositories',
]);

/**
 * Binds a {@link ScopedDb} to one confirmed {@link WorkspaceContext}.
 *
 * The `sql` handle is captured privately; the returned surface is the only way
 * a handler is meant to reach the database for this workspace, and every path
 * through it carries `ctx.workspaceId`. Constructing it requires a
 * `WorkspaceContext`, which only {@link resolveWorkspaceContext} can produce —
 * so a scoped query cannot be issued without a membership-confirmed scope.
 */
export function scopedDb(sql: Sql, ctx: WorkspaceContext): ScopedDb {
   // The workspace predicate, bound once to the confirmed scope. Every list
   // builder embeds this; the value is ctx.workspaceId, never the request's.
   const scope: PendingScope = sql`workspace_id = ${ctx.workspaceId}`;

   const surface: ScopedDb = {
      ctx,

      list<T>(build: (q: ScopedQuery) => Promise<T[]>): Promise<T[]> {
         return build({ sql, workspaceId: ctx.workspaceId, scope });
      },

      async requireResource(table: string, id: string): Promise<void> {
         if (!OWNED_TABLES.has(table)) {
            // A table this surface does not know how to scope must never fall
            // through to an unscoped lookup: refuse rather than guess.
            throw new NotFound();
         }
         // Read the row's *stored* workspace and compare to the confirmed scope
         // in one predicate. A non-existent id and an id owned by another
         // workspace both return zero rows, so the two are indistinguishable.
         const [row] = await sql`
            SELECT 1
              FROM ${sql(table)}
             WHERE id = ${id}
               AND workspace_id = ${ctx.workspaceId}
             LIMIT 1`;
         if (!row) throw new NotFound();
      },

      authorize(required: Permission): void {
         if (!allows(ctx.role, required)) throw new Forbidden();
      },

      async mutate<T>(
         required: Permission,
         work: (tx: Queryable, ctx: WorkspaceContext) => Promise<T>,
         resource?: OwnedResource
      ): Promise<T> {
         // Locate before authorizing. A 403 is only safe to give for a row
         // that exists in the caller's own workspace; an absent or foreign id
         // must be the same 404 for every role, or the refusal itself would
         // say the id exists across the tenant boundary.
         if (resource) await surface.requireResource(resource.table, resource.id);
         // Authorize before opening the transaction: a denial should cost
         // nothing. A read permission is not a valid `mutate` gate — every
         // write permission the role lacks is a genuine 403 here, since
         // membership (and the resource, when named) is already established.
         surface.authorize(required);
         // One transaction for the whole write. postgres.js rolls back if the
         // callback throws, so a failure mid-write leaves nothing behind. The
         // transaction executor is passed to `work` so the write cannot escape
         // onto a different connection.
         return (await sql.begin((tx) => work(tx, ctx))) as T;
      },
   };
   return surface;
}
