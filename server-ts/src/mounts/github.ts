import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { SessionService } from '../auth/sessions.ts';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { assertValid, decodeBody, fieldError } from '../http/body.ts';
import { ApiError, type FieldError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import type { Queryable } from '../db/pool.ts';
import { Forbidden, NotFound, toApiError } from '../identity/errors.ts';
import { allows, type Permission } from '../identity/roles.ts';
import type { ScopedDb, WorkspaceContext } from '../identity/workspace-context.ts';
import { ConnectionUnavailable, type ConnectionRepository } from '../integrations/connections.ts';
import { GitHubAppUnavailable, type GitHubAppRepository } from '../integrations/github-app.ts';
import { GitHubError, type GitHubClient, type RepositoryChoice } from '../integrations/github.ts';
import {
   listRepositoriesAcrossAccounts,
   type AttributedRepository,
} from '../integrations/github-repositories.ts';
import {
   GitHubUserUnavailable,
   toGrantedRepository,
   type GitHubUserAccess,
   type GrantedRepository,
} from '../integrations/github-user.ts';
import {
   MAX_REPOSITORY_DESCRIPTION,
   RepositoryConflict,
   normaliseRepositoryUrl,
   writeWorkspaceEvent,
   type GitHubSettingsPatch,
   type GitHubSettingsRepository,
} from '../scm/github-settings.ts';
import type { PullRequestStore } from '../scm/pull-requests.ts';
import { mountWorkspaceScope, pathId, type ScopedVariables } from './shared.ts';

/**
 * `/api/v1/github/:workspaceId/*` — the workspace's GitHub settings, its
 * repositories, the import picker, and the pull requests linked to an issue.
 *
 * Every route sits behind `mountWorkspaceScope`: a non-member gets the same
 * 404 as a workspace that does not exist, and every query runs against the
 * confirmed scope rather than the path's lookup key. Reading is membership;
 * changing anything is `settings.write`, which only owners and admins hold.
 *
 * No response carries a credential. The installation token the picker lists
 * with is minted, used and dropped inside one request.
 */

export interface GitHubMountOptions {
   sessions: SessionService;
   sql: Sql;
   settings: GitHubSettingsRepository;
   pullRequests: Pick<PullRequestStore, 'listForIssue'>;
   githubApp: GitHubAppRepository | null;
   connections: ConnectionRepository | null;
   /**
    * What a signed-in person granted, read with their own token.
    *
    * The only listing available on a deployment with no App private key: an
    * installation token cannot be minted there, so `/installation/repositories`
    * is closed and the recorded grant is the whole answer. Null on a deployment
    * that cannot open a stored token at all, which the routes report rather than
    * answering with an empty list.
    */
   userAccess?: GitHubUserAccess | null;
   /** The client the picker lists with; overridden in tests. */
   client?: (token: string) => Pick<GitHubClient, 'listRepositories'>;
}

type GitHubContext = Context<{ Variables: ScopedVariables }>;

const PICKER_PAGE = 30;
const PICKER_MAX_PAGE = 100;
/** Up to a thousand repositories, which is where a person stops scrolling and types. */
const PICKER_GITHUB_PAGES = 10;

const repositoriesBody = z
   .array(
      z
         .object({
            url: z.string(),
            description: z.string().max(MAX_REPOSITORY_DESCRIPTION).optional(),
            githubRepoId: z.number().int().positive().nullable().optional(),
         })
         .strict()
   )
   .min(1)
   .max(50);

/**
 * A scoped write whose refusals are a 404 or a 403, not a 500.
 *
 * `ScopedDb.mutate` refuses with the identity layer's `NotFound` (a named
 * resource that is absent or another workspace's, whatever the caller's role)
 * and `Forbidden` (a role that lacks the permission, on a resource it can
 * see), which the app shell does not know how to answer. Only those are
 * translated: the handlers' own ApiErrors (an unknown installation, say) keep
 * their status.
 */
function mutateScoped<T>(
   db: ScopedDb,
   required: Permission,
   work: (tx: Queryable, ctx: WorkspaceContext) => Promise<T>,
   resource?: { table: string; id: string; name: string }
): Promise<T> {
   return db.mutate(required, work, resource).catch((error: unknown) => {
      if (error instanceof Forbidden) throw toApiError(error, 'Workspace');
      if (error instanceof NotFound && resource) throw toApiError(error, resource.name);
      throw error;
   });
}

export function githubMounts(options: GitHubMountOptions): Mount[] {
   const route = new Hono<{ Variables: ScopedVariables }>();
   mountWorkspaceScope(route, { sessions: options.sessions, sql: options.sql });

   route.get('/:workspaceId/settings', async (context) => {
      const db = context.get('scoped');
      const workspaceId = db.ctx.workspaceId;
      return json({
         settings: await options.settings.get(workspaceId),
         // Said by the server so the page never has to guess from a role name
         // what a role may do.
         canManage: allows(db.ctx.role, 'settings.write'),
         connection: await connectionOf(context, options),
      });
   });

   route.patch('/:workspaceId/settings', async (context) => {
      const db = context.get('scoped');
      const userId = context.get('user').id;
      const { value } = await decodeBody<GitHubSettingsPatch>(context, {
         enabled: 'boolean',
         showLinkedPullRequests: 'boolean',
         coAuthorTrailer: 'boolean',
         autoLinkPullRequests: 'boolean',
      });
      if (Object.keys(value).length === 0) {
         assertValid([fieldError('/', 'required', 'Name at least one setting to change.')]);
      }
      const settings = await mutateScoped(db, 'settings.write', (tx, ctx) =>
         options.settings.update(ctx.workspaceId, value, userId, tx)
      );
      return json({ settings });
   });

   /**
    * Disconnects the App from this workspace.
    *
    * The App stays installed on GitHub — removing it there is the account
    * owner's act — but this workspace stops minting tokens against it, and
    * the next install can point it somewhere else.
    */
   route.delete('/:workspaceId/installation', async (context) => {
      const db = context.get('scoped');
      await mutateScoped(db, 'settings.write', async (tx, ctx) => {
         const rows = await tx`
            DELETE FROM github_installations WHERE workspace_id = ${ctx.workspaceId}
            RETURNING installation_id`;
         if (rows.length === 0) throw ApiError.notFound('Installation');
         await writeWorkspaceEvent(tx, {
            workspaceId: ctx.workspaceId,
            type: 'github.connection.updated',
            aggregateType: 'github_installation',
            aggregateId: ctx.workspaceId,
            payload: { installed: false },
         });
      });
      return new Response(null, { status: 204 });
   });

   /**
    * The accounts this workspace reaches, and what each one would cost to lose.
    *
    * Admin-only, like the picker: answering it mints a token against every
    * installation to ask GitHub how many repositories it was granted, and only
    * an admin can act on the answer anyway.
    *
    * `listedHere` is the count of this workspace's own repositories that live
    * under the account — the sentence a Disconnect dialog needs, because
    * "disconnect acme" reads as harmless until it says which four repositories
    * the agents here stop reaching.
    */
   route.get('/:workspaceId/accounts', async (context) => {
      const db = context.get('scoped');
      if (!allows(db.ctx.role, 'settings.write')) {
         throw new ApiError(403, 'FORBIDDEN', 'Only an admin can manage connected accounts.');
      }
      const workspaceId = db.ctx.workspaceId;
      if (!options.githubApp) return json({ accounts: [], installPending: false });
      const accounts = await options.githubApp.connectedAccounts(workspaceId);
      const listed = await options.settings.listRepositories(workspaceId);
      return json({
         accounts: accounts.map((account) => ({
            installationId: account.installationId,
            accountLogin: account.accountLogin,
            accountType: account.accountType,
            repositoryCount: account.repositoryCount,
            listedHere: listed.filter(
               (repository) =>
                  repositoryOwner(repository.url) === (account.accountLogin ?? '').toLowerCase()
            ).length,
            installedAt: account.installedAt,
            installedBy: account.installedBy,
         })),
         // An install an owner has still to approve has no account to list, so
         // it is said beside the list rather than in it.
         installPending: await options.githubApp.installPending(workspaceId),
      });
   });

   /**
    * Disconnects one account, leaving the others.
    *
    * The App stays installed on GitHub — removing it there is the account
    * owner's act — but this workspace stops minting tokens against this
    * installation. A 404 for an installation that is not this workspace's, and
    * the same 404 for one that does not exist: an installation belongs to
    * exactly one workspace, and which ids exist elsewhere is not this
    * workspace's business.
    */
   route.delete('/:workspaceId/accounts/:installationId', async (context) => {
      const db = context.get('scoped');
      const installationId = Number(context.req.param('installationId'));
      if (!Number.isSafeInteger(installationId) || installationId <= 0) {
         throw ApiError.notFound('Installation');
      }
      await mutateScoped(db, 'settings.write', async (tx, ctx) => {
         const rows = await tx`
            DELETE FROM github_installations
             WHERE workspace_id = ${ctx.workspaceId} AND installation_id = ${installationId}
            RETURNING installation_id, account_login`;
         if (rows.length === 0) throw ApiError.notFound('Installation');
         await writeWorkspaceEvent(tx, {
            workspaceId: ctx.workspaceId,
            type: 'github.connection.updated',
            aggregateType: 'github_installation',
            aggregateId: ctx.workspaceId,
            payload: {
               installed: false,
               installationId,
               accountLogin: rows[0]!.account_login ?? null,
            },
         });
      });
      // The cache is keyed by installation, so the token this workspace was
      // holding for it goes with the row rather than living out its hour.
      options.githubApp?.forgetToken(installationId);
      return new Response(null, { status: 204 });
   });

   route.get('/:workspaceId/repositories', async (context) => {
      const db = context.get('scoped');
      return json({ repositories: await options.settings.listRepositories(db.ctx.workspaceId) });
   });

   route.post('/:workspaceId/repositories', async (context) => {
      const db = context.get('scoped');
      const userId = context.get('user').id;
      const { value } = await decodeBody<{ repositories?: unknown }>(context, { repositories: 'raw' });
      const parsed = repositoriesBody.safeParse(value.repositories);
      if (!parsed.success) {
         assertValid(
            parsed.error.issues.map((issue) =>
               fieldError(`/repositories/${issue.path.join('/')}`.replace(/\/$/, ''), 'invalid_value', issue.message)
            )
         );
         return json({ repositories: [] });
      }
      const problems: FieldError[] = [];
      const items = parsed.data.map((item, index) => {
         const url = normaliseRepositoryUrl(item.url);
         if (!url) problems.push(invalidUrl(`/repositories/${index}/url`));
         return {
            url: url ?? '',
            description: (item.description ?? '').trim(),
            githubRepoId: item.githubRepoId ?? null,
         };
      });
      assertValid(problems);
      const added = await mutateScoped(db, 'settings.write', (tx, ctx) =>
         options.settings.addRepositories(ctx.workspaceId, items, userId, tx)
      );
      return json({ repositories: added }, 201);
   });

   route.patch('/:workspaceId/repositories/:repositoryId', async (context) => {
      const db = context.get('scoped');
      const repositoryId = pathId(context.req.param('repositoryId'), 'Repository');
      const { value } = await decodeBody<{ url?: string; description?: string }>(context, {
         url: 'string',
         description: 'string',
      });
      const problems: FieldError[] = [];
      const url = value.url === undefined ? undefined : normaliseRepositoryUrl(value.url);
      if (url === null) problems.push(invalidUrl('/url'));
      const description = value.description?.trim();
      if (description !== undefined && description.length > MAX_REPOSITORY_DESCRIPTION) {
         problems.push(
            fieldError('/description', 'too_long', `At most ${MAX_REPOSITORY_DESCRIPTION} characters.`)
         );
      }
      if (value.url === undefined && value.description === undefined) {
         problems.push(fieldError('/', 'required', 'Name a field to change.'));
      }
      assertValid(problems);

      const updated = await mutateScoped(db, 'settings.write', async (tx, ctx) => {
         try {
            return await options.settings.updateRepository(
               ctx.workspaceId,
               repositoryId,
               {
                  ...(url ? { url } : {}),
                  ...(description !== undefined ? { description } : {}),
               },
               tx
            );
         } catch (error) {
            if (error instanceof RepositoryConflict) {
               throw new ApiError(409, 'CONFLICT', 'This workspace already lists that URL.');
            }
            throw error;
         }
      }, { table: 'workspace_repositories', id: repositoryId, name: 'Repository' });
      if (!updated) throw ApiError.notFound('Repository');
      return json({ repository: updated });
   });

   route.delete('/:workspaceId/repositories/:repositoryId', async (context) => {
      const db = context.get('scoped');
      const repositoryId = pathId(context.req.param('repositoryId'), 'Repository');
      const removed = await mutateScoped(
         db,
         'settings.write',
         (tx, ctx) => options.settings.removeRepository(ctx.workspaceId, repositoryId, tx),
         { table: 'workspace_repositories', id: repositoryId, name: 'Repository' }
      );
      if (!removed) throw ApiError.notFound('Repository');
      return new Response(null, { status: 204 });
   });

   /**
    * What GitHub granted this workspace, as recorded.
    *
    * A read of the table rather than a call to GitHub: on a deployment with no
    * App private key there is no credential to list with except a person's own
    * sign-in token, and a page must not depend on that person being here. Any
    * member may read it — knowing which repositories the workspace works in is
    * not an admin matter — and `canManage` says who may bring it up to date.
    *
    * `installPending` is the fourth state a list cannot express: an organisation
    * install an owner has still to approve grants nothing yet, and nobody here
    * need do anything but wait.
    */
   route.get('/:workspaceId/granted-repositories', async (context) => {
      const db = context.get('scoped');
      const rows = await db.list((q) => q.sql`
         SELECT repository_id, installation_id, full_name, private, default_branch,
                account_login, account_type, html_url, refreshed_at
           FROM github_granted_repositories
          WHERE ${q.scope}
          ORDER BY account_login, full_name`);
      const pending = await db.list((q) => q.sql`
         SELECT 1 AS waiting FROM github_install_offers
          WHERE ${q.scope} AND status = 'pending' LIMIT 1`);
      return json(
         grantedPayload(rows.map((row) => toGrantedRepository(row as never)), {
            installPending: pending.length > 0,
            canManage: allows(db.ctx.role, 'settings.write'),
         })
      );
   });

   /**
    * Asks GitHub again, for the person asking.
    *
    * Needed because what the App may see is changed on GitHub, not here: someone
    * who adds a repository to the installation has no way to tell Berry but this.
    * It runs on the caller's own sign-in token — the only credential that can
    * answer `/user/installations` — so a revoked one is reported as "sign in
    * again" rather than as a workspace that was granted nothing.
    */
   route.post('/:workspaceId/granted-repositories/refresh', async (context) => {
      const db = context.get('scoped');
      if (!allows(db.ctx.role, 'settings.write')) {
         throw new ApiError(403, 'FORBIDDEN', 'Only an admin can refresh repository access.');
      }
      if (!options.userAccess) {
         throw new ApiError(
            503,
            'INTEGRATIONS_NOT_CONFIGURED',
            'This deployment cannot open a stored sign-in token, so it cannot ask GitHub what was granted.'
         );
      }
      let summary: Awaited<ReturnType<GitHubUserAccess['refresh']>>;
      try {
         summary = await options.userAccess.refresh({
            workspaceId: db.ctx.workspaceId,
            userId: db.ctx.userId,
         });
      } catch (error) {
         throw asGrantFailure(error);
      }
      const pending = await db.list((q) => q.sql`
         SELECT 1 AS waiting FROM github_install_offers
          WHERE ${q.scope} AND status = 'pending' LIMIT 1`);
      return json({
         ...grantedPayload(summary.repositories, {
            installPending: pending.length > 0,
            canManage: true,
         }),
         // An account whose installation belongs to another workspace: named,
         // because "your organisation's repositories are missing" is otherwise
         // indistinguishable from GitHub having granted none.
         claimedElsewhere: summary.installations
            .filter((installation) => installation.claimedElsewhere)
            .map((installation) => installation.accountLogin),
      });
   });

   /**
    * The import picker: what the installation can see, filtered and paged.
    *
    * Admin-only, because it names every repository the installation reaches,
    * and only an admin can import one anyway. Archived and already-listed
    * repositories are returned marked rather than hidden, so the picker can
    * say why they cannot be chosen.
    */
   route.get('/:workspaceId/github-repositories', async (context) => {
      const db = context.get('scoped');
      if (!allows(db.ctx.role, 'settings.write')) {
         throw new ApiError(403, 'FORBIDDEN', 'Only an admin can import repositories.');
      }
      const workspaceId = db.ctx.workspaceId;
      const account = (context.req.query('account') ?? '').trim();
      const query = (context.req.query('q') ?? '').trim().toLowerCase();
      const offset = parseOffset(context.req.query('cursor'));
      const limit = parseLimit(context.req.query('limit'));

      const listed = await listForPicker(workspaceId, options);
      const existing = await options.settings.listRepositories(workspaceId);
      const addedIds = new Set(existing.map((row) => row.githubRepoId).filter((id) => id !== null));
      const addedUrls = new Set(existing.map((row) => row.url.toLowerCase()));

      const accounts = [...new Set(listed.map(accountOf))].sort((a, b) => a.localeCompare(b));
      // A search reaches every account; naming one narrows to it. Both are
      // matched on the account the installation is on rather than on the
      // repository's owner, so the two never disagree for an account that has
      // since been renamed on GitHub.
      const matching = listed.filter(
         (repository) =>
            (account === '' || accountOf(repository).toLowerCase() === account.toLowerCase()) &&
            (query === '' ||
               repository.fullName.toLowerCase().includes(query) ||
               (repository.description ?? '').toLowerCase().includes(query))
      );
      // Grouped by account, so the picker's sections come out of the order
      // rather than out of a second pass in the browser.
      matching.sort(
         (a, b) =>
            accountOf(a).localeCompare(accountOf(b)) || a.fullName.localeCompare(b.fullName)
      );
      const page = matching.slice(offset, offset + limit).map((repository) => {
         const url = repository.htmlUrl ?? `https://github.com/${repository.fullName}`;
         return {
            id: repository.id,
            fullName: repository.fullName,
            owner: ownerOf(repository),
            account: accountOf(repository),
            installationId: repository.installationId,
            name: repository.name,
            description: repository.description ?? null,
            private: repository.private,
            archived: repository.archived === true,
            url,
            alreadyAdded:
               addedIds.has(repository.id) ||
               addedUrls.has(url.toLowerCase()) ||
               (repository.sshUrl !== undefined && addedUrls.has(repository.sshUrl.toLowerCase())),
         };
      });
      return json({
         accounts,
         repositories: page,
         total: matching.length,
         nextCursor: offset + limit < matching.length ? String(offset + limit) : null,
      });
   });

   route.get('/:workspaceId/issues/:issueRef/pull-requests', async (context) => {
      const db = context.get('scoped');
      const workspaceId = db.ctx.workspaceId;
      const issueRef = context.req.param('issueRef') ?? '';
      const settings = await options.settings.get(workspaceId);
      const pullRequests = await options.pullRequests.listForIssue(workspaceId, issueRef);
      if (pullRequests === null) throw ApiError.notFound('Issue');
      const visible = settings.enabled && settings.showLinkedPullRequests;
      // Hidden means not sent: a switched-off panel should not still ship the
      // data to every issue page.
      return json({ visible, pullRequests: visible ? pullRequests : [] });
   });

   return [{ prefix: '/api/v1/github', handler: route }];
}

function invalidUrl(path: string): FieldError {
   return fieldError(path, 'invalid_url', 'Use an https:// or ssh address (git@host:owner/repo).');
}

function ownerOf(repository: RepositoryChoice): string {
   return repository.owner ?? repository.fullName.split('/')[0] ?? '';
}

/**
 * The account a stored repository URL lives under, lowercased.
 *
 * Both address forms a workspace can hold are read: `https://host/owner/repo`
 * and `git@host:owner/repo.git`. An address that matches neither belongs to no
 * account, which is the honest answer — it is a repository no installation
 * accounts for.
 */
function repositoryOwner(url: string): string {
   const ssh = /^[^@]+@[^:]+:([^/]+)\//.exec(url.trim());
   if (ssh) return ssh[1]!.toLowerCase();
   try {
      const path = new URL(url.trim()).pathname.replace(/^\/+/, '');
      return (path.split('/')[0] ?? '').toLowerCase();
   } catch {
      return '';
   }
}

/** Which connected account a repository was listed under. */
function accountOf(repository: AttributedRepository): string {
   return repository.accountLogin || ownerOf(repository);
}

function parseOffset(raw: string | undefined): number {
   if (!raw) return 0;
   if (!/^\d{1,6}$/.test(raw)) throw ApiError.badRequest('cursor is not one this server issued.');
   return Number(raw);
}

function parseLimit(raw: string | undefined): number {
   if (!raw) return PICKER_PAGE;
   const value = Number(raw);
   if (!Number.isInteger(value) || value < 1 || value > PICKER_MAX_PAGE) {
      throw ApiError.badRequest(`limit must be between 1 and ${PICKER_MAX_PAGE}.`);
   }
   return value;
}

/**
 * Who connected the App here and when, without anything that could
 * authenticate.
 *
 * `accounts` is the whole answer now that a workspace can reach several; the
 * flat `accountLogin` and friends describe the first of them and stay for the
 * surfaces that only ever wanted "is GitHub connected, and to whom".
 */
async function connectionOf(context: GitHubContext, options: GitHubMountOptions) {
   const db = context.get('scoped');
   const app = options.githubApp ? await options.githubApp.app() : null;
   const rows = await db.list((q) => q.sql`
      SELECT installation.installation_id, installation.account_login, installation.account_type,
             installation.created_at, installer.id AS installer_id, installer.name AS installer_name
        FROM github_installations AS installation
        LEFT JOIN users AS installer ON installer.id = installation.installed_by
       WHERE ${q.scope}
       ORDER BY installation.created_at, installation.installation_id`);
   const accounts = rows.map((row) => ({
      installationId: Number(row.installation_id),
      accountLogin: (row.account_login as string | null) ?? null,
      accountType: (row.account_type as string | null) ?? null,
      installedAt: toRFC3339(row.created_at as string),
      installedBy: row.installer_id
         ? { id: row.installer_id as string, name: (row.installer_name as string | null) ?? null }
         : null,
   }));
   const first = accounts[0];
   return {
      appConfigured: app !== null,
      appName: app?.name ?? null,
      appUrl: app?.htmlUrl ?? null,
      installed: accounts.length > 0,
      accounts,
      accountLogin: first?.accountLogin ?? null,
      accountType: first?.accountType ?? null,
      installedAt: first?.installedAt ?? null,
      installedBy: first?.installedBy ?? null,
   };
}

/**
 * Every repository the workspace can reach, with the failures mapped once.
 *
 * The merging across accounts lives in the integrations layer, because the
 * project link's picker asks the same question and a repository visible in one
 * picker and missing from the other is exactly the disagreement two copies of
 * it produce.
 */
async function listForPicker(
   workspaceId: string,
   options: GitHubMountOptions
): Promise<AttributedRepository[]> {
   // What a member's own sign-in token already told Berry. It is the whole
   // answer on a deployment that cannot mint an installation token, and the
   // fallback everywhere else — so the picker and the settings page name the
   // same repositories rather than disagreeing by credential.
   const recorded = async (): Promise<AttributedRepository[]> =>
      options.userAccess
         ? (await options.userAccess.granted(workspaceId)).map(asPickerChoice)
         : [];

   if (!options.githubApp && !options.connections) {
      const fallback = await recorded();
      if (fallback.length > 0) return fallback;
      throw new ApiError(
         503,
         'INTEGRATIONS_NOT_CONFIGURED',
         'This deployment has no encryption key, so it cannot hold a credential.'
      );
   }
   try {
      const listing = await listRepositoriesAcrossAccounts(workspaceId, {
         githubApp: options.githubApp,
         connections: options.connections,
         ...(options.client ? { client: options.client } : {}),
         maxPages: PICKER_GITHUB_PAGES,
      });
      // A live listing wins when there is one: it is newer than the record. An
      // empty one falls back rather than being believed, because "no
      // repositories" from a credential that cannot see any is not an answer.
      if (listing.repositories.length > 0) return listing.repositories;
      const fallback = await recorded();
      return fallback.length > 0 ? fallback : listing.repositories;
   } catch (error) {
      const fallback = await recorded();
      if (fallback.length > 0) return fallback;
      throw asPickerFailure(error);
   }
}

/**
 * The granted list as every caller reads it: the repositories, and the accounts
 * they came from with their counts.
 *
 * The grouping is computed here rather than in a browser so both the settings
 * page and the refresh answer say the same thing, and `refreshedAt` is the
 * oldest row's — the honest age of a cache is the age of its stalest part.
 */
function grantedPayload(
   repositories: GrantedRepository[],
   state: { installPending: boolean; canManage: boolean }
) {
   const accounts = new Map<
      string,
      { accountLogin: string | null; accountType: string | null; installationId: number; repositories: number }
   >();
   for (const repository of repositories) {
      const key = (repository.accountLogin ?? '').toLowerCase();
      const existing = accounts.get(key);
      if (existing) existing.repositories += 1;
      else {
         accounts.set(key, {
            accountLogin: repository.accountLogin,
            accountType: repository.accountType,
            installationId: repository.installationId,
            repositories: 1,
         });
      }
   }
   const refreshed = repositories.map((repository) => repository.refreshedAt).sort();
   return {
      repositories: repositories.map((repository) => ({
         id: repository.repositoryId,
         fullName: repository.fullName,
         owner: repository.owner,
         accountLogin: repository.accountLogin,
         accountType: repository.accountType,
         installationId: repository.installationId,
         private: repository.private,
         defaultBranch: repository.defaultBranch,
         url: repository.htmlUrl,
         refreshedAt: repository.refreshedAt,
      })),
      accounts: [...accounts.values()],
      installPending: state.installPending,
      canManage: state.canManage,
      refreshedAt: refreshed[0] ?? null,
   };
}

/**
 * The three things that can go wrong reading a person's grants, each said as the
 * thing to do about it. None of them is an empty list.
 */
function asGrantFailure(error: unknown): unknown {
   if (error instanceof GitHubUserUnavailable) {
      if (error.reason === 'not_linked') {
         return new ApiError(
            409,
            'GITHUB_NOT_LINKED',
            'This account has no GitHub sign-in linked, so Berry cannot ask GitHub what it was granted.'
         );
      }
      if (error.reason === 'sign_in_again') {
         return new ApiError(
            409,
            'GITHUB_SIGN_IN_AGAIN',
            'GitHub no longer accepts your stored sign-in. Sign in again to refresh repository access.'
         );
      }
      return new ApiError(502, 'PROVIDER_ERROR', 'GitHub did not answer. Try again in a moment.');
   }
   return error;
}

/** A recorded grant, as the picker's own shape. */
function asPickerChoice(repository: GrantedRepository): AttributedRepository {
   return {
      id: repository.repositoryId,
      fullName: repository.fullName,
      name: repository.fullName.split('/')[1] ?? repository.fullName,
      private: repository.private,
      defaultBranch: repository.defaultBranch ?? 'main',
      owner: repository.owner,
      htmlUrl: repository.htmlUrl,
      installationId: repository.installationId,
      accountLogin: repository.accountLogin ?? repository.owner,
   };
}

/** The one wording for every way a listing can fail to happen. */
function asPickerFailure(error: unknown): unknown {
   if (error instanceof GitHubAppUnavailable) {
      return new ApiError(
         409,
         error.reason === 'not_installed' ? 'NOT_CONNECTED' : 'CONNECTION_UNUSABLE',
         error.reason === 'not_installed'
            ? 'The GitHub App is not installed for this workspace.'
            : `The GitHub App needs attention: ${error.message}.`
      );
   }
   if (error instanceof ConnectionUnavailable) {
      return new ApiError(
         409,
         error.reason === 'missing' ? 'NOT_CONNECTED' : 'CONNECTION_UNUSABLE',
         error.reason === 'missing'
            ? 'GitHub is not connected to this workspace.'
            : `The GitHub connection needs attention: ${error.message}.`
      );
   }
   if (error instanceof GitHubError) {
      return new ApiError(502, 'PROVIDER_ERROR', `GitHub refused the request: ${error.message}`);
   }
   return error;
}
