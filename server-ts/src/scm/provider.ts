/**
 * What Berry needs from a source-control host.
 *
 * Berry's domain code talks to this and never to an HTTP API. The point is not
 * portability for its own sake — it is that "create the repository for this
 * project" is a sentence about Berry, and `POST /api/v1/orgs/{org}/repos` is a
 * sentence about GitHub. Mixing them puts one vendor's URL shapes into the
 * middle of the project-creation flow, where the next vendor cannot be added
 * without editing it.
 *
 * The shape is taken from `integrations/github.ts`, which already had
 * `repository`, `openPullRequest` and `findPullRequest` and was the de facto
 * interface before there was a second host to satisfy.
 *
 * Everything here is identified by the host's own numeric id. Names are for
 * people: they are edited, they collide across owners, and matching on them is
 * how one project's history ends up attached to another's.
 */

/**
 * `gitea` is retained though nothing serves it: rows written while Berry ran
 * its own git server still name it, and migration 048 marks them detached
 * rather than deleting history that explains how a project got here.
 */
export type ScmProviderId = 'gitea' | 'github';

export interface ScmOrganization {
   id: number;
   /** The login, which is also the URL segment. */
   name: string;
   url: string;
}

export interface ScmRepository {
   id: number;
   owner: string;
   name: string;
   /** `owner/name`, as every host spells it. */
   fullName: string;
   defaultBranch: string;
   /** Where a run clones from, reachable from inside the deployment. */
   cloneUrl: string;
   /** Where a person opens it. */
   url: string;
   private: boolean;
}

export interface ScmMilestone {
   id: number;
   title: string;
   state: 'open' | 'closed';
   url: string;
}

export interface ScmIssue {
   id: number;
   /** The per-repository number a person sees, distinct from `id`. */
   number: number;
   title: string;
   state: 'open' | 'closed';
   url: string;
   /** For breaking echo loops: a webhook older than this is Berry's own write. */
   updatedAt: string | null;
}

export interface ScmPullRequest {
   id: number;
   number: number;
   url: string;
   state: 'open' | 'closed';
   merged: boolean;
   headBranch: string;
   baseBranch: string;
   updatedAt: string | null;
   /** False when an equivalent pull request was already open. */
   created: boolean;
}

export interface ScmReview {
   id: number;
   state: 'approved' | 'rejected' | 'commented' | 'pending';
   body: string;
   reviewer: string | null;
   submittedAt: string | null;
}

/** Where a repository lives, as the host addresses it. */
export interface RepositoryRef {
   owner: string;
   name: string;
}

/**
 * A failure that came from the host rather than from Berry.
 *
 * `remedy` is what a person can do about it, which is the part an error
 * message usually leaves out: a 401 and a 409 are both "it did not work" and
 * only one of them is worth retrying.
 */
export class ScmError extends Error {
   override readonly name = 'ScmError';
   readonly status: number;
   readonly remedy: 'retry' | 'reconnect' | 'conflict' | 'missing' | 'none';
   constructor(message: string, status: number, remedy: ScmError['remedy'] = 'none') {
      super(message);
      this.status = status;
      this.remedy = remedy;
   }

   /** Whether trying the same call again could plausibly succeed. */
   get retryable(): boolean {
      return this.remedy === 'retry';
   }
}

export interface ScmProvider {
   readonly id: ScmProviderId;

   /** The organization for a workspace, created if this host has none. */
   ensureOrganization(input: {
      login: string;
      displayName: string;
      description?: string | null;
   }): Promise<ScmOrganization>;

   /** The repository for a project, created if absent. Idempotent by name within the owner. */
   ensureRepository(input: {
      owner: string;
      name: string;
      description?: string | null;
      private?: boolean;
      defaultBranch?: string;
   }): Promise<ScmRepository>;

   /** Pushes Berry's copy of the mutable attributes. Never touches Berry-only settings. */
   updateRepository(
      repo: RepositoryRef,
      changes: { name?: string; description?: string | null; private?: boolean; defaultBranch?: string }
   ): Promise<ScmRepository>;

   getRepository(repo: RepositoryRef): Promise<ScmRepository>;

   /** True when a repository was there to delete. */
   deleteRepository(repo: RepositoryRef): Promise<boolean>;

   createMilestone(
      repo: RepositoryRef,
      input: { title: string; description?: string | null; dueOn?: string | null; state?: 'open' | 'closed' }
   ): Promise<ScmMilestone>;

   updateMilestone(
      repo: RepositoryRef,
      milestoneId: number,
      changes: { title?: string; description?: string | null; dueOn?: string | null; state?: 'open' | 'closed' }
   ): Promise<ScmMilestone>;

   createIssue(
      repo: RepositoryRef,
      input: {
         title: string;
         body?: string | null;
         milestoneId?: number | null;
         labels?: string[];
         assignees?: string[];
      }
   ): Promise<ScmIssue>;

   updateIssue(
      repo: RepositoryRef,
      issueNumber: number,
      changes: {
         title?: string;
         body?: string | null;
         state?: 'open' | 'closed';
         milestoneId?: number | null;
         labels?: string[];
         assignees?: string[];
      }
   ): Promise<ScmIssue>;

   openPullRequest(
      repo: RepositoryRef,
      input: { title: string; body?: string | null; head: string; base: string }
   ): Promise<ScmPullRequest>;

   findPullRequest(repo: RepositoryRef, head: string): Promise<ScmPullRequest | null>;

   listReviews(repo: RepositoryRef, pullNumber: number): Promise<ScmReview[]>;

   /**
    * The credential a run uses to clone and push.
    *
    * Returned rather than embedded in `cloneUrl` so a repository address can be
    * stored, logged and shown without carrying a secret wherever it goes. The
    * caller passes it as per-command environment, never in a command.
    */
   runCredential(): Promise<{ username: string; password: string }>;
}
