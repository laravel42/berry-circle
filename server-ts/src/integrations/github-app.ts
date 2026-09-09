import { createSign } from 'node:crypto';
import type { Sql } from '../db/pool.ts';
import type { Sealer } from './sealing.ts';

/**
 * The GitHub App this deployment created for itself, and the tokens it mints.
 *
 * Berry does not take an App's credentials from the environment. It posts a
 * manifest, a person presses Create on GitHub, and the conversion hands back
 * everything at once — which is also what lets the callback URLs be registered
 * correctly rather than typed by hand into a settings page.
 *
 * Repository work then runs on an *installation* token: minted from the App's
 * private key, good for an hour, and renewed here rather than by anyone. That
 * is the difference that matters for unattended runs — a user token expires
 * overnight and needs a person, an installation token does not.
 */

/** What the manifest conversion returns, less the fields Berry ignores. */
export interface ConvertedApp {
   appId: number;
   slug: string;
   name: string;
   clientId: string;
   clientSecret: string;
   privateKey: string;
   webhookSecret: string | null;
   htmlUrl: string | null;
}

export interface StoredApp {
   appId: number;
   slug: string;
   name: string;
   clientId: string;
   htmlUrl: string | null;
   createdAt: string;
}

export interface Installation {
   workspaceId: string;
   installationId: number;
   accountLogin: string | null;
   accountType: string | null;
}

export class GitHubAppUnavailable extends Error {
   override readonly name = 'GitHubAppUnavailable';
   readonly reason: 'no_app' | 'not_installed' | 'mint_failed' | 'not_owned';

   constructor(
      message: string,
      reason: 'no_app' | 'not_installed' | 'mint_failed' | 'not_owned'
   ) {
      super(message);
      this.reason = reason;
   }
}

/** Base64url without padding, which is what a JWT wants. */
function base64url(value: Buffer | string): string {
   return (typeof value === 'string' ? Buffer.from(value, 'utf8') : value)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
}

/**
 * The App's own JWT, which is how GitHub is asked for an installation token.
 *
 * Backdated a minute because GitHub rejects a token whose `iat` is in its
 * future, and a container's clock is not the same clock. Ten minutes is the
 * maximum GitHub accepts; it is never stored, only exchanged.
 */
export function appJwt(appId: number, privateKey: string, now: Date = new Date()): string {
   const issued = Math.floor(now.getTime() / 1000) - 60;
   const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
   const payload = base64url(
      JSON.stringify({ iat: issued, exp: issued + 9 * 60, iss: String(appId) })
   );
   const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
   return `${header}.${payload}.${base64url(signature)}`;
}

interface AppRow {
   app_id: string;
   slug: string;
   name: string;
   client_id: string;
   client_secret_encrypted: Buffer;
   private_key_encrypted: Buffer;
   webhook_secret_encrypted: Buffer | null;
   html_url: string | null;
   created_at: Date | string;
}

export interface GitHubAppRepositoryOptions {
   sql: Sql;
   sealer: Sealer;
   fetch?: typeof globalThis.fetch;
   clock?: () => Date;
   /** How long before expiry a minted token stops being reused. */
   tokenMarginMs?: number;
   /** Overridden in tests; GitHub's API origin otherwise. */
   apiBaseUrl?: string;
}

const DEFAULT_TOKEN_MARGIN_MS = 60_000;

interface CachedToken {
   token: string;
   expiresAtMs: number;
}

export class GitHubAppRepository {
   readonly #sql: Sql;
   readonly #sealer: Sealer;
   readonly #fetch: typeof globalThis.fetch;
   readonly #clock: () => Date;
   readonly #margin: number;
   readonly #api: string;
   /** Per installation, so two runs in a workspace share one mint. */
   readonly #tokens = new Map<number, CachedToken>();
   /** In-flight mints, so concurrent runs do not each ask GitHub. */
   readonly #minting = new Map<number, Promise<string>>();

   constructor(options: GitHubAppRepositoryOptions) {
      this.#sql = options.sql;
      this.#sealer = options.sealer;
      this.#fetch = options.fetch ?? globalThis.fetch;
      this.#clock = options.clock ?? (() => new Date());
      this.#margin = options.tokenMarginMs ?? DEFAULT_TOKEN_MARGIN_MS;
      this.#api = options.apiBaseUrl ?? 'https://api.github.com';
   }

   /**
    * What the installation may actually do, as GitHub reports it.
    *
    * Read from the installation rather than from a repository listing: the
    * per-repository `permissions` object is not meaningful for an installation
    * token — one granting `contents` was observed reporting `push:false` on
    * every repository. `contents: write` is what a run needs to push, and this
    * is the only place that answer is truthful.
    */
   async grantedPermissions(workspaceId: string): Promise<Record<string, string> | null> {
      const installed = await this.installation(workspaceId);
      if (!installed) return null;
      const jwt = await this.#jwt();
      const response = await this.#fetch(
         new URL(`/app/installations/${installed.installationId}`, this.#api),
         {
            headers: {
               accept: 'application/vnd.github+json',
               authorization: `Bearer ${jwt}`,
               'x-github-api-version': '2022-11-28',
            },
         }
      );
      if (!response.ok) return null;
      const body = (await response.json().catch(() => ({}))) as {
         permissions?: Record<string, string>;
      };
      return body.permissions ?? null;
   }

   /** The App, without anything sealed — safe to send to a settings page. */
   async app(): Promise<StoredApp | null> {
      const [row] = await this.#sql<AppRow[]>`
         SELECT app_id, slug, name, client_id, client_secret_encrypted,
                private_key_encrypted, webhook_secret_encrypted, html_url, created_at
           FROM github_apps LIMIT 1`;
      if (!row) return null;
      return {
         appId: Number(row.app_id),
         slug: row.slug,
         name: row.name,
         clientId: row.client_id,
         htmlUrl: row.html_url,
         createdAt: new Date(row.created_at).toISOString(),
      };
   }

   /**
    * Stores what the manifest conversion returned, replacing any earlier App.
    *
    * Replacing rather than refusing: creating a second App is a deliberate act
    * someone took on GitHub, and the alternative is a deployment that cannot
    * recover from a deleted App without a database console.
    */
   async saveApp(input: ConvertedApp, createdBy: string | null): Promise<StoredApp> {
      await this.#sql`
         INSERT INTO github_apps (singleton, app_id, slug, name, client_id,
                client_secret_encrypted, private_key_encrypted,
                webhook_secret_encrypted, html_url, created_by)
         VALUES (true, ${input.appId}, ${input.slug}, ${input.name}, ${input.clientId},
                 ${this.#sealer.seal(input.clientSecret)},
                 ${this.#sealer.seal(input.privateKey)},
                 ${input.webhookSecret ? this.#sealer.seal(input.webhookSecret) : null},
                 ${input.htmlUrl}, ${createdBy})
         ON CONFLICT (singleton) DO UPDATE
            SET app_id = EXCLUDED.app_id, slug = EXCLUDED.slug, name = EXCLUDED.name,
                client_id = EXCLUDED.client_id,
                client_secret_encrypted = EXCLUDED.client_secret_encrypted,
                private_key_encrypted = EXCLUDED.private_key_encrypted,
                webhook_secret_encrypted = EXCLUDED.webhook_secret_encrypted,
                html_url = EXCLUDED.html_url, updated_at = now()`;
      this.#tokens.clear();
      const saved = await this.app();
      if (!saved) throw new GitHubAppUnavailable('the App was not stored', 'no_app');
      return saved;
   }

   /** Records where a workspace installed the App. */
   async saveInstallation(input: Installation, installedBy: string | null): Promise<void> {
      await this.#sql`
         INSERT INTO github_installations (workspace_id, installation_id, account_login,
                account_type, installed_by)
         VALUES (${input.workspaceId}, ${input.installationId}, ${input.accountLogin},
                 ${input.accountType}, ${installedBy})
         ON CONFLICT (workspace_id) DO UPDATE
            SET installation_id = EXCLUDED.installation_id,
                account_login = EXCLUDED.account_login,
                account_type = EXCLUDED.account_type, updated_at = now()`;
      this.#tokens.delete(input.installationId);
   }

   async installation(workspaceId: string): Promise<Installation | null> {
      const [row] = await this.#sql<
         Array<{
            workspace_id: string;
            installation_id: string;
            account_login: string | null;
            account_type: string | null;
         }>
      >`
         SELECT workspace_id, installation_id, account_login, account_type
           FROM github_installations WHERE workspace_id = ${workspaceId}`;
      if (!row) return null;
      return {
         workspaceId: row.workspace_id,
         installationId: Number(row.installation_id),
         accountLogin: row.account_login,
         accountType: row.account_type,
      };
   }

   async removeInstallation(workspaceId: string): Promise<void> {
      const existing = await this.installation(workspaceId);
      await this.#sql`DELETE FROM github_installations WHERE workspace_id = ${workspaceId}`;
      if (existing) this.#tokens.delete(existing.installationId);
   }

   /** The OAuth half, for the flows that still sign a person in. */
   async clientCredentials(): Promise<{ clientId: string; clientSecret: string } | null> {
      const [row] = await this.#sql<Array<Pick<AppRow, 'client_id' | 'client_secret_encrypted'>>>`
         SELECT client_id, client_secret_encrypted FROM github_apps LIMIT 1`;
      if (!row) return null;
      return {
         clientId: row.client_id,
         clientSecret: this.#sealer.open(Buffer.from(row.client_secret_encrypted)),
      };
   }

   /**
    * A token a workspace's agents can clone and push with.
    *
    * Cached until shortly before it expires, and one mint per installation even
    * when several runs ask at once — GitHub rate-limits the exchange, and two
    * runs starting together should not each spend one.
    */
   async token(workspaceId: string): Promise<string> {
      const installation = await this.installation(workspaceId);
      if (!installation) {
         throw new GitHubAppUnavailable(
            'the GitHub App is not installed for this workspace',
            'not_installed'
         );
      }

      const cached = this.#tokens.get(installation.installationId);
      if (cached && cached.expiresAtMs - this.#margin > this.#clock().getTime()) {
         return cached.token;
      }

      const inFlight = this.#minting.get(installation.installationId);
      if (inFlight) return inFlight;

      const pending = this.#mint(installation.installationId).finally(() => {
         this.#minting.delete(installation.installationId);
      });
      this.#minting.set(installation.installationId, pending);
      return pending;
   }

   /** The App's own JWT, for the calls GitHub authenticates as the App. */
   async #jwt(): Promise<string> {
      const [row] = await this.#sql<Array<Pick<AppRow, 'app_id' | 'private_key_encrypted'>>>`
         SELECT app_id, private_key_encrypted FROM github_apps LIMIT 1`;
      if (!row) {
         throw new GitHubAppUnavailable('this deployment has no GitHub App', 'no_app');
      }
      return appJwt(
         Number(row.app_id),
         this.#sealer.open(Buffer.from(row.private_key_encrypted)),
         this.#clock()
      );
   }

   /**
    * Asks GitHub what an installation actually is, before believing in it.
    *
    * The id arrives in a query parameter on a redirect, which means the person
    * completing the flow chose it. Left unchecked, someone could point their
    * workspace at another account's installation and mint tokens against it —
    * the App JWT authenticates the App, not the person, so GitHub would oblige.
    */
   async describeInstallation(
      installationId: number
   ): Promise<{ accountLogin: string | null; accountType: string | null }> {
      const jwt = await this.#jwt();
      const response = await this.#fetch(
         new URL(`/app/installations/${installationId}`, this.#api),
         {
            headers: {
               accept: 'application/vnd.github+json',
               authorization: `Bearer ${jwt}`,
               'x-github-api-version': '2022-11-28',
            },
         }
      );
      if (!response.ok) {
         throw new GitHubAppUnavailable(
            `GitHub does not recognise installation ${installationId} (${response.status})`,
            'not_owned'
         );
      }
      const body = (await response.json()) as { account?: { login?: unknown; type?: unknown } };
      return {
         accountLogin: typeof body.account?.login === 'string' ? body.account.login : null,
         accountType: typeof body.account?.type === 'string' ? body.account.type : null,
      };
   }

   /** The workspace already using this installation, if another one is. */
   async claimedBy(installationId: number): Promise<string | null> {
      const [row] = await this.#sql<Array<{ workspace_id: string }>>`
         SELECT workspace_id FROM github_installations
          WHERE installation_id = ${installationId} LIMIT 1`;
      return row?.workspace_id ?? null;
   }

   async #mint(installationId: number): Promise<string> {
      const jwt = await this.#jwt();
      const response = await this.#fetch(
         new URL(`/app/installations/${installationId}/access_tokens`, this.#api),
         {
            method: 'POST',
            headers: {
               accept: 'application/vnd.github+json',
               authorization: `Bearer ${jwt}`,
               'x-github-api-version': '2022-11-28',
            },
         }
      );
      if (!response.ok) {
         // The body can name a revoked installation or a suspended App, and
         // that is the difference between "install it again" and "it is gone".
         const detail = (await response.text().catch(() => '')).slice(0, 200);
         throw new GitHubAppUnavailable(
            `GitHub refused an installation token (${response.status})${detail ? `: ${detail}` : ''}`,
            'mint_failed'
         );
      }

      const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
      if (typeof body.token !== 'string' || typeof body.expires_at !== 'string') {
         throw new GitHubAppUnavailable('GitHub returned an unrecognised token', 'mint_failed');
      }
      const expiresAtMs = Date.parse(body.expires_at);
      this.#tokens.set(installationId, {
         token: body.token,
         expiresAtMs: Number.isNaN(expiresAtMs) ? this.#clock().getTime() : expiresAtMs,
      });
      return body.token;
   }
}

/**
 * What Berry asks GitHub to create on its behalf.
 *
 * Every URL GitHub will ever redirect to is declared here, which is the point
 * of the flow: the callback that has to match exactly is registered by the same
 * request that creates the App, so it cannot be typed in wrong.
 *
 * Permissions are the least that lets an agent do the job it is given — read
 * the code, push a branch, open a pull request and talk on the issue. Nothing
 * here grants administration, and no event is subscribed to that Berry does not
 * act on.
 */
export function buildManifest(input: {
   name: string;
   appOrigin: string;
   apiOrigin: string;
}): Record<string, unknown> {
   const api = (path: string) => new URL(path, input.apiOrigin).toString();
   // Both origins, when they differ. The browser reaches the API directly and
   // through the app's own proxy, and GitHub matches a redirect_uri exactly —
   // registering only one is how "redirect_uri is not associated with this
   // application" happens. GitHub accepts several.
   const callbackPath = '/api/v1/integrations/callback/github';
   const callbacks = [...new Set([
      new URL(callbackPath, input.apiOrigin).toString(),
      new URL(callbackPath, input.appOrigin).toString(),
   ])];
   return {
      name: input.name,
      url: input.appOrigin,
      redirect_url: api('/api/v1/integrations/github/app/callback'),
      callback_urls: callbacks,
      setup_url: api('/api/v1/integrations/github/installation/callback'),
      setup_on_update: true,
      hook_attributes: { url: api('/api/v1/integrations/github/webhook'), active: false },
      public: false,
      default_permissions: {
         contents: 'write',
         pull_requests: 'write',
         issues: 'write',
         metadata: 'read',
      },
      default_events: ['pull_request', 'push'],
   };
}

/**
 * Exchanges the one-time code GitHub returns after the App is created.
 *
 * The code is good for an hour and once only, and the answer is the only time
 * GitHub ever shows the private key — so a failure here means creating the App
 * again rather than retrying.
 */
export async function convertManifest(
   code: string,
   options: { fetch?: typeof globalThis.fetch; apiBaseUrl?: string } = {}
): Promise<ConvertedApp> {
   const doFetch = options.fetch ?? globalThis.fetch;
   const response = await doFetch(
      new URL(`/app-manifests/${encodeURIComponent(code)}/conversions`, options.apiBaseUrl ?? 'https://api.github.com'),
      {
         method: 'POST',
         headers: {
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
         },
      }
   );
   if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new GitHubAppUnavailable(
         `GitHub refused the manifest conversion (${response.status})${detail ? `: ${detail}` : ''}`,
         'no_app'
      );
   }

   const body = (await response.json()) as Record<string, unknown>;
   const appId = typeof body.id === 'number' ? body.id : Number(body.id);
   const pem = body.pem;
   const clientId = body.client_id;
   const clientSecret = body.client_secret;
   if (
      !Number.isFinite(appId) ||
      typeof pem !== 'string' ||
      typeof clientId !== 'string' ||
      typeof clientSecret !== 'string'
   ) {
      throw new GitHubAppUnavailable('GitHub returned an unrecognised App', 'no_app');
   }

   return {
      appId,
      slug: typeof body.slug === 'string' ? body.slug : String(appId),
      name: typeof body.name === 'string' ? body.name : 'Berry',
      clientId,
      clientSecret,
      privateKey: pem,
      webhookSecret: typeof body.webhook_secret === 'string' ? body.webhook_secret : null,
      htmlUrl: typeof body.html_url === 'string' ? body.html_url : null,
   };
}
