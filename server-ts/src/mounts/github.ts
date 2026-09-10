import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { SessionService } from '../auth/sessions.ts';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { assertValid, decodeBody, fieldError } from '../http/body.ts';
import { ApiError, type FieldError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { allows } from '../identity/roles.ts';
import { ConnectionUnavailable, type ConnectionRepository } from '../integrations/connections.ts';
import { GitHubAppUnavailable, type GitHubAppRepository } from '../integrations/github-app.ts';
import { GitHubClient, GitHubError, type RepositoryChoice } from '../integrations/github.ts';
import {
   MAX_REPOSITORY_DESCRIPTION,
   RepositoryConflict,
   normaliseRepositoryUrl,
   writeWorkspaceEvent,
   type GitHubSettingsPatch,
   type GitHubSettingsRepository,
} from '../scm/github-settings.ts';
import type { PullRequestStore } from '../scm/pull-requests.ts';
import { githubCredential } from './integrations.ts';
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
      const settings = await db.mutate('settings.write', (tx, ctx) =>
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
      await db.mutate('settings.write', async (tx, ctx) => {
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
      const added = await db.mutate('settings.write', (tx, ctx) =>
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

      const updated = await db.mutate('settings.write', async (tx, ctx) => {
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
      });
      if (!updated) throw ApiError.notFound('Repository');
      return json({ repository: updated });
   });

   route.delete('/:workspaceId/repositories/:repositoryId', async (context) => {
      const db = context.get('scoped');
      const repositoryId = pathId(context.req.param('repositoryId'), 'Repository');
      const removed = await db.mutate('settings.write', (tx, ctx) =>
         options.settings.removeRepository(ctx.workspaceId, repositoryId, tx)
      );
      if (!removed) throw ApiError.notFound('Repository');
      return new Response(null, { status: 204 });
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

      const accounts = [...new Set(listed.map(ownerOf))].sort((a, b) => a.localeCompare(b));
      const matching = listed.filter(
         (repository) =>
            (account === '' || ownerOf(repository).toLowerCase() === account.toLowerCase()) &&
            (query === '' ||
               repository.fullName.toLowerCase().includes(query) ||
               (repository.description ?? '').toLowerCase().includes(query))
      );
      const page = matching.slice(offset, offset + limit).map((repository) => {
         const url = repository.htmlUrl ?? `https://github.com/${repository.fullName}`;
         return {
            id: repository.id,
            fullName: repository.fullName,
            owner: ownerOf(repository),
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

/** Who connected the App here and when, without anything that could authenticate. */
async function connectionOf(context: GitHubContext, options: GitHubMountOptions) {
   const db = context.get('scoped');
   const app = options.githubApp ? await options.githubApp.app() : null;
   const [row] = await db.list((q) => q.sql`
      SELECT installation.installation_id, installation.account_login, installation.account_type,
             installation.created_at, installer.id AS installer_id, installer.name AS installer_name
        FROM github_installations AS installation
        LEFT JOIN users AS installer ON installer.id = installation.installed_by
       WHERE ${q.scope}`);
   return {
      appConfigured: app !== null,
      appName: app?.name ?? null,
      appUrl: app?.htmlUrl ?? null,
      installed: row !== undefined,
      accountLogin: (row?.account_login as string | null | undefined) ?? null,
      accountType: (row?.account_type as string | null | undefined) ?? null,
      installedAt: row ? toRFC3339(row.created_at as string) : null,
      installedBy:
         row && row.installer_id
            ? { id: row.installer_id as string, name: (row.installer_name as string | null) ?? null }
            : null,
   };
}

/** Every repository the workspace's credential reaches, with the failures mapped once. */
async function listForPicker(
   workspaceId: string,
   options: GitHubMountOptions
): Promise<RepositoryChoice[]> {
   if (!options.githubApp && !options.connections) {
      throw new ApiError(
         503,
         'INTEGRATIONS_NOT_CONFIGURED',
         'This deployment has no encryption key, so it cannot hold a credential.'
      );
   }
   let credential: { token: string; kind: 'installation' | 'user' };
   try {
      credential = await githubCredential(workspaceId, options);
   } catch (error) {
      if (error instanceof GitHubAppUnavailable) {
         throw new ApiError(
            409,
            error.reason === 'not_installed' ? 'NOT_CONNECTED' : 'CONNECTION_UNUSABLE',
            error.reason === 'not_installed'
               ? 'The GitHub App is not installed for this workspace.'
               : `The GitHub App needs attention: ${error.message}.`
         );
      }
      if (error instanceof ConnectionUnavailable) {
         throw new ApiError(
            409,
            error.reason === 'missing' ? 'NOT_CONNECTED' : 'CONNECTION_UNUSABLE',
            error.reason === 'missing'
               ? 'GitHub is not connected to this workspace.'
               : `The GitHub connection needs attention: ${error.message}.`
         );
      }
      throw error;
   }
   const client = options.client
      ? options.client(credential.token)
      : new GitHubClient({ token: credential.token });
   try {
      return await client.listRepositories({
         credential: credential.kind,
         maxPages: PICKER_GITHUB_PAGES,
      });
   } catch (error) {
      if (error instanceof GitHubError) {
         throw new ApiError(502, 'PROVIDER_ERROR', `GitHub refused the request: ${error.message}`);
      }
      throw error;
   }
}
