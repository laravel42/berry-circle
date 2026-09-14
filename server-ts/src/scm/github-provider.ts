import {
   ScmError,
   type RepositoryRef,
   type ScmIssue,
   type ScmMilestone,
   type ScmOrganization,
   type ScmProvider,
   type ScmPullRequest,
   type ScmRepository,
   type ScmReview,
} from './provider.ts';

/**
 * GitHub, behind the SCM interface.
 *
 * Berry's repositories are GitHub's now, which changes what "provision" means
 * in one important way: an organization and a repository already exist and
 * belong to somebody. This provider therefore *resolves* them rather than
 * creating them — `ensureOrganization` looks one up and refuses if it is not
 * there, where the Gitea provider would have made one.
 *
 * That asymmetry is deliberate and worth stating: creating a repository in
 * someone's GitHub organization on their behalf, because they made a Berry
 * project, is not a thing Berry should do quietly.
 *
 * The credential is a GitHub App installation token, minted per call by the
 * caller. It is short-lived by design, so nothing here holds one.
 */

export interface GitHubProviderOptions {
   /**
    * Mints an installation token for the workspace this call is for.
    *
    * The account is passed when the call names one, because a workspace can be
    * installed on a personal account and on organisations at once and each
    * installation sees only its own — a token minted against the wrong one
    * answers 404 for a repository that is plainly there.
    */
   token: (owner?: string | null) => Promise<string>;
   fetch?: typeof globalThis.fetch;
   apiBase?: string;
   timeoutMs?: number;
}

const DEFAULT_API = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 15_000;

export class GitHubProvider implements ScmProvider {
   readonly id = 'github' as const;
   readonly #token: (owner?: string | null) => Promise<string>;
   readonly #fetch: typeof globalThis.fetch;
   readonly #api: string;
   readonly #timeoutMs: number;

   constructor(options: GitHubProviderOptions) {
      this.#token = options.token;
      this.#fetch = options.fetch ?? globalThis.fetch;
      this.#api = (options.apiBase ?? DEFAULT_API).replace(/\/+$/, '');
      this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
   }

   /**
    * The organization, which must already exist.
    *
    * Unlike Gitea's, this never creates one. A GitHub organization is an
    * account with billing and members; Berry linking a workspace to one is a
    * mapping, not a provisioning step.
    */
   async ensureOrganization(input: { login: string }): Promise<ScmOrganization> {
      const org = await this.#json<Record<string, unknown>>(
         'GET',
         `/orgs/${encodeURIComponent(input.login)}`
      );
      return {
         id: Number(org.id ?? 0),
         name: String(org.login ?? input.login),
         url: String(org.html_url ?? ''),
      };
   }

   /**
    * The repository a project is linked to.
    *
    * Resolves only. A project whose repository is missing is a link to fix,
    * not a repository for Berry to create in somebody's organization.
    */
   async ensureRepository(input: { owner: string; name: string }): Promise<ScmRepository> {
      return this.getRepository({ owner: input.owner, name: input.name });
   }

   async getRepository(repo: RepositoryRef): Promise<ScmRepository> {
      const payload = await this.#json<Record<string, unknown>>('GET', repoPath(repo));
      const owner = (payload.owner as Record<string, unknown> | undefined)?.login;
      return {
         id: Number(payload.id ?? 0),
         owner: typeof owner === 'string' ? owner : repo.owner,
         name: String(payload.name ?? repo.name),
         fullName: String(payload.full_name ?? `${repo.owner}/${repo.name}`),
         defaultBranch: String(payload.default_branch || 'main'),
         cloneUrl: String(payload.clone_url ?? `https://github.com/${repo.owner}/${repo.name}.git`),
         url: String(payload.html_url ?? ''),
         private: payload.private === true,
      };
   }

   async updateRepository(
      repo: RepositoryRef,
      changes: { description?: string | null; private?: boolean; defaultBranch?: string }
   ): Promise<ScmRepository> {
      // Name is deliberately absent from what Berry will push. Renaming
      // somebody's repository because a project was renamed in Berry breaks
      // every clone, bookmark and CI reference pointing at it.
      const body: Record<string, unknown> = {};
      if (changes.description !== undefined) body.description = changes.description ?? '';
      if (changes.private !== undefined) body.private = changes.private;
      if (changes.defaultBranch !== undefined) body.default_branch = changes.defaultBranch;
      if (Object.keys(body).length === 0) return this.getRepository(repo);
      await this.#json('PATCH', repoPath(repo), body);
      return this.getRepository(repo);
   }

   /**
    * Refused, always.
    *
    * The repository belongs to the workspace's GitHub organization, not to
    * Berry. Deleting a Berry project must never delete somebody's code — and
    * the reset that clears a development database certainly must not.
    */
   async deleteRepository(): Promise<boolean> {
      throw new ScmError('Berry does not delete GitHub repositories', 403, 'none');
   }

   async createMilestone(
      repo: RepositoryRef,
      input: { title: string; description?: string | null; dueOn?: string | null; state?: 'open' | 'closed' }
   ): Promise<ScmMilestone> {
      const created = await this.#json<Record<string, unknown>>(
         'POST',
         `${repoPath(repo)}/milestones`,
         {
            title: input.title,
            description: input.description ?? '',
            ...(input.dueOn ? { due_on: input.dueOn } : {}),
            state: input.state ?? 'open',
         }
      );
      return toMilestone(created);
   }

   async updateMilestone(
      repo: RepositoryRef,
      milestoneId: number,
      changes: { title?: string; description?: string | null; dueOn?: string | null; state?: 'open' | 'closed' }
   ): Promise<ScmMilestone> {
      const body: Record<string, unknown> = {};
      if (changes.title !== undefined) body.title = changes.title;
      if (changes.description !== undefined) body.description = changes.description ?? '';
      if (changes.dueOn !== undefined) body.due_on = changes.dueOn;
      if (changes.state !== undefined) body.state = changes.state;
      // GitHub addresses a milestone by its per-repository number, and that is
      // what Berry stores as `external_number`; the id is global and not a path.
      return toMilestone(
         await this.#json<Record<string, unknown>>(
            'PATCH',
            `${repoPath(repo)}/milestones/${milestoneId}`,
            body
         )
      );
   }

   async createIssue(
      repo: RepositoryRef,
      input: {
         title: string;
         body?: string | null;
         milestoneId?: number | null;
         labels?: string[];
         assignees?: string[];
      }
   ): Promise<ScmIssue> {
      return toIssue(
         await this.#json<Record<string, unknown>>('POST', `${repoPath(repo)}/issues`, {
            title: input.title,
            body: input.body ?? '',
            ...(input.milestoneId ? { milestone: input.milestoneId } : {}),
            ...(input.labels?.length ? { labels: input.labels } : {}),
            ...(input.assignees?.length ? { assignees: input.assignees } : {}),
         })
      );
   }

   async updateIssue(
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
   ): Promise<ScmIssue> {
      const body: Record<string, unknown> = {};
      if (changes.title !== undefined) body.title = changes.title;
      if (changes.body !== undefined) body.body = changes.body ?? '';
      if (changes.state !== undefined) body.state = changes.state;
      // Null clears it. GitHub reads `null` where Gitea reads 0, which is the
      // kind of difference this provider exists to absorb.
      if (changes.milestoneId !== undefined) body.milestone = changes.milestoneId ?? null;
      if (changes.labels !== undefined) body.labels = changes.labels;
      if (changes.assignees !== undefined) body.assignees = changes.assignees;
      return toIssue(
         await this.#json<Record<string, unknown>>(
            'PATCH',
            `${repoPath(repo)}/issues/${issueNumber}`,
            body
         )
      );
   }

   async openPullRequest(
      repo: RepositoryRef,
      input: { title: string; body?: string | null; head: string; base: string }
   ): Promise<ScmPullRequest> {
      const response = await this.#call('POST', `${repoPath(repo)}/pulls`, {
         title: input.title,
         body: input.body ?? '',
         head: input.head,
         base: input.base,
      });
      if (response.ok) return toPullRequest(await response.json(), true);

      // A pull request for this branch already exists. Returning it rather than
      // failing is what makes a retried delivery safe.
      if (response.status === 422) {
         const existing = await this.findPullRequest(repo, input.head);
         if (existing) return existing;
      }
      throw await this.#error(response, 'POST', `${repoPath(repo)}/pulls`);
   }

   async findPullRequest(repo: RepositoryRef, head: string): Promise<ScmPullRequest | null> {
      // `head` is `owner:branch` on GitHub's filter, so a bare branch is
      // qualified with the repository's own owner before asking.
      const qualified = head.includes(':') ? head : `${repo.owner}:${head}`;
      const list = await this.#json<Array<Record<string, unknown>>>(
         'GET',
         `${repoPath(repo)}/pulls?state=all&per_page=50&head=${encodeURIComponent(qualified)}`
      );
      return list[0] ? toPullRequest(list[0], false) : null;
   }

   async listReviews(repo: RepositoryRef, pullNumber: number): Promise<ScmReview[]> {
      const list = await this.#json<Array<Record<string, unknown>>>(
         'GET',
         `${repoPath(repo)}/pulls/${pullNumber}/reviews`
      );
      return list.map(toReview);
   }

   /**
    * The credential a run clones and pushes with.
    *
    * `x-access-token` is GitHub's convention when a token stands in for a
    * user; the token itself is an installation token, minted for this call.
    */
   async runCredential(): Promise<{ username: string; password: string }> {
      return { username: 'x-access-token', password: await this.#token() };
   }

   async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
      const response = await this.#call(method, path, body);
      if (!response.ok) throw await this.#error(response, method, path);
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
   }

   async #call(method: string, path: string, body?: unknown): Promise<Response> {
      const token = await this.#token(accountInPath(path));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
         return await this.#fetch(`${this.#api}${path}`, {
            method,
            headers: {
               authorization: `Bearer ${token}`,
               accept: 'application/vnd.github+json',
               'x-github-api-version': '2022-11-28',
               ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: controller.signal,
         });
      } catch (cause: unknown) {
         throw new ScmError(`github is unreachable: ${String(cause)}`, 0, 'retry');
      } finally {
         clearTimeout(timer);
      }
   }

   async #error(response: Response, method: string, path: string): Promise<ScmError> {
      const detail = await response
         .text()
         .then((text) => text.slice(0, 300))
         .catch(() => '');
      const remedy =
         response.status === 401
            ? 'reconnect'
            : // 403 on GitHub is usually a rate limit or a missing App
              // permission, and both are fixed by the installation rather than
              // by trying again in a second.
              response.status === 403
              ? 'reconnect'
              : response.status === 404
                ? 'missing'
                : response.status === 422 || response.status === 409
                  ? 'conflict'
                  : response.status >= 500
                    ? 'retry'
                    : 'none';
      return new ScmError(
         `github refused ${method} ${path}: ${response.status} ${detail}`,
         response.status,
         remedy
      );
   }
}

function repoPath(repo: RepositoryRef): string {
   return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

function toMilestone(payload: Record<string, unknown>): ScmMilestone {
   return {
      // The number, not the id: GitHub addresses a milestone by number in
      // every path that touches one, so that is what is worth remembering.
      id: Number(payload.number ?? 0),
      title: String(payload.title ?? ''),
      state: payload.state === 'closed' ? 'closed' : 'open',
      url: String(payload.html_url ?? ''),
   };
}

function toIssue(payload: Record<string, unknown>): ScmIssue {
   return {
      id: Number(payload.id ?? 0),
      number: Number(payload.number ?? 0),
      title: String(payload.title ?? ''),
      state: payload.state === 'closed' ? 'closed' : 'open',
      url: String(payload.html_url ?? ''),
      updatedAt: typeof payload.updated_at === 'string' ? payload.updated_at : null,
   };
}

function toPullRequest(payload: unknown, created: boolean): ScmPullRequest {
   const entry = (payload ?? {}) as Record<string, unknown>;
   const head = entry.head as Record<string, unknown> | undefined;
   const base = entry.base as Record<string, unknown> | undefined;
   return {
      id: Number(entry.id ?? 0),
      number: Number(entry.number ?? 0),
      url: String(entry.html_url ?? ''),
      state: entry.state === 'closed' ? 'closed' : 'open',
      merged: entry.merged === true || entry.merged_at !== null && entry.merged_at !== undefined,
      headBranch: typeof head?.ref === 'string' ? head.ref : '',
      baseBranch: typeof base?.ref === 'string' ? base.ref : '',
      updatedAt: typeof entry.updated_at === 'string' ? entry.updated_at : null,
      created,
   };
}

function toReview(payload: Record<string, unknown>): ScmReview {
   const state = String(payload.state ?? '').toUpperCase();
   const user = payload.user as Record<string, unknown> | undefined;
   return {
      id: Number(payload.id ?? 0),
      state:
         state === 'APPROVED'
            ? 'approved'
            : state === 'CHANGES_REQUESTED'
              ? 'rejected'
              : state === 'PENDING'
                ? 'pending'
                : 'commented',
      body: String(payload.body ?? ''),
      reviewer: typeof user?.login === 'string' ? user.login : null,
      submittedAt: typeof payload.submitted_at === 'string' ? payload.submitted_at : null,
   };
}

/**
 * The account a request is about, read off its own path.
 *
 * Taken from the path rather than passed down through every method because the
 * path already carries it — `/repos/{owner}/…` and `/orgs/{login}` are GitHub's
 * own shapes — and one place that derives it cannot disagree with itself the
 * way twenty call sites would. A path naming no account (`/user`, say) gets the
 * workspace's first installation, which is the only sensible default.
 */
function accountInPath(path: string): string | null {
   const match = /^\/(?:repos|orgs|users)\/([^/]+)/.exec(path);
   return match ? decodeURIComponent(match[1]!) : null;
}
