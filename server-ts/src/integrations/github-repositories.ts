import { GitHubAppUnavailable, type GitHubAppRepository } from './github-app.ts';
import { GitHubClient, GitHubError, type RepositoryChoice } from './github.ts';
import type { ConnectionRepository } from './connections.ts';

/**
 * Everything a workspace can reach on GitHub, merged across its accounts.
 *
 * A workspace installs the App on a personal account and on one or more
 * organisations, and an installation sees only its own account's repositories.
 * Listing with one token would therefore show one account and silently hide the
 * rest — which is what made a second install look like it had done nothing.
 *
 * Each installation is listed with its own token and every repository carries
 * the account it came from. The attribution is not decoration: it is what lets
 * a picker group by account, and what tells a later mint which installation
 * actually owns the repository somebody picked.
 *
 * Shared by the two pickers (the repository directory's and the project link's)
 * because a repository visible in one and missing from the other is the kind of
 * disagreement two copies of this produce.
 */

/** A repository together with the connected account it was listed under. */
export interface AttributedRepository extends RepositoryChoice {
   /** Null on the older user-connection path, which has no installation. */
   installationId: number | null;
   accountLogin: string;
}

export interface RepositoryListing {
   repositories: AttributedRepository[];
   /** What listed them, which decides how an empty list should be read. */
   kind: 'installation' | 'user';
   /** The accounts that answered, in the order they were connected. */
   accounts: Array<{
      installationId: number | null;
      accountLogin: string;
      accountType: string | null;
   }>;
}

export interface RepositoryListingDeps {
   githubApp: GitHubAppRepository | null;
   connections: ConnectionRepository | null;
   /** The client each account is listed with; overridden in tests. */
   client?: (token: string) => Pick<GitHubClient, 'listRepositories'>;
   maxPages?: number;
}

function ownerOf(repository: RepositoryChoice): string {
   return repository.owner ?? repository.fullName.split('/')[0] ?? '';
}

export async function listRepositoriesAcrossAccounts(
   workspaceId: string,
   deps: RepositoryListingDeps
): Promise<RepositoryListing> {
   const build = (token: string) =>
      deps.client ? deps.client(token) : new GitHubClient({ token });

   const app = deps.githubApp ? await deps.githubApp.app() : null;
   if (deps.githubApp && app) {
      const installations = await deps.githubApp.installations(workspaceId);
      if (installations.length === 0) {
         throw new GitHubAppUnavailable(
            'the GitHub App is not installed for this workspace',
            'not_installed'
         );
      }
      const perAccount = await Promise.all(
         installations.map(async (installation) => {
            const account = installation.accountLogin;
            // One account GitHub refuses does not empty the picker: it is left
            // out and the others are returned, because a page that shows
            // nothing because of an organisation nobody was looking for teaches
            // the reader the wrong thing entirely.
            let token: string;
            try {
               token = await deps.githubApp!.token(workspaceId, account);
            } catch {
               return [];
            }
            const repositories = await build(token)
               .listRepositories({
                  credential: 'installation',
                  ...(deps.maxPages === undefined ? {} : { maxPages: deps.maxPages }),
               })
               .catch((error: unknown) => {
                  if (error instanceof GitHubError) return [] as RepositoryChoice[];
                  throw error;
               });
            return repositories.map((repository) => ({
               ...repository,
               installationId: installation.installationId,
               accountLogin: account ?? ownerOf(repository),
            }));
         })
      );
      // By id, so an account connected twice cannot double the list.
      const merged = new Map<number, AttributedRepository>();
      for (const repository of perAccount.flat()) {
         if (!merged.has(repository.id)) merged.set(repository.id, repository);
      }
      return {
         repositories: [...merged.values()],
         kind: 'installation',
         accounts: installations.map((installation) => ({
            installationId: installation.installationId,
            accountLogin: installation.accountLogin ?? '',
            accountType: installation.accountType,
         })),
      };
   }

   // The older path: one user connection, which sees whatever the person does.
   if (!deps.connections) {
      throw new GitHubAppUnavailable('this deployment has no GitHub App', 'no_app');
   }
   const token = await deps.connections.token(workspaceId, 'github');
   const repositories = await build(token).listRepositories({
      credential: 'user',
      ...(deps.maxPages === undefined ? {} : { maxPages: deps.maxPages }),
   });
   const attributed = repositories.map((repository) => ({
      ...repository,
      installationId: null,
      accountLogin: ownerOf(repository),
   }));
   return {
      repositories: attributed,
      kind: 'user',
      accounts: [...new Set(attributed.map((repository) => repository.accountLogin))].map(
         (accountLogin) => ({ installationId: null, accountLogin, accountType: null })
      ),
   };
}
