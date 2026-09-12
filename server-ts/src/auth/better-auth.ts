import { randomUUID } from 'node:crypto';

import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { testUtils, type TestHelpers } from 'better-auth/plugins';
import type { Pool } from 'pg';

/**
 * Sign-in: Better Auth with GitHub and nothing else.
 *
 * Better Auth's user model *is* `users`, so an account keeps the id every
 * workspace, issue and token already points at. Its own state — sessions,
 * linked accounts, OAuth state — lives in the auth_* tables from migration 150.
 *
 * It talks to Postgres through a small `pg` pool rather than the server's
 * postgres.js client because its Kysely adapter speaks `pg`; the pool is sized
 * for sign-in and session lookups, not for product queries.
 */

export const AUTH_BASE_PATH = '/api/auth';
export const SESSION_COOKIE_PREFIX = 'berry';

export interface BerryAuthOptions {
   pool: Pool;
   secret: string;
   baseUrl: string;
   trustedOrigins: string[];
   github: { clientId: string; clientSecret: string } | null;
   sessionTtlMs: number;
   /** Enables Better Auth's testUtils plugin: dev-login and tests only. */
   testUtils?: boolean;
}

/** What GitHub tells us about whoever just signed in. */
export interface GitHubProfile {
   login?: string | null;
   name?: string | null;
   email?: string | null;
}

/**
 * The user behind a GitHub profile.
 *
 * GitHub withholds the email when the account keeps it private, and a GitHub
 * App gets one only with the Email addresses permission. Refusing the sign-in
 * over that would make a correct, deliberate privacy setting look like a
 * broken login, so the account falls back to the address GitHub itself hands
 * out for the purpose: <login>@users.noreply.github.com. A real address is
 * preferred whenever one is offered, because that is what links a GitHub
 * account to a user Berry already knows.
 */
export function githubProfileToUser(profile: GitHubProfile): { email: string; name: string } {
   const email = (profile.email ?? '').trim();
   const login = (profile.login ?? '').trim();
   const name = (profile.name ?? '').trim();
   return {
      email: email || (login ? `${login}@users.noreply.github.com` : ''),
      name: name || login,
   };
}

export function createBerryAuth(options: BerryAuthOptions) {
   return betterAuth({
      appName: 'Berry',
      baseURL: options.baseUrl,
      basePath: AUTH_BASE_PATH,
      secret: options.secret,
      trustedOrigins: options.trustedOrigins,
      database: options.pool,
      // GitHub is the only way in. Stated rather than left to the default so
      // a future default cannot quietly open a second door.
      emailAndPassword: { enabled: false },
      socialProviders: options.github
         ? {
              github: {
                 clientId: options.github.clientId,
                 clientSecret: options.github.clientSecret,
                 mapProfileToUser: githubProfileToUser,
              },
           }
         : {},
      user: {
         modelName: 'users',
         fields: {
            image: 'avatar_url',
            emailVerified: 'email_verified',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
         },
         changeEmail: { enabled: false },
         deleteUser: { enabled: false },
      },
      databaseHooks: {
         user: {
            create: {
               // Better Auth has no "verified email only" switch for social
               // sign-up: linking an *existing* user already needs GitHub's
               // verified flag (it is not a trusted provider), but a *new* user
               // would be created from an unverified address. Refused here, so
               // an unverified GitHub email never becomes a Berry account.
               // Returning false aborts the create; the callback redirects to
               // errorCallbackURL with an error code.
               before: async (user) => (user.emailVerified === true ? { data: user } : false),
            },
         },
      },
      session: {
         modelName: 'auth_sessions',
         fields: {
            userId: 'user_id',
            expiresAt: 'expires_at',
            ipAddress: 'ip_address',
            userAgent: 'user_agent',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
         },
         expiresIn: Math.floor(options.sessionTtlMs / 1000),
      },
      account: {
         modelName: 'auth_accounts',
         fields: {
            userId: 'user_id',
            accountId: 'account_id',
            providerId: 'provider_id',
            accessToken: 'access_token',
            refreshToken: 'refresh_token',
            idToken: 'id_token',
            accessTokenExpiresAt: 'access_token_expires_at',
            refreshTokenExpiresAt: 'refresh_token_expires_at',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
         },
         // Sign-in never uses the GitHub token again, but if it is kept it is
         // kept sealed.
         encryptOAuthTokens: true,
         accountLinking: {
            enabled: true,
            // Not trusted by name: linking happens only on a GitHub-verified
            // address (userInfo.emailVerified from GitHub's /user/emails).
            trustedProviders: [],
            allowDifferentEmails: false,
            // Existing Berry users were never email-verified: they signed in
            // with a password or a dev login. The proof of ownership is
            // GitHub's verified address, and with password sign-in gone there
            // is no other way to create an unverified local user.
            requireLocalEmailVerified: false,
         },
      },
      verification: {
         modelName: 'auth_verifications',
         fields: {
            expiresAt: 'expires_at',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
         },
      },
      advanced: {
         cookiePrefix: SESSION_COOKIE_PREFIX,
         // users.id and every auth_* id are uuid columns. A generator rather
         // than 'uuid': in this Better Auth version 'uuid' means "the database
         // supplies it", and only users.id has a default; the auth_* tables
         // take the id they are given.
         database: { generateId: () => randomUUID() },
      },
      // Cast: the plugin's own declared type does not satisfy BetterAuthPlugin
      // under exactOptionalPropertyTypes (its init() may return undefined
      // options). It is the library's plugin, used as the library documents.
      plugins: options.testUtils ? [testUtils() as unknown as BetterAuthPlugin] : [],
   });
}

export type BerryAuth = ReturnType<typeof createBerryAuth>;

/**
 * A signed session cookie for a user, as Set-Cookie header values.
 *
 * Only for the development dev-login route and tests: it needs the testUtils
 * plugin, which `createBerryAuth` installs only when asked to.
 */
export async function devSessionCookies(auth: BerryAuth, userId: string): Promise<string[]> {
   const context = (await auth.$context) as unknown as { test?: TestHelpers };
   if (!context.test) {
      throw new Error('devSessionCookies needs createBerryAuth({ testUtils: true })');
   }
   const { cookies } = await context.test.login({ userId });
   return cookies.map((cookie) => {
      const parts = [`${cookie.name}=${cookie.value}`, `Path=${cookie.path ?? '/'}`, 'HttpOnly'];
      parts.push(`SameSite=${cookie.sameSite ?? 'Lax'}`);
      if (cookie.secure) parts.push('Secure');
      if (typeof cookie.expires === 'number') {
         parts.push(`Expires=${new Date(cookie.expires * 1000).toUTCString()}`);
      }
      return parts.join('; ');
   });
}
