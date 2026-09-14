import { readField, toolArguments } from '../agentcore/arguments.ts';
import { SourceControlError, SourceControlNotFoundError } from '../agentcore/errors.ts';
import type { AgentCoreGatewayClient, ToolDefinition } from '../agentcore/gateway-client.ts';
import type { Capability, ResolvedTools } from '../agentcore/tool-map.ts';
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
 * GitHub, reached through AgentCore Gateway.
 *
 * Implements the same `ScmProvider` the direct client does, so nothing in
 * Berry's domain can tell which is in use — which is the whole point of the
 * interface and the reason this migration is a provider swap rather than a
 * rewrite.
 *
 * Two things are deliberately not decided here: which tool performs an
 * operation, and what its arguments are called. Both come from what the
 * gateway reported at startup, because both are properties of how somebody
 * configured their target rather than facts about GitHub.
 */

export interface AgentCoreGitHubProviderOptions {
   gateway: AgentCoreGatewayClient;
   tools: ResolvedTools;
   /** The discovered definitions, for shaping each call's arguments. */
   definitions: Map<string, ToolDefinition>;
   /**
    * The credential a run clones and pushes with.
    *
    * Separate from the gateway because git is a wire protocol, not a tool
    * call: no MCP gateway can hand a repository to `git clone`. AgentCore
    * Identity supplies the token, and git still talks to github.com directly.
    */
   gitCredential: () => Promise<{ username: string; password: string }>;
}

export class AgentCoreGitHubProvider implements ScmProvider {
   readonly id = 'github' as const;
   readonly #gateway: AgentCoreGatewayClient;
   readonly #tools: ResolvedTools;
   readonly #definitions: Map<string, ToolDefinition>;
   readonly #gitCredential: () => Promise<{ username: string; password: string }>;

   constructor(options: AgentCoreGitHubProviderOptions) {
      this.#gateway = options.gateway;
      this.#tools = options.tools;
      this.#definitions = options.definitions;
      this.#gitCredential = options.gitCredential;
   }

   /**
    * The organization, which must already exist.
    *
    * Gateways rarely expose organization creation, and Berry would not use it
    * if they did: a GitHub organization is an account with billing and
    * members, not something a task tracker conjures.
    */
   async ensureOrganization(input: { login: string }): Promise<ScmOrganization> {
      return { id: 0, name: input.login, url: `https://github.com/${input.login}` };
   }

   async ensureRepository(input: { owner: string; name: string }): Promise<ScmRepository> {
      return this.getRepository({ owner: input.owner, name: input.name });
   }

   async getRepository(repo: RepositoryRef): Promise<ScmRepository> {
      const payload = await this.#call('getRepository', { owner: repo.owner, repo: repo.name });
      return toRepository(payload, repo);
   }

   async updateRepository(repo: RepositoryRef): Promise<ScmRepository> {
      // Not offered. Repository settings belong to whoever owns the repository,
      // and Berry has nothing it needs to push there — the description a
      // project carries is Berry's, not GitHub's to mirror.
      return this.getRepository(repo);
   }

   /** Refused. The repository is the organization's code, never Berry's to remove. */
   async deleteRepository(): Promise<boolean> {
      throw new ScmError('Berry does not delete GitHub repositories', 403, 'none');
   }

   async createMilestone(
      repo: RepositoryRef,
      input: { title: string; description?: string | null; dueOn?: string | null; state?: 'open' | 'closed' }
   ): Promise<ScmMilestone> {
      const payload = await this.#call('createMilestone', {
         owner: repo.owner,
         repo: repo.name,
         title: input.title,
         body: input.description ?? undefined,
         dueOn: input.dueOn ?? undefined,
         state: input.state ?? 'open',
      });
      return toMilestone(payload);
   }

   async updateMilestone(
      repo: RepositoryRef,
      milestoneNumber: number,
      changes: { title?: string; description?: string | null; dueOn?: string | null; state?: 'open' | 'closed' }
   ): Promise<ScmMilestone> {
      const payload = await this.#call('updateMilestone', {
         owner: repo.owner,
         repo: repo.name,
         milestoneNumber,
         title: changes.title,
         body: changes.description ?? undefined,
         dueOn: changes.dueOn ?? undefined,
         state: changes.state,
      });
      return toMilestone(payload);
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
      const payload = await this.#call('createIssue', {
         owner: repo.owner,
         repo: repo.name,
         title: input.title,
         body: input.body ?? undefined,
         milestoneNumber: input.milestoneId ?? undefined,
         labels: input.labels?.length ? input.labels : undefined,
         assignees: input.assignees?.length ? input.assignees : undefined,
      });
      return toIssue(payload);
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
      const payload = await this.#call('updateIssue', {
         owner: repo.owner,
         repo: repo.name,
         issueNumber,
         title: changes.title,
         body: changes.body ?? undefined,
         state: changes.state,
         milestoneNumber: changes.milestoneId ?? undefined,
         labels: changes.labels,
         assignees: changes.assignees,
      });
      return toIssue(payload);
   }

   async openPullRequest(
      repo: RepositoryRef,
      input: { title: string; body?: string | null; head: string; base: string }
   ): Promise<ScmPullRequest> {
      try {
         const payload = await this.#call('createPullRequest', {
            owner: repo.owner,
            repo: repo.name,
            title: input.title,
            body: input.body ?? undefined,
            head: input.head,
            base: input.base,
         });
         return toPullRequest(payload, true);
      } catch (error: unknown) {
         // A pull request already open for this branch is what makes a retried
         // delivery safe: the caller wanted one open, and there is one.
         const existing =
            error instanceof SourceControlError && (error.kind === 'conflict' || error.kind === 'validation')
               ? await this.findPullRequest(repo, input.head).catch(() => null)
               : null;
         if (existing) return existing;
         throw error;
      }
   }

   async findPullRequest(repo: RepositoryRef, head: string): Promise<ScmPullRequest | null> {
      if (!this.#tools.name('listPullRequests')) return null;
      const branch = head.includes(':') ? head.slice(head.indexOf(':') + 1) : head;
      const payload = await this.#call('listPullRequests', {
         owner: repo.owner,
         repo: repo.name,
         head: `${repo.owner}:${branch}`,
         state: 'all',
      });
      const list = asArray(payload);
      const match = list.find((entry) => {
         const ref = readField(readField(entry, 'head'), 'ref', 'branch');
         return typeof ref === 'string' && ref === branch;
      });
      return match ? toPullRequest(match, false) : null;
   }

   async listReviews(repo: RepositoryRef, pullNumber: number): Promise<ScmReview[]> {
      if (!this.#tools.name('listPullRequestReviews')) return [];
      const payload = await this.#call('listPullRequestReviews', {
         owner: repo.owner,
         repo: repo.name,
         pullNumber,
      });
      return asArray(payload).map(toReview);
   }

   async runCredential(): Promise<{ username: string; password: string }> {
      return this.#gitCredential();
   }

   /**
    * One tool call, with the arguments shaped for whatever this gateway calls
    * its fields, and its answer unwrapped.
    */
   async #call(capability: Capability, fields: Record<string, unknown>): Promise<unknown> {
      const name = this.#tools.require(capability);
      const args = toolArguments(this.#definitions.get(name), fields);
      const result = await this.#gateway.callTool(name, args);
      // Some targets wrap the resource; a bare object is the resource itself.
      return readField(result, 'result', 'data', 'body') ?? result;
   }
}

function asArray(payload: unknown): unknown[] {
   if (Array.isArray(payload)) return payload;
   for (const key of ['items', 'data', 'results', 'pull_requests', 'issues', 'reviews']) {
      const nested = readField(payload, key);
      if (Array.isArray(nested)) return nested;
   }
   return [];
}

function toRepository(payload: unknown, repo: RepositoryRef): ScmRepository {
   const owner = readField(readField(payload, 'owner'), 'login', 'name') ?? repo.owner;
   const name = readField(payload, 'name') ?? repo.name;
   if (readField(payload, 'id') === undefined && readField(payload, 'full_name') === undefined) {
      throw new SourceControlNotFoundError(`${repo.owner}/${repo.name} was not found`);
   }
   return {
      id: Number(readField(payload, 'id') ?? 0),
      owner: String(owner),
      name: String(name),
      fullName: String(readField(payload, 'full_name', 'fullName') ?? `${owner}/${name}`),
      defaultBranch: String(readField(payload, 'default_branch', 'defaultBranch') || 'main'),
      cloneUrl: String(
         readField(payload, 'clone_url', 'cloneUrl') ?? `https://github.com/${owner}/${name}.git`
      ),
      url: String(readField(payload, 'html_url', 'htmlUrl', 'url') ?? ''),
      private: readField(payload, 'private', 'isPrivate') === true,
   };
}

function toMilestone(payload: unknown): ScmMilestone {
   return {
      // The number, not the id: every GitHub path that touches a milestone
      // addresses it by number.
      id: Number(readField(payload, 'number', 'milestone_number') ?? 0),
      title: String(readField(payload, 'title', 'name') ?? ''),
      state: readField(payload, 'state') === 'closed' ? 'closed' : 'open',
      url: String(readField(payload, 'html_url', 'htmlUrl', 'url') ?? ''),
   };
}

function toIssue(payload: unknown): ScmIssue {
   const updated = readField(payload, 'updated_at', 'updatedAt');
   return {
      id: Number(readField(payload, 'id') ?? 0),
      number: Number(readField(payload, 'number', 'issue_number') ?? 0),
      title: String(readField(payload, 'title') ?? ''),
      state: readField(payload, 'state') === 'closed' ? 'closed' : 'open',
      url: String(readField(payload, 'html_url', 'htmlUrl', 'url') ?? ''),
      updatedAt: typeof updated === 'string' ? updated : null,
   };
}

function toPullRequest(payload: unknown, created: boolean): ScmPullRequest {
   const head = readField(payload, 'head');
   const base = readField(payload, 'base');
   const mergedAt = readField(payload, 'merged_at', 'mergedAt');
   const updated = readField(payload, 'updated_at', 'updatedAt');
   return {
      id: Number(readField(payload, 'id') ?? 0),
      number: Number(readField(payload, 'number', 'pull_number') ?? 0),
      url: String(readField(payload, 'html_url', 'htmlUrl', 'url') ?? ''),
      state: readField(payload, 'state') === 'closed' ? 'closed' : 'open',
      merged: readField(payload, 'merged') === true || (mergedAt !== null && mergedAt !== undefined),
      headBranch: String(readField(head, 'ref', 'branch') ?? ''),
      baseBranch: String(readField(base, 'ref', 'branch') ?? ''),
      updatedAt: typeof updated === 'string' ? updated : null,
      created,
   };
}

function toReview(payload: unknown): ScmReview {
   const state = String(readField(payload, 'state') ?? '').toUpperCase();
   const submitted = readField(payload, 'submitted_at', 'submittedAt');
   const user = readField(payload, 'user', 'reviewer');
   return {
      id: Number(readField(payload, 'id') ?? 0),
      state:
         state === 'APPROVED'
            ? 'approved'
            : state === 'CHANGES_REQUESTED'
              ? 'rejected'
              : state === 'PENDING'
                ? 'pending'
                : 'commented',
      body: String(readField(payload, 'body') ?? ''),
      reviewer: (() => {
         const login = readField(user, 'login', 'name');
         return typeof login === 'string' ? login : null;
      })(),
      submittedAt: typeof submitted === 'string' ? submitted : null,
   };
}
