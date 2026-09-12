import { symmetricDecrypt } from 'better-auth/crypto';

import type { Queryable, Sql } from '../db/pool.ts';

/**
 * What a signed-in person granted Berry on GitHub, read with their own token.
 *
 * This deployment holds no App private key, so it cannot mint an installation
 * token: `/installation/repositories` — the endpoint every other repository
 * listing in Berry uses — is closed to it, and pretending otherwise would show
 * an empty picker and call it "no repositories". What it does hold is the
 * user-to-server token Better Auth stored at sign-in, and that token answers two
 * questions no other credential can:
 *
 *   GET /user/installations                              where they installed it
 *   GET /user/installations/{id}/repositories            what they granted there
 *
 * Both answers are recorded — the installations where the rest of the
 * integration already looks for them, the repositories in
 * `github_granted_repositories` — so every surface that lists repositories reads
 * a table rather than a live call needing a credential that may be absent, and
 * the list outlives the session that fetched it.
 *
 * What this cannot do is clone, branch or push: those need an installation token
 * and therefore the App's private key. Nothing here pretends otherwise.
 *
 * The token is read, used and dropped. It is never returned, never logged, and
 * never part of an error message.
 */

/** One account the person installed the App on, as this module recorded it. */
export interface UserInstallation {
   installationId: number;
   accountLogin: string | null;
   accountType: string | null;
   /**
    * Another workspace already mints against this installation, so nothing was
    * recorded for it here. Reported rather than hidden: somebody looking for an
    * organisation's repositories deserves to know they are somebody else's.
    */
   claimedElsewhere: boolean;
   /** How many repositories it granted. Zero for one claimed elsewhere. */
   repositories: number;
}

/** A repository GitHub reported as granted, as this workspace holds it. */
export interface GrantedRepository {
   repositoryId: number;
   installationId: number;
   fullName: string;
   owner: string;
   private: boolean;
   defaultBranch: string | null;
   accountLogin: string | null;
   accountType: string | null;
   htmlUrl: string;
   refreshedAt: string;
}

export interface GrantSummary {
   installations: UserInstallation[];
   repositories: GrantedRepository[];
}

/**
 * Why reading a person's grants could not happen.
 *
 * The three reasons are three different things to do: link a GitHub account,
 * sign in again, or wait and retry. Collapsing them into an empty list is the
 * failure this class exists to prevent.
 */
export class GitHubUserUnavailable extends Error {
   override readonly name = 'GitHubUserUnavailable';
   readonly reason: 'not_linked' | 'sign_in_again' | 'github_error';

   constructor(message: string, reason: GitHubUserUnavailable['reason']) {
      super(message);
      this.reason = reason;
   }
}

export interface GitHubUserAccessOptions {
   sql: Sql;
   /**
    * Better Auth's secret, which is what the stored token is sealed with.
    *
    * Null on a deployment with no sign-in configured: there is no token to read
    * and no secret to read it with, which reads as "nobody linked an account".
    */
   authSecret: string | null;
   fetch?: typeof globalThis.fetch;
   apiBaseUrl?: string;
}

interface InstallationsBody {
   installations?: Array<{ id?: unknown; account?: { login?: unknown; type?: unknown } }>;
}

interface RepositoriesBody {
   repositories?: Array<{
      id?: unknown;
      full_name?: unknown;
      private?: unknown;
      default_branch?: unknown;
      html_url?: unknown;
   }>;
}

/** A page of a hundred, ten pages deep — where a grant stops and a mirror starts. */
const PER_PAGE = 100;
const MAX_PAGES = 10;

interface GrantedRow {
   repository_id: string | number;
   installation_id: string | number;
   full_name: string;
   private: boolean;
   default_branch: string | null;
   account_login: string | null;
   account_type: string | null;
   html_url: string | null;
   refreshed_at: Date | string;
}

/**
 * One row as every surface reads it.
 *
 * Exported so a workspace-scoped query elsewhere maps rows the same way: a
 * second copy of this is how two pages come to disagree about a repository.
 */
export function toGrantedRepository(row: GrantedRow): GrantedRepository {
   const fullName = row.full_name;
   return {
      repositoryId: Number(row.repository_id),
      installationId: Number(row.installation_id),
      fullName,
      owner: fullName.split('/')[0] ?? '',
      private: row.private,
      defaultBranch: row.default_branch,
      accountLogin: row.account_login,
      accountType: row.account_type,
      htmlUrl: row.html_url ?? `https://github.com/${fullName}`,
      refreshedAt: new Date(row.refreshed_at).toISOString(),
   };
}

export class GitHubUserAccess {
   readonly #sql: Sql;
   readonly #secret: string | null;
   readonly #fetch: typeof globalThis.fetch;
   readonly #api: string;

   constructor(options: GitHubUserAccessOptions) {
      this.#sql = options.sql;
      this.#secret = options.authSecret;
      this.#fetch = options.fetch ?? globalThis.fetch;
      this.#api = options.apiBaseUrl ?? 'https://api.github.com';
   }

   /** This workspace's granted repositories, grouped by account, named in order. */
   async granted(workspaceId: string): Promise<GrantedRepository[]> {
      const rows = await this.#sql<GrantedRow[]>`
         SELECT repository_id, installation_id, full_name, private, default_branch,
                account_login, account_type, html_url, refreshed_at
           FROM github_granted_repositories
          WHERE workspace_id = ${workspaceId}
          ORDER BY account_login, full_name`;
      return rows.map(toGrantedRepository);
   }

   /**
    * Asks GitHub what this person granted, and records the answer.
    *
    * Replacing rather than merging: the grant is GitHub's to narrow, and a
    * repository somebody removed there has to disappear here too, or the page
    * offers work against a repository no credential can reach. The delete and
    * the inserts are one transaction, so a workspace is never briefly listed as
    * having nothing.
    *
    * An installation another workspace already holds is skipped and reported.
    * The unique index on `installation_id` is the rule; this is the reading of
    * it that can say *why* an organisation's repositories are not here.
    */
   async refresh(input: { workspaceId: string; userId: string }): Promise<GrantSummary> {
      const token = await this.#token(input.userId);
      const installations = await this.#installations(token, input.userId);

      const recorded: UserInstallation[] = [];
      const rows: Array<{
         repositoryId: number;
         installationId: number;
         fullName: string;
         private: boolean;
         defaultBranch: string | null;
         accountLogin: string | null;
         accountType: string | null;
         htmlUrl: string | null;
      }> = [];

      for (const installation of installations) {
         const [claim] = await this.#sql<Array<{ workspace_id: string }>>`
            SELECT workspace_id FROM github_installations
             WHERE installation_id = ${installation.installationId}`;
         if (claim && claim.workspace_id !== input.workspaceId) {
            recorded.push({ ...installation, claimedElsewhere: true, repositories: 0 });
            continue;
         }
         await this.#sql`
            INSERT INTO github_installations (workspace_id, installation_id, account_login,
                   account_type, installed_by)
            VALUES (${input.workspaceId}, ${installation.installationId},
                    ${installation.accountLogin}, ${installation.accountType}, ${input.userId})
            ON CONFLICT (workspace_id, installation_id) DO UPDATE
               SET account_login = EXCLUDED.account_login,
                   account_type = EXCLUDED.account_type, updated_at = now()`;

         const repositories = await this.#repositories(token, installation.installationId, input.userId);
         for (const repository of repositories) {
            rows.push({
               ...repository,
               installationId: installation.installationId,
               accountLogin: installation.accountLogin,
               accountType: installation.accountType,
            });
         }
         recorded.push({
            ...installation,
            claimedElsewhere: false,
            repositories: repositories.length,
         });
      }

      // Only the workspace's own rows are replaced, and only once GitHub has
      // answered for every account: a failure half way through leaves the last
      // good list standing rather than emptying the page.
      await this.#sql.begin(async (tx: Queryable) => {
         await tx`DELETE FROM github_granted_repositories WHERE workspace_id = ${input.workspaceId}`;
         for (const row of rows) {
            await tx`
               INSERT INTO github_granted_repositories (workspace_id, repository_id,
                      installation_id, full_name, private, default_branch, account_login,
                      account_type, html_url, refreshed_at)
               VALUES (${input.workspaceId}, ${row.repositoryId}, ${row.installationId},
                       ${row.fullName}, ${row.private}, ${row.defaultBranch},
                       ${row.accountLogin}, ${row.accountType}, ${row.htmlUrl}, now())
               ON CONFLICT (workspace_id, repository_id) DO UPDATE
                  SET installation_id = EXCLUDED.installation_id,
                      full_name = EXCLUDED.full_name, private = EXCLUDED.private,
                      default_branch = EXCLUDED.default_branch,
                      account_login = EXCLUDED.account_login,
                      account_type = EXCLUDED.account_type, html_url = EXCLUDED.html_url,
                      refreshed_at = now()`;
         }
      });

      // An install everybody here was waiting on has happened, so the offer that
      // recorded the waiting goes: leaving it would have the settings page still
      // asking an owner for something they have already done.
      if (recorded.some((one) => !one.claimedElsewhere)) {
         await this.#sql`
            DELETE FROM github_install_offers WHERE workspace_id = ${input.workspaceId}`;
      }

      return { installations: recorded, repositories: await this.granted(input.workspaceId) };
   }

   /**
    * The person's GitHub token, unsealed.
    *
    * Better Auth seals it with the deployment's auth secret, and the shape it
    * writes is recognisable — so a row written before sealing was turned on is
    * read as it stands rather than refused. The value is returned to one caller
    * inside this module and never leaves it.
    */
   async #token(userId: string): Promise<string> {
      const [row] = await this.#sql<Array<{ access_token: string | null }>>`
         SELECT access_token FROM auth_accounts
          WHERE user_id = ${userId} AND provider_id = 'github'
          ORDER BY updated_at DESC LIMIT 1`;
      if (!row) {
         throw new GitHubUserUnavailable('no GitHub account is linked to this user', 'not_linked');
      }
      const stored = (row.access_token ?? '').trim();
      if (stored === '') {
         // A row with no token is the state a revoked one is cleared to: the
         // person has an account, and what they need is to sign in again.
         throw new GitHubUserUnavailable(
            'the stored GitHub token is gone; sign in again',
            'sign_in_again'
         );
      }
      if (!sealed(stored)) return stored;
      if (this.#secret === null) {
         throw new GitHubUserUnavailable(
            'this deployment has no auth secret, so a stored token cannot be opened',
            'sign_in_again'
         );
      }
      try {
         return await symmetricDecrypt({ key: this.#secret, data: stored });
      } catch {
         // The secret changed under the stored token. Nothing here can recover
         // it, and the one thing that can is a fresh sign-in.
         throw new GitHubUserUnavailable(
            'the stored GitHub token could not be opened; sign in again',
            'sign_in_again'
         );
      }
   }

   /** Where this person installed the App, as GitHub lists it for their token. */
   async #installations(
      token: string,
      userId: string
   ): Promise<Array<Pick<UserInstallation, 'installationId' | 'accountLogin' | 'accountType'>>> {
      const collected: Array<
         Pick<UserInstallation, 'installationId' | 'accountLogin' | 'accountType'>
      > = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
         const body = await this.#json<InstallationsBody>(
            token,
            userId,
            `/user/installations?per_page=${PER_PAGE}&page=${page}`
         );
         const rows = body.installations ?? [];
         for (const row of rows) {
            const id = Number(row.id);
            if (!Number.isSafeInteger(id) || id <= 0) continue;
            collected.push({
               installationId: id,
               accountLogin: typeof row.account?.login === 'string' ? row.account.login : null,
               accountType: typeof row.account?.type === 'string' ? row.account.type : null,
            });
         }
         if (rows.length < PER_PAGE) break;
      }
      return collected;
   }

   /** What one installation was granted. */
   async #repositories(
      token: string,
      installationId: number,
      userId: string
   ): Promise<
      Array<{
         repositoryId: number;
         fullName: string;
         private: boolean;
         defaultBranch: string | null;
         htmlUrl: string | null;
      }>
   > {
      const collected: Array<{
         repositoryId: number;
         fullName: string;
         private: boolean;
         defaultBranch: string | null;
         htmlUrl: string | null;
      }> = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
         const body = await this.#json<RepositoriesBody>(
            token,
            userId,
            `/user/installations/${installationId}/repositories?per_page=${PER_PAGE}&page=${page}`
         );
         const rows = body.repositories ?? [];
         for (const row of rows) {
            const id = Number(row.id);
            const fullName = typeof row.full_name === 'string' ? row.full_name : '';
            if (!Number.isSafeInteger(id) || id <= 0 || fullName === '') continue;
            collected.push({
               repositoryId: id,
               fullName,
               private: row.private === true,
               defaultBranch: typeof row.default_branch === 'string' ? row.default_branch : null,
               htmlUrl: typeof row.html_url === 'string' ? row.html_url : null,
            });
         }
         if (rows.length < PER_PAGE) break;
      }
      return collected;
   }

   /**
    * One call, with the two failures that mean something specific.
    *
    * 401 is the token being revoked or expired — GitHub's answer, not a guess —
    * and the stale token is cleared before the caller is told to sign in again,
    * so nothing retries with a credential that is already refused. Neither the
    * token nor the response body reaches a message: a body can quote a header.
    */
   async #json<T>(token: string, userId: string, path: string): Promise<T> {
      let response: Response;
      try {
         response = await this.#fetch(new URL(path, this.#api), {
            headers: {
               accept: 'application/vnd.github+json',
               authorization: `Bearer ${token}`,
               'x-github-api-version': '2022-11-28',
            },
         });
      } catch {
         throw new GitHubUserUnavailable('GitHub could not be reached', 'github_error');
      }
      if (response.status === 401) {
         await this.#forgetToken(userId);
         throw new GitHubUserUnavailable(
            'GitHub refused the stored sign-in token; sign in again',
            'sign_in_again'
         );
      }
      if (!response.ok) {
         throw new GitHubUserUnavailable(
            `GitHub answered ${response.status} for ${path.split('?')[0]}`,
            'github_error'
         );
      }
      try {
         return (await response.json()) as T;
      } catch {
         throw new GitHubUserUnavailable('GitHub sent something that was not JSON', 'github_error');
      }
   }

   /**
    * Drops the token GitHub has refused.
    *
    * The row stays: it is what links this person to their GitHub account, and
    * the next sign-in fills the token back in. Clearing it is what stops a
    * background refresh hammering GitHub with a credential it has rejected.
    */
   async #forgetToken(userId: string): Promise<void> {
      await this.#sql`
         UPDATE auth_accounts SET access_token = NULL, updated_at = now()
          WHERE user_id = ${userId} AND provider_id = 'github'`;
   }
}

/**
 * Whether a stored token is one Better Auth sealed.
 *
 * The same test Better Auth applies when reading one back: its envelope, or the
 * bare hex of the format before it. A GitHub token (`ghu_…`, `gho_…`) matches
 * neither, so a deployment that stored tokens unsealed still works.
 */
function sealed(token: string): boolean {
   if (token.startsWith('$ba$')) return true;
   return token.length % 2 === 0 && /^[0-9a-f]+$/i.test(token);
}
