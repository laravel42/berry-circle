import type { MiddlewareHandler } from 'hono';
import type { BearerResolver } from '../auth/credentials.ts';
import type { User } from '../auth/sessions.ts';
import { isPersonalToken, parsePersonalToken, Unauthenticated } from '../auth/tokens.ts';
import type { Sql } from '../db/pool.ts';
import { ApiError } from '../http/errors.ts';
import type { PluginPrincipal, PluginRuntimeStore } from '../plugins/runtime-store.ts';
import { isPluginToken, parsePluginToken } from '../plugins/tokens.ts';
import { grants, isApiScope, type ApiScope } from './scopes.ts';

/**
 * Bearer authentication for `/v1`: personal access tokens and plugin tokens
 * only. A browser session is not a credential here — the public API is for
 * programs, and a session cookie leaking into one would carry a person's full
 * rights with no scope at all.
 *
 * Every failure is the same 401, as in `auth/middleware.ts`.
 */

export type ApiPrincipal =
   | { kind: 'user'; user: User; scopes: readonly ApiScope[] | null }
   | { kind: 'plugin'; plugin: PluginPrincipal; scopes: readonly ApiScope[] };

export interface PublicApiVariables {
   principal: ApiPrincipal;
   requestId: string;
}

export interface CredentialDeps {
   /** J's `personalTokenResolver(sql)`: revocation, expiry and last-use are its job. */
   personalTokens: Pick<BearerResolver, 'resolve'>;
   plugins: Pick<PluginRuntimeStore, 'resolveToken'> | null;
   personalScopes: (publicId: string) => Promise<ApiScope[] | null>;
}

export function personalTokenScopes(sql: Sql): (publicId: string) => Promise<ApiScope[] | null> {
   return async (publicId) => {
      const [row] = await sql`SELECT scopes FROM personal_api_tokens WHERE public_id = ${publicId}`;
      const scopes = row?.scopes as string[] | null | undefined;
      return scopes === null || scopes === undefined ? null : scopes.filter(isApiScope);
   };
}

export async function resolvePrincipal(deps: CredentialDeps, header: string): Promise<ApiPrincipal> {
   // Exactly "Bearer " and one token: no second space anywhere.
   if (!header.startsWith('Bearer ') || header.indexOf(' ', 'Bearer '.length) !== -1) {
      throw new Unauthenticated();
   }
   const token = header.slice('Bearer '.length);
   try {
      if (isPluginToken(token)) {
         parsePluginToken(token);
         if (!deps.plugins) throw new Unauthenticated();
         const plugin = await deps.plugins.resolveToken(token);
         return { kind: 'plugin', plugin, scopes: plugin.scopes };
      }
      if (isPersonalToken(token)) {
         const { publicId } = parsePersonalToken(token);
         const user = await deps.personalTokens.resolve(token);
         return { kind: 'user', user, scopes: await deps.personalScopes(publicId) };
      }
   } catch {
      throw new Unauthenticated();
   }
   throw new Unauthenticated();
}

export function requireApiCredential(
   deps: CredentialDeps
): MiddlewareHandler<{ Variables: PublicApiVariables }> {
   return async (context, next) => {
      const headers = context.req.raw.headers;
      let count = 0;
      for (const [name] of headers) if (name.toLowerCase() === 'authorization') count += 1;
      const supplied = headers.get('authorization');
      if (supplied === null || count !== 1) throw ApiError.unauthorized();
      let principal: ApiPrincipal;
      try {
         principal = await resolvePrincipal(deps, supplied);
      } catch {
         throw ApiError.unauthorized();
      }
      context.set('principal', principal);
      await next();
   };
}

export function requireScope(principal: ApiPrincipal, scope: ApiScope): void {
   if (!grants(principal.scopes, scope)) {
      throw new ApiError(403, 'INSUFFICIENT_SCOPE', `This token does not hold the ${scope} scope.`, {
         required: scope,
      });
   }
}

export function requirePlugin(principal: ApiPrincipal): PluginPrincipal {
   if (principal.kind !== 'plugin') {
      throw new ApiError(403, 'PLUGIN_TOKEN_REQUIRED', 'Storage is available to plugin tokens only.');
   }
   return principal.plugin;
}

/** Who a write is recorded as: the person, or the member who installed the plugin. */
export function actorId(principal: ApiPrincipal): string {
   return principal.kind === 'user' ? principal.user.id : principal.plugin.installedBy;
}
