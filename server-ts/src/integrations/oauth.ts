import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql } from '../db/pool.ts';
import type { Sealer } from './sealing.ts';

/**
 * The OAuth handshake, and the one piece of it that has to be remembered.
 *
 * Between sending a person to GitHub and GitHub sending them back, the only
 * thing tying the two halves together is `state`. It has to be unguessable, it
 * has to be usable once, and it has to expire — otherwise a link someone was
 * sent becomes a way to attach *their* GitHub account to *your* workspace.
 *
 * So the state is a random 32-byte value; only its SHA-256 is stored, the way
 * a session token is, and the callback finds the row by hash. A row that was
 * already consumed, or that has expired, is not a row.
 */

/** Long enough for a person to sign in and pick an organisation, not longer. */
const STATE_TTL_MS = 10 * 60 * 1000;

export interface PendingAuthorization {
   /** The opaque value sent to the provider and expected back. */
   state: string;
   redirectUri: string;
   scopes: string[];
}

export interface ResolvedAuthorization {
   /** Null only for first-run App setup, where neither exists yet. */
   workspaceId: string | null;
   userId: string | null;
   provider: string;
   redirectUri: string;
   scopes: string[];
}

export class AuthorizationNotPending extends Error {
   override readonly name = 'AuthorizationNotPending';
   constructor() {
      super('this callback does not match an authorization this server started');
   }
}

export interface OAuthStateStoreOptions {
   sql: Sql;
   clock?: () => Date;
   newState?: () => string;
   ttlMs?: number;
}

export class OAuthStateStore {
   readonly #sql: Sql;
   readonly #clock: () => Date;
   readonly #newState: () => string;
   readonly #ttlMs: number;

   constructor(options: OAuthStateStoreOptions) {
      this.#sql = options.sql;
      this.#clock = options.clock ?? (() => new Date());
      this.#newState = options.newState ?? (() => randomBytes(32).toString('base64url'));
      this.#ttlMs = options.ttlMs ?? STATE_TTL_MS;
   }

   async start(input: {
      /**
       * Null only for first-run App setup: creating the App is the one flow
       * that runs before this deployment has a workspace or a user at all.
       */
      workspaceId: string | null;
      userId: string | null;
      provider: string;
      redirectUri: string;
      scopes: string[];
   }): Promise<PendingAuthorization> {
      const state = this.#newState();
      const expiresAt = new Date(this.#clock().getTime() + this.#ttlMs).toISOString();
      await this.#sql`
         INSERT INTO integration_oauth_states
            (state_hash, workspace_id, user_id, provider, redirect_uri, scopes, expires_at)
         VALUES (${hash(state)}, ${input.workspaceId}, ${input.userId}, ${input.provider},
                 ${input.redirectUri}, ${input.scopes}, ${expiresAt})`;
      return { state, redirectUri: input.redirectUri, scopes: input.scopes };
   }

   /**
    * Consumes a state, or refuses.
    *
    * The `consumed_at IS NULL` is inside the UPDATE rather than checked first,
    * so two callbacks arriving together cannot both succeed — the second
    * updates no rows and is refused.
    */
   async consume(state: string): Promise<ResolvedAuthorization> {
      const now = this.#clock().toISOString();
      const [row] = await this.#sql`
         UPDATE integration_oauth_states
            SET consumed_at = ${now}
          WHERE state_hash = ${hash(state)}
            AND consumed_at IS NULL
            AND expires_at > ${now}
          RETURNING workspace_id, user_id, provider, redirect_uri, scopes`;
      if (!row) throw new AuthorizationNotPending();
      return {
         workspaceId: (row.workspace_id as string | null) ?? null,
         userId: (row.user_id as string | null) ?? null,
         provider: row.provider as string,
         redirectUri: row.redirect_uri as string,
         scopes: (row.scopes as string[]) ?? [],
      };
   }

   /** Expired rows are of no use to anyone; swept opportunistically. */
   async sweep(): Promise<void> {
      await this.#sql`
         DELETE FROM integration_oauth_states
          WHERE expires_at < ${this.#clock().toISOString()}`;
   }
}

function hash(state: string): Buffer {
   return createHash('sha256').update(state).digest();
}

// ------------------------------------------------------------------- GitHub

export class ExchangeFailed extends Error {
   override readonly name = 'ExchangeFailed';
   /** What the settings page should say, as `describeConnectionResult` words it. */
   readonly outcome: 'denied' | 'exchange_failed' | 'invalid_response';
   constructor(message: string, outcome: 'denied' | 'exchange_failed' | 'invalid_response') {
      super(message);
      this.outcome = outcome;
   }
}

export interface GitHubOAuthOptions {
   clientId: string;
   clientSecret: string;
   fetch?: typeof globalThis.fetch;
   /** Overridden for GitHub Enterprise, and by tests. */
   baseUrl?: string;
   apiBaseUrl?: string;
}

export interface ExchangedCredential {
   accessToken: string;
   refreshToken: string | null;
   expiresAt: string | null;
   scopes: string[];
   accountId: string | null;
   accountName: string | null;
}

/**
 * Where to send the browser, and what to do with what comes back.
 *
 * Deliberately not a class with state: the exchange is one round trip and the
 * result is handed straight to the connection store, so nothing here should
 * outlive the request.
 */
export function githubAuthorizeUrl(
   options: GitHubOAuthOptions,
   pending: PendingAuthorization
): string {
   const url = new URL('/login/oauth/authorize', options.baseUrl ?? 'https://github.com');
   url.searchParams.set('client_id', options.clientId);
   url.searchParams.set('redirect_uri', pending.redirectUri);
   url.searchParams.set('scope', pending.scopes.join(' '));
   url.searchParams.set('state', pending.state);
   return url.toString();
}

export async function exchangeGitHubCode(
   options: GitHubOAuthOptions,
   input: { code: string; redirectUri: string }
): Promise<ExchangedCredential> {
   const doFetch = options.fetch ?? globalThis.fetch;
   const response = await doFetch(
      new URL('/login/oauth/access_token', options.baseUrl ?? 'https://github.com'),
      {
         method: 'POST',
         headers: { accept: 'application/json', 'content-type': 'application/json' },
         body: JSON.stringify({
            client_id: options.clientId,
            client_secret: options.clientSecret,
            code: input.code,
            redirect_uri: input.redirectUri,
         }),
      }
   ).catch((cause: unknown) => {
      throw new ExchangeFailed(`github could not be reached: ${String(cause)}`, 'exchange_failed');
   });

   if (!response.ok) {
      throw new ExchangeFailed(`github refused the exchange: ${response.status}`, 'exchange_failed');
   }

   const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
   if (!body) throw new ExchangeFailed('github sent a body this server cannot read', 'invalid_response');

   // GitHub answers 200 with an `error` field rather than a status code, so
   // the happy path has to be checked for rather than assumed.
   if (typeof body.error === 'string') {
      throw new ExchangeFailed(
         `github refused the exchange: ${body.error}`,
         body.error === 'access_denied' ? 'denied' : 'exchange_failed'
      );
   }
   const accessToken = body.access_token;
   if (typeof accessToken !== 'string' || accessToken === '') {
      throw new ExchangeFailed('github returned no access token', 'invalid_response');
   }

   const account = await identify(doFetch, accessToken, options.apiBaseUrl);
   return {
      accessToken,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      // GitHub's classic tokens do not expire; its app tokens send seconds.
      expiresAt:
         typeof body.expires_in === 'number'
            ? new Date(Date.now() + body.expires_in * 1000).toISOString()
            : null,
      scopes: typeof body.scope === 'string' && body.scope !== '' ? body.scope.split(',') : [],
      accountId: account.id,
      accountName: account.name,
   };
}

/**
 * Whose account was just connected.
 *
 * Asked for so the settings page can say "connected as @someone" rather than
 * "connected", which is the difference between a person being able to check
 * the connection and having to take it on trust. A failure here is not fatal:
 * the credential works, and the name is a label.
 */
async function identify(
   doFetch: typeof globalThis.fetch,
   token: string,
   apiBaseUrl: string | undefined
): Promise<{ id: string | null; name: string | null }> {
   try {
      const response = await doFetch(new URL('/user', apiBaseUrl ?? 'https://api.github.com'), {
         headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': '2022-11-28',
         },
      });
      if (!response.ok) return { id: null, name: null };
      const body = (await response.json()) as { id?: unknown; login?: unknown };
      return {
         id: typeof body.id === 'number' ? String(body.id) : null,
         name: typeof body.login === 'string' ? body.login : null,
      };
   } catch {
      return { id: null, name: null };
   }
}

/**
 * Constant-time comparison for a state that arrived in a query string.
 *
 * Not used by `consume`, which looks the row up by hash and so never compares
 * secrets in the application at all. Exported for a caller that has both
 * halves in hand and wants to check them without leaking a timing signal.
 */
export function statesMatch(a: string, b: string): boolean {
   const left = Buffer.from(a);
   const right = Buffer.from(b);
   return left.length === right.length && timingSafeEqual(left, right);
}

export type { Sealer };
