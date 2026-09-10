import { z } from 'zod';
import { BerryApiError, apiFetch } from './api';

/**
 * The workspace's GitHub settings, its repositories, the import picker and the
 * pull requests linked to an issue — `/api/v1/github/:workspaceId/*`.
 *
 * Nothing here ever carries a credential: the server lists repositories with
 * an installation token it mints and drops inside the request.
 */

export const githubSettingsSchema = z.object({
   enabled: z.boolean(),
   showLinkedPullRequests: z.boolean(),
   coAuthorTrailer: z.boolean(),
   autoLinkPullRequests: z.boolean(),
   updatedAt: z.string().nullish(),
});

export const githubConnectionSchema = z.object({
   appConfigured: z.boolean(),
   appName: z.string().nullish(),
   appUrl: z.string().nullish(),
   installed: z.boolean(),
   accountLogin: z.string().nullish(),
   accountType: z.string().nullish(),
   installedAt: z.string().nullish(),
   installedBy: z.object({ id: z.string(), name: z.string().nullish() }).nullish(),
});

const settingsResponseSchema = z.object({
   settings: githubSettingsSchema,
   canManage: z.boolean(),
   connection: githubConnectionSchema,
});

export const workspaceRepositorySchema = z.object({
   id: z.string(),
   url: z.string(),
   description: z.string(),
   githubRepoId: z.number().nullish(),
   position: z.number(),
   createdAt: z.string(),
   updatedAt: z.string(),
});

export const pickerRepositorySchema = z.object({
   id: z.number(),
   fullName: z.string(),
   owner: z.string(),
   name: z.string(),
   description: z.string().nullish(),
   private: z.boolean(),
   archived: z.boolean(),
   url: z.string(),
   alreadyAdded: z.boolean(),
});

const pickerPageSchema = z.object({
   accounts: z.array(z.string()),
   repositories: z.array(pickerRepositorySchema),
   total: z.number(),
   nextCursor: z.string().nullish(),
});

export const checkItemSchema = z.object({
   kind: z.enum(['run', 'suite']),
   name: z.string(),
   status: z.string(),
   conclusion: z.string().nullish(),
   url: z.string().nullish(),
});

export const linkedPullRequestSchema = z.object({
   id: z.string(),
   number: z.number(),
   title: z.string(),
   url: z.string(),
   repoFullName: z.string(),
   state: z.enum(['open', 'draft', 'merged', 'closed']),
   draft: z.boolean(),
   headRef: z.string(),
   authorLogin: z.string().nullish(),
   mergedAt: z.string().nullish(),
   closeIntent: z.boolean(),
   checks: z.object({
      rollup: z.enum(['success', 'failure', 'pending', 'neutral', 'none']),
      total: z.number(),
      passed: z.number(),
      failed: z.number(),
      pending: z.number(),
      items: z.array(checkItemSchema),
   }),
   updatedAt: z.string(),
});

export type GitHubSettings = z.infer<typeof githubSettingsSchema>;
export type GitHubSettingsPatch = Partial<Omit<GitHubSettings, 'updatedAt'>>;
export type GitHubConnection = z.infer<typeof githubConnectionSchema>;
export type GitHubSettingsState = z.infer<typeof settingsResponseSchema>;
export type WorkspaceRepository = z.infer<typeof workspaceRepositorySchema>;
export type PickerRepository = z.infer<typeof pickerRepositorySchema>;
export type PickerPage = z.infer<typeof pickerPageSchema>;
export type LinkedPullRequest = z.infer<typeof linkedPullRequestSchema>;

/** Realtime topics the GitHub surfaces listen for. */
export const GITHUB_EVENTS = {
   settings: 'github.settings.updated',
   repositories: 'github.repositories.updated',
   connection: 'github.connection.updated',
   pullRequest: 'github.pull_request.updated',
} as const;

function base(workspaceId: string): string {
   return `/api/v1/github/${encodeURIComponent(workspaceId)}`;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
   const parsed = schema.safeParse(value);
   if (!parsed.success) throw new Error(`${what} was not recognized`);
   return parsed.data;
}

export async function loadGitHubSettings(workspaceId: string): Promise<GitHubSettingsState> {
   const json: unknown = await apiFetch(`${base(workspaceId)}/settings`);
   return parse(settingsResponseSchema, json, 'GitHub settings');
}

export async function updateGitHubSettings(
   workspaceId: string,
   patch: GitHubSettingsPatch
): Promise<GitHubSettings> {
   const json: unknown = await apiFetch(`${base(workspaceId)}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
   });
   return parse(z.object({ settings: githubSettingsSchema }), json, 'GitHub settings').settings;
}

/** Stops this workspace using the App; the App stays installed on GitHub. */
export async function disconnectGitHub(workspaceId: string): Promise<void> {
   await apiFetch(`${base(workspaceId)}/installation`, { method: 'DELETE' });
}

export async function listWorkspaceRepositories(workspaceId: string): Promise<WorkspaceRepository[]> {
   const json: unknown = await apiFetch(`${base(workspaceId)}/repositories`);
   return parse(
      z.object({ repositories: z.array(workspaceRepositorySchema) }),
      json,
      'Repository list'
   ).repositories;
}

export async function addWorkspaceRepositories(
   workspaceId: string,
   repositories: Array<{ url: string; description?: string; githubRepoId?: number | null }>
): Promise<WorkspaceRepository[]> {
   const json: unknown = await apiFetch(`${base(workspaceId)}/repositories`, {
      method: 'POST',
      body: JSON.stringify({ repositories }),
   });
   return parse(
      z.object({ repositories: z.array(workspaceRepositorySchema) }),
      json,
      'Added repositories'
   ).repositories;
}

export async function updateWorkspaceRepository(
   workspaceId: string,
   repositoryId: string,
   patch: { url?: string; description?: string }
): Promise<WorkspaceRepository> {
   const json: unknown = await apiFetch(
      `${base(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) }
   );
   return parse(z.object({ repository: workspaceRepositorySchema }), json, 'Repository').repository;
}

export async function removeWorkspaceRepository(
   workspaceId: string,
   repositoryId: string
): Promise<void> {
   await apiFetch(`${base(workspaceId)}/repositories/${encodeURIComponent(repositoryId)}`, {
      method: 'DELETE',
   });
}

export async function loadGitHubRepositories(
   workspaceId: string,
   query: { account?: string; q?: string; cursor?: string | null; limit?: number } = {}
): Promise<PickerPage> {
   const params = new URLSearchParams();
   if (query.account) params.set('account', query.account);
   if (query.q) params.set('q', query.q);
   if (query.cursor) params.set('cursor', query.cursor);
   if (query.limit) params.set('limit', String(query.limit));
   const suffix = params.toString();
   const json: unknown = await apiFetch(
      `${base(workspaceId)}/github-repositories${suffix ? `?${suffix}` : ''}`
   );
   return parse(pickerPageSchema, json, 'GitHub repository list');
}

export async function loadIssuePullRequests(
   workspaceId: string,
   issueRef: string
): Promise<{ visible: boolean; pullRequests: LinkedPullRequest[] }> {
   const json: unknown = await apiFetch(
      `${base(workspaceId)}/issues/${encodeURIComponent(issueRef)}/pull-requests`
   );
   return parse(
      z.object({ visible: z.boolean(), pullRequests: z.array(linkedPullRequestSchema) }),
      json,
      'Linked pull requests'
   );
}

/**
 * Whether a string is an address the server will accept, so a row can say so
 * before it is saved. The server checks again; this only saves a round trip.
 */
export function isRepositoryUrl(raw: string): boolean {
   const value = raw.trim().replace(/\/+$/, '');
   if (value === '' || value.length > 500 || /\s/.test(value)) return false;
   return (
      /^https:\/\/[^/]+\/.+/.test(value) ||
      /^ssh:\/\/[^/]+\/.+/.test(value) ||
      /^git@[^:/]+:.+/.test(value)
   );
}

/** Human wording for a refused GitHub call. */
export function describeGitHubFailure(error: unknown): string {
   if (error instanceof BerryApiError) {
      switch (error.code) {
         case 'FORBIDDEN':
            return 'Only a workspace admin can change GitHub settings.';
         case 'NOT_CONNECTED':
            return 'Install the GitHub App for this workspace first.';
         case 'CONNECTION_UNUSABLE':
            return 'The GitHub App needs attention before it can list repositories.';
         case 'INTEGRATIONS_NOT_CONFIGURED':
            return 'This deployment cannot hold a GitHub credential.';
         case 'PROVIDER_ERROR':
            return 'GitHub did not answer. Try again in a moment.';
         case 'CONFLICT':
            return 'That repository is already in the list.';
         case 'VALIDATION_FAILED':
            return 'Use an https:// or ssh address, such as git@github.com:owner/repo.git.';
         default:
            return error.message;
      }
   }
   return 'The GitHub request failed.';
}
