import type { InboundResult } from './inbound.ts';
import type { GitHubSettingsRepository } from './github-settings.ts';
import { pullRequestState } from './pr-linking.ts';
import type { CheckInput, PullRequestInput, PullRequestStore } from './pull-requests.ts';

/**
 * What a verified GitHub webhook changes in Berry.
 *
 * The workspace is the one that installed the App the payload names, looked
 * up by GitHub's installation id and nothing else. A repository name, an owner
 * or an issue key in a title never decides whose rows are written: a payload
 * from an installation no workspace owns is ignored whole.
 */

export interface GitHubEventDeps {
   workspaceForInstallation(installationId: number): Promise<string | null>;
   settings: Pick<GitHubSettingsRepository, 'get'>;
   pullRequests: Pick<
      PullRequestStore,
      'upsertPullRequest' | 'linkIssues' | 'closeLinkedIssues' | 'upsertCheck' | 'publishUpdated'
   >;
   /** Forgets an installation GitHub says was removed; answers with its workspace. */
   removeInstallation(installationId: number): Promise<string | null>;
   publishConnection(workspaceId: string): Promise<void>;
}

const HANDLED = new Set(['pull_request', 'check_run', 'check_suite', 'installation']);

const IGNORED = (reason: string): InboundResult => ({ applied: false, reason });

export class GitHubEvents {
   readonly #deps: GitHubEventDeps;

   constructor(deps: GitHubEventDeps) {
      this.#deps = deps;
   }

   handles(event: string): boolean {
      return HANDLED.has(event);
   }

   async apply(event: string, payload: Record<string, unknown>): Promise<InboundResult> {
      if (event === 'installation') return this.#installation(payload);

      const installationId = Number(record(payload.installation)?.id ?? 0);
      if (!Number.isSafeInteger(installationId) || installationId <= 0) {
         return IGNORED('no installation on the payload');
      }
      const workspaceId = await this.#deps.workspaceForInstallation(installationId);
      if (!workspaceId) return IGNORED('installation is not claimed by a workspace');

      // Honoured before anything is written: off means GitHub changes nothing
      // here, including the rows that would only be shown later.
      const settings = await this.#deps.settings.get(workspaceId);
      if (!settings.enabled) return IGNORED('GitHub is switched off for this workspace');

      if (event === 'pull_request') {
         const pr = parsePullRequest(payload);
         if (!pr) return IGNORED('not a pull request payload');
         const { id, stale } = await this.#deps.pullRequests.upsertPullRequest(workspaceId, pr);
         const linked = await this.#deps.pullRequests.linkIssues(workspaceId, id, pr, {
            autoLink: settings.autoLinkPullRequests,
         });
         // A stale delivery describes a past the row has moved beyond, so it
         // cannot be the merge that closes anything.
         const closed =
            !stale && pr.state === 'merged'
               ? await this.#deps.pullRequests.closeLinkedIssues(workspaceId, id, null)
               : [];
         await this.#deps.pullRequests.publishUpdated(workspaceId, [...new Set([...linked, ...closed])], id);
         return { applied: true, reason: `pull request ${pr.state}` };
      }

      if (event === 'check_run' || event === 'check_suite') {
         const check = parseCheck(event, payload);
         if (!check) return IGNORED('not a check payload');
         const issues = await this.#deps.pullRequests.upsertCheck(workspaceId, check);
         await this.#deps.pullRequests.publishUpdated(workspaceId, issues, null);
         return { applied: true, reason: `check ${check.status}` };
      }

      return IGNORED(`unhandled event ${event}`);
   }

   /**
    * The App uninstalled on GitHub's side.
    *
    * Applied whatever the master switch says: a workspace that switched
    * GitHub off still must not go on believing an installation exists.
    */
   async #installation(payload: Record<string, unknown>): Promise<InboundResult> {
      if (payload.action !== 'deleted') return IGNORED('installation change needs nothing');
      const installationId = Number(record(payload.installation)?.id ?? 0);
      if (!Number.isSafeInteger(installationId) || installationId <= 0) {
         return IGNORED('no installation on the payload');
      }
      const workspaceId = await this.#deps.removeInstallation(installationId);
      if (!workspaceId) return IGNORED('installation is not claimed by a workspace');
      await this.#deps.publishConnection(workspaceId);
      return { applied: true, reason: 'installation removed' };
   }
}

function record(value: unknown): Record<string, unknown> | undefined {
   return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
}

function text(value: unknown): string | null {
   return typeof value === 'string' ? value : null;
}

/** A `pull_request` payload as Berry stores it, or null when it is not one. */
export function parsePullRequest(payload: Record<string, unknown>): PullRequestInput | null {
   const pull = record(payload.pull_request);
   const repository = record(payload.repository) ?? record(record(record(pull?.base)?.repo));
   const head = record(pull?.head);
   const githubId = Number(pull?.id ?? 0);
   const number = Number(pull?.number ?? 0);
   const repoId = Number(repository?.id ?? 0);
   const headRef = text(head?.ref);
   if (!pull || !githubId || !number || !repoId || !headRef) return null;
   const merged = pull.merged === true;
   const draft = pull.draft === true;
   return {
      githubId,
      repoId,
      repoFullName: text(repository?.full_name) ?? '',
      number,
      title: text(pull.title) ?? '',
      url: text(pull.html_url) ?? '',
      state: pullRequestState({ state: text(pull.state) ?? 'open', merged, draft }),
      draft,
      headRef,
      headSha: text(head?.sha),
      authorLogin: text(record(pull.user)?.login),
      mergedAt: text(pull.merged_at),
      closedAt: text(pull.closed_at),
      githubUpdatedAt: text(pull.updated_at),
      body: text(pull.body),
   };
}

/** A `check_run` or `check_suite` payload, or null without an id and head commit. */
export function parseCheck(
   event: 'check_run' | 'check_suite',
   payload: Record<string, unknown>
): CheckInput | null {
   const check = record(payload[event]);
   const githubId = Number(check?.id ?? 0);
   const repoId = Number(record(payload.repository)?.id ?? 0);
   const headSha = text(check?.head_sha);
   if (!check || !githubId || !repoId || !headSha) return null;
   const name =
      event === 'check_run'
         ? (text(check.name) ?? 'Check')
         : (text(record(check.app)?.name) ?? 'Check suite');
   return {
      kind: event === 'check_run' ? 'run' : 'suite',
      githubId,
      repoId,
      headSha,
      name,
      status: text(check.status) ?? 'queued',
      conclusion: text(check.conclusion),
      url: text(check.html_url),
   };
}
