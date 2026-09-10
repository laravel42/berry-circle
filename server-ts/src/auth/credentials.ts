import { toRFC3339, type Sql } from '../db/pool.ts';
import type { Role, User } from './sessions.ts';
import { isPersonalToken, parsePersonalToken, secretMatches } from './tokens.ts';

/**
 * Bearer credentials: what an `Authorization: Bearer` header may carry now
 * that browser sessions are cookies.
 *
 * Each kind of token claims a namespace by prefix and resolves itself. The
 * list is ordered and the first resolver that claims a token decides it, so a
 * malformed token in one namespace is never retried as another kind.
 * Personal access tokens are built in; workstream A registers task tokens the
 * same way.
 */
export interface BearerResolver {
   /** A short name for logs, e.g. 'personal-token'. */
   readonly name: string;
   /** Whether this resolver owns the token's namespace. Checked in order; first match wins. */
   matches(token: string): boolean;
   /** Resolve or throw. Any throw is answered with the uniform 401. */
   resolve(token: string): Promise<User>;
}

class TokenRefused extends Error {
   constructor() {
      super('unauthenticated');
      this.name = 'TokenRefused';
   }
}

/**
 * `berry_pat_<publicId>_<secret>`: one indexed lookup on the public half, then
 * a constant-time comparison of the secret's digest. Unchanged from the
 * session service it used to live in.
 */
export function personalTokenResolver(
   sql: Sql,
   now: () => Date = () => new Date()
): BearerResolver {
   return {
      name: 'personal-token',
      matches: isPersonalToken,
      async resolve(token) {
         let parsed: { publicId: string; secret: string };
         try {
            parsed = parsePersonalToken(token);
         } catch {
            throw new TokenRefused();
         }

         const at = now().toISOString();
         const [row] = await sql`
            SELECT t.id, t.secret_hash, t.expires_at, t.revoked_at,
                   u.id AS user_id, u.email, u.name, u.avatar_url, u.role::text AS role,
                   u.last_workspace_id, u.created_at, u.updated_at
              FROM personal_api_tokens AS t
              JOIN users AS u ON u.id = t.user_id
             WHERE t.public_id = ${parsed.publicId}`;
         if (!row) throw new TokenRefused();

         const expiresAt = row.expires_at as string | null;
         if (
            row.revoked_at !== null ||
            (expiresAt !== null && new Date(expiresAt) <= new Date(at))
         ) {
            throw new TokenRefused();
         }
         if (!secretMatches(parsed.secret, row.secret_hash as Buffer)) throw new TokenRefused();

         // GREATEST, so a delayed request cannot move last_used_at backwards.
         const touched = await sql`
            UPDATE personal_api_tokens
               SET last_used_at = GREATEST(COALESCE(last_used_at, ${at}), ${at})
             WHERE id = ${row.id as string} AND revoked_at IS NULL`;
         if (touched.count !== 1) throw new TokenRefused();

         return userFromRow({ ...row, id: row.user_id });
      },
   };
}

/** A users row (with `role::text AS role`) as every authenticated surface sees it. */
export function userFromRow(row: Record<string, unknown>): User {
   return {
      id: row.id as string,
      email: row.email as string,
      name: row.name as string,
      avatarUrl: (row.avatar_url as string | null) ?? null,
      role: row.role as Role,
      currentWorkspaceId: (row.last_workspace_id as string | null) ?? null,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}
