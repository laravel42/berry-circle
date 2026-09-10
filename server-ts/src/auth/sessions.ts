import type { Sql } from '../db/pool.ts';
import { userFromRow, type BearerResolver } from './credentials.ts';
import { parseBearer } from './tokens.ts';

/**
 * Who is calling.
 *
 * Two credentials, never mixed. A request with an Authorization header is
 * decided by that header alone — a personal access token, or any token a
 * registered resolver claims — and a bad one is not retried against the
 * cookie, so a caller cannot stack credentials and have the server pick. A
 * request without one is decided by the Better Auth session cookie, which is
 * how the browser (and its event stream) signs in.
 *
 * Sessions themselves — issue, refresh, expiry, sign-out — belong to Better
 * Auth (src/auth/better-auth.ts). This only asks it who a cookie belongs to
 * and reads that user's row.
 */

export type Role = 'admin' | 'member' | 'viewer';

/** A user as every authenticated surface sees them. */
export interface User {
   id: string;
   email: string;
   name: string;
   avatarUrl: string | null;
   role: Role;
   currentWorkspaceId: string | null;
   createdAt: string;
   updatedAt: string;
}

export class SessionUnauthenticated extends Error {
   constructor() {
      super('unauthenticated');
      this.name = 'SessionUnauthenticated';
   }
}

/** A cookie-authenticated write sent from an origin Berry does not serve. */
export class CrossOriginRefused extends Error {
   constructor() {
      super('cross-origin request refused');
      this.name = 'CrossOriginRefused';
   }
}

/** What SessionService needs from Better Auth; `auth.api` satisfies it. */
export interface SessionLookup {
   getSession(input: { headers: Headers }): Promise<{ user: { id: string } } | null>;
}

export interface SessionServiceOptions {
   sql: Sql;
   auth: SessionLookup | null;
   bearer?: BearerResolver[];
   trustedOrigins?: string[];
}

/**
 * Methods a browser sends cross-site without a preflight being able to stop
 * it. A cookie rides along on those, so their Origin is checked; reads are
 * harmless to replay and are not.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export class SessionService {
   private readonly sql: Sql;
   private readonly auth: SessionLookup | null;
   private readonly bearer: BearerResolver[];
   private readonly trustedOrigins: Set<string>;

   constructor(options: SessionServiceOptions) {
      this.sql = options.sql;
      this.auth = options.auth;
      this.bearer = options.bearer ?? [];
      this.trustedOrigins = new Set(options.trustedOrigins ?? []);
   }

   async resolveRequest(request: Request): Promise<User> {
      const authorization = request.headers.get('authorization');
      if (authorization !== null) return this.resolveBearer(authorization);
      return this.resolveCookie(request);
   }

   /** One users row by id; a user deleted since the credential was issued is not a caller. */
   async loadUser(userId: string): Promise<User> {
      const [row] = await this.sql`
         SELECT id, email, name, avatar_url, role::text AS role, last_workspace_id,
                created_at, updated_at
           FROM users
          WHERE id = ${userId}
          LIMIT 1`;
      if (!row) throw new SessionUnauthenticated();
      return userFromRow(row);
   }

   private async resolveBearer(header: string): Promise<User> {
      let token: string;
      try {
         token = parseBearer(header);
      } catch {
         throw new SessionUnauthenticated();
      }
      const resolver = this.bearer.find((candidate) => candidate.matches(token));
      if (!resolver) throw new SessionUnauthenticated();
      return resolver.resolve(token);
   }

   private async resolveCookie(request: Request): Promise<User> {
      if (!this.auth) throw new SessionUnauthenticated();
      if (!SAFE_METHODS.has(request.method.toUpperCase())) {
         // SameSite=Lax already keeps the cookie off most cross-site writes;
         // this closes the rest (a sibling subdomain is "same site"). A
         // request with no Origin is not a browser acting for someone else.
         const origin = request.headers.get('origin');
         if (origin !== null && !this.trustedOrigins.has(origin)) throw new CrossOriginRefused();
      }
      const found = await this.auth.getSession({ headers: request.headers });
      if (!found) throw new SessionUnauthenticated();
      return this.loadUser(found.user.id);
   }
}

/**
 * The user shape on the wire.
 *
 * Built key by key in Go's field order, and deliberately without
 * `currentWorkspaceId` — adding a field to a response is as much a contract
 * change as removing one.
 */
export function serializeUser(user: User): Record<string, unknown> {
   return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
   };
}
