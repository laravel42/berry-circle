import type { Logger } from '../observability/log.ts';
import type { ScmLinkRepository, BerryType } from './links.ts';
import {
   ScmError,
   type ScmProviderId,
   type RepositoryRef,
   type ScmIssue,
   type ScmMilestone,
   type ScmOrganization,
   type ScmProvider,
   type ScmRepository,
} from './provider.ts';

/**
 * Creating the host counterpart of a Berry object, and remembering what happened.
 *
 * This is the only place that pairs a provider call with a link write, and it
 * always does so in the same order: claim the intent, make the call, record the
 * outcome. Written the other way round — call first, write on success — a
 * process that died mid-call would leave no trace, and Berry would look like it
 * had never tried.
 *
 * Nothing here throws by default. A project whose repository could not be
 * created is still a project; the failure is recorded on the link and surfaced,
 * rather than taking down the request that created it. Callers who genuinely
 * cannot continue pass `required: true`.
 */

export interface ProvisioningDeps {
   /**
    * The provider for one workspace.
    *
    * A factory rather than an instance because a GitHub App credential is per
    * installation, and an installation is per workspace. One shared client
    * would either hold the wrong workspace's token or hold none at all.
    */
   provider: (workspaceId: string) => ScmProvider;
   /** Which host this is, without needing a workspace to ask. */
   providerId: ScmProviderId;
   links: ScmLinkRepository;
   logger: Logger;
}

export interface Provisioned<T> {
   /** Null when the host call failed; the link then carries the reason. */
   value: T | null;
   error: ScmError | null;
}

export class ScmProvisioning {
   readonly #provider: (workspaceId: string) => ScmProvider;
   readonly #providerId: ScmProviderId;
   readonly #links: ScmLinkRepository;
   readonly #logger: Logger;

   constructor(deps: ProvisioningDeps) {
      this.#provider = deps.provider;
      this.#providerId = deps.providerId;
      this.#links = deps.links;
      this.#logger = deps.logger;
   }

   /** The provider for one workspace's credential. */
   provider(workspaceId: string): ScmProvider {
      return this.#provider(workspaceId);
   }

   get providerId(): ScmProviderId {
      return this.#providerId;
   }

   get links(): ScmLinkRepository {
      return this.#links;
   }

   /** The organization for a workspace. */
   async organization(input: {
      workspaceId: string;
      login: string;
      displayName: string;
      description?: string | null;
   }): Promise<Provisioned<ScmOrganization>> {
      return this.#run('workspace', input.workspaceId, input.workspaceId, async () => {
         const organization = await this.#provider(input.workspaceId).ensureOrganization({
            login: input.login,
            displayName: input.displayName,
            description: input.description ?? null,
         });
         return { external: { id: organization.id, url: organization.url }, value: organization };
      });
   }

   /** The repository for a project. */
   async repository(input: {
      workspaceId: string;
      projectId: string;
      owner: string;
      name: string;
      description?: string | null;
      defaultBranch?: string;
   }): Promise<Provisioned<ScmRepository>> {
      return this.#run('project', input.projectId, input.workspaceId, async () => {
         const repository = await this.#provider(input.workspaceId).ensureRepository({
            owner: input.owner,
            name: input.name,
            description: input.description ?? null,
            private: true,
            defaultBranch: input.defaultBranch ?? 'main',
         });
         return { external: { id: repository.id, url: repository.url }, value: repository };
      });
   }

   /** The milestone for a Berry milestone, inside its project's repository. */
   async milestone(input: {
      workspaceId: string;
      milestoneId: string;
      repo: RepositoryRef;
      title: string;
      description?: string | null;
      dueOn?: string | null;
      state?: 'open' | 'closed';
   }): Promise<Provisioned<ScmMilestone>> {
      return this.#run('milestone', input.milestoneId, input.workspaceId, async () => {
         const existing = await this.#links.find(this.#providerId, 'milestone', input.milestoneId);
         const milestone =
            existing?.externalId && existing.status === 'synced'
               ? await this.#provider(input.workspaceId).updateMilestone(input.repo, existing.externalId, {
                    title: input.title,
                    description: input.description ?? null,
                    dueOn: input.dueOn ?? null,
                    ...(input.state ? { state: input.state } : {}),
                 })
               : await this.#provider(input.workspaceId).createMilestone(input.repo, {
                    title: input.title,
                    description: input.description ?? null,
                    dueOn: input.dueOn ?? null,
                    state: input.state ?? 'open',
                 });
         return { external: { id: milestone.id, url: milestone.url }, value: milestone };
      });
   }

   /** The issue for a Berry task. */
   async issue(input: {
      workspaceId: string;
      issueId: string;
      repo: RepositoryRef;
      title: string;
      body?: string | null;
      milestoneId?: number | null;
      labels?: string[];
      assignees?: string[];
   }): Promise<Provisioned<ScmIssue>> {
      return this.#run('issue', input.issueId, input.workspaceId, async () => {
         const issue = await this.#provider(input.workspaceId).createIssue(input.repo, {
            title: input.title,
            body: input.body ?? null,
            milestoneId: input.milestoneId ?? null,
            ...(input.labels ? { labels: input.labels } : {}),
            ...(input.assignees ? { assignees: input.assignees } : {}),
         });
         return {
            external: {
               id: issue.id,
               number: issue.number,
               url: issue.url,
               updatedAt: issue.updatedAt,
            },
            value: issue,
         };
      });
   }

   /**
    * Pushes a change to an already-linked issue.
    *
    * Separate from `issue` because the failure means something different: a
    * create that fails leaves no counterpart, an update that fails leaves one
    * that has drifted. Only the second is worth a `failed` status on a link
    * that was previously synced — and `fail` deliberately refuses to downgrade
    * a synced link, so this records the error without claiming the object is gone.
    */
   async pushIssue(input: {
      workspaceId: string;
      issueId: string;
      repo: RepositoryRef;
      changes: {
         title?: string;
         body?: string | null;
         state?: 'open' | 'closed';
         milestoneId?: number | null;
         labels?: string[];
         assignees?: string[];
      };
   }): Promise<Provisioned<ScmIssue>> {
      const link = await this.#links.find(this.#providerId, 'issue', input.issueId);
      if (!link?.externalNumber || link.status !== 'synced') {
         return { value: null, error: null };
      }
      try {
         const issue = await this.#provider(input.workspaceId).updateIssue(
            input.repo,
            link.externalNumber,
            input.changes
         );
         await this.#links.touch({
            provider: this.#providerId,
            berryType: 'issue',
            berryId: input.issueId,
            externalUpdatedAt: issue.updatedAt,
         });
         return { value: issue, error: null };
      } catch (cause: unknown) {
         const error = asScmError(cause);
         // A counterpart deleted on the host is not a Berry failure to retry;
         // it is a mapping that is now dead, and saying so is the honest state.
         if (error.remedy === 'missing') {
            await this.#links.detach(this.#providerId, 'issue', input.issueId);
         } else {
            await this.#links.fail({
               workspaceId: input.workspaceId,
               provider: this.#providerId,
               berryType: 'issue',
               berryId: input.issueId,
               error: error.message,
            });
         }
         this.#logger.error('scm issue update failed', {
            issueId: input.issueId,
            status: error.status,
            error: error.message,
         });
         return { value: null, error };
      }
   }

   /** The link for one object, for callers that only need the id. */
   async linkFor(berryType: BerryType, berryId: string) {
      return this.#links.find(this.#providerId, berryType, berryId);
   }

   async #run<T>(
      berryType: BerryType,
      berryId: string,
      workspaceId: string,
      work: () => Promise<{
         external: { id: number; number?: number; url?: string; updatedAt?: string | null };
         value: T;
      }>
   ): Promise<Provisioned<T>> {
      const existing = await this.#links.find(this.#providerId, berryType, berryId);
      // Already provisioned. Doing it again is not idempotent for every object
      // — a second createIssue is a second issue — so this returns rather than
      // repeating the call.
      if (existing?.status === 'synced' && existing.externalId) {
         return { value: null, error: null };
      }

      await this.#links.claim({
         workspaceId,
         provider: this.#providerId,
         berryType,
         berryId,
      });

      try {
         const { external, value } = await work();
         await this.#links.succeed({
            workspaceId,
            provider: this.#providerId,
            berryType,
            berryId,
            externalId: external.id,
            externalNumber: external.number ?? null,
            externalUrl: external.url ?? null,
            externalUpdatedAt: external.updatedAt ?? null,
         });
         return { value, error: null };
      } catch (cause: unknown) {
         const error = asScmError(cause);
         await this.#links
            .fail({
               workspaceId,
               provider: this.#providerId,
               berryType,
               berryId,
               error: error.message,
            })
            .catch(() => undefined);
         this.#logger.error('scm provisioning failed', {
            berryType,
            berryId,
            status: error.status,
            remedy: error.remedy,
            error: error.message,
         });
         return { value: null, error };
      }
   }
}

function asScmError(cause: unknown): ScmError {
   if (cause instanceof ScmError) return cause;
   return new ScmError(cause instanceof Error ? cause.message : String(cause), 0, 'none');
}
