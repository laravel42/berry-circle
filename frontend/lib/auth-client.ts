'use client';

import { createAuthClient } from 'better-auth/react';

import { API_BASE_URL } from './config';

type AuthClient = ReturnType<typeof createAuthClient>;

let client: AuthClient | null = null;

/**
 * The Better Auth client, for starting GitHub sign-in and signing out.
 *
 * Created on first use in the browser rather than at import, so a page that
 * imports it can still be prerendered: there is no origin to point at on the
 * server. Same-origin by default (Next rewrites /api/* to the server); the
 * explicit API URL only in cross-origin development.
 */
export function authClient(): AuthClient {
   if (typeof window === 'undefined') {
      throw new Error('The auth client is browser-only');
   }
   client ??= createAuthClient({
      baseURL: API_BASE_URL || window.location.origin,
      basePath: '/api/auth',
   });
   return client;
}
