/**
 * What a public API credential may do.
 *
 * A personal token with no scopes (NULL) predates scopes and keeps full
 * access; a plugin token always carries an explicit list, intersected with
 * what the admin granted the installation.
 */

export const API_SCOPES = [
   'issues:read',
   'issues:write',
   'comments:read',
   'comments:write',
   'storage:read',
   'storage:write',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: unknown): value is ApiScope {
   return typeof value === 'string' && (API_SCOPES as readonly string[]).includes(value);
}

/** A sorted, de-duplicated scope list, or null when anything in it is unknown. */
export function parseScopes(value: unknown): ApiScope[] | null {
   if (!Array.isArray(value)) return null;
   const scopes: ApiScope[] = [];
   for (const entry of value) {
      if (!isApiScope(entry)) return null;
      if (!scopes.includes(entry)) scopes.push(entry);
   }
   return scopes.sort();
}

export function grants(held: readonly ApiScope[] | null, needed: ApiScope): boolean {
   return held === null || held.includes(needed);
}
