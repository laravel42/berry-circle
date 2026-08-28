/**
 * The slice of GitHub's API Berry needs to deliver a run's work.
 *
 * Four calls, written directly rather than through a client library. The
 * surface is small enough that a dependency wrapping the whole API would be
 * more to audit than the thing it replaces — and this is code that holds a
 * credential, so what it does should be readable in one sitting.
 *
 * The token is never logged, never included in an error, and never returned.
 * Every failure here reaches an operator, so the messages say what to do
 * about it rather than echoing a response body that might quote a header.
 */

export interface PullRequest {
   number: number;
   url: string;
   state: string;
   /** True when this call created it, false when it already existed. */
   created: boolean;
}

export interface Repository {
   defaultBranch: string;
   /** False when the credential can read the repository but not write to it. */
   canPush: boolean;
}

export class GitHubError extends Error {
   override readonly name = 'GitHubError';
   readonly status: number;
   /** What an operator should do, when there is something they can do. */
   readonly remedy: 'reconnect' | 'grant-access' | 'none';
   constructor(message: string, status: number, remedy: GitHubError['remedy'] = 'none') {
      super(message);
      this.status = status;
      this.remedy = remedy;
   }
}

export interface GitHubClientOptions {
   token: string;
   /** Overridden for GitHub Enterprise, and by tests. */
   baseUrl?: string;
   fetch?: typeof globalThis.fetch;
   /** A single call's ceiling. GitHub is fast or it is broken. */
   timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 15_000;

export class GitHubClient {
   readonly #token: string;
   readonly #baseUrl: string;
   readonly #fetch: typeof globalThis.fetch;
   readonly #timeoutMs: number;

   constructor(options: GitHubClientOptions) {
      this.#token = options.token;
      this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
      this.#fetch = options.fetch ?? globalThis.fetch;
      this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
   }

   /**
    * The repository, and whether this credential can actually write to it.
    *
    * Checked before a run starts rather than after it has done the work: an
    * agent that spends ten minutes building something and then cannot push has
    * wasted the tokens and the wait.
    */
   async repository(owner: string, name: string): Promise<Repository> {
      const body = await this.#json<{
         default_branch?: unknown;
         permissions?: { push?: unknown };
      }>('GET', `/repos/${encode(owner)}/${encode(name)}`);

      return {
         defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : 'main',
         // Absent permissions means the token is not scoped to say — treated as
         // "cannot", because guessing yes is what produces the failure above.
         canPush: body.permissions?.push === true,
      };
   }

   /**
    * Opens the pull request, or returns the one that is already there.
    *
    * A retried run pushes to the same branch, and GitHub answers 422 for a
    * second pull request from it. That is not an error — the pull request the
    * caller wanted exists — so it is looked up and returned instead.
    */
   async openPullRequest(input: {
      owner: string;
      name: string;
      head: string;
      base: string;
      title: string;
      body: string;
   }): Promise<PullRequest> {
      try {
         const created = await this.#json<PullRequestBody>(
            'POST',
            `/repos/${encode(input.owner)}/${encode(input.name)}/pulls`,
            {
               head: input.head,
               base: input.base,
               title: input.title,
               body: input.body,
            }
         );
         return toPullRequest(created, true);
      } catch (error) {
         if (!(error instanceof GitHubError) || error.status !== 422) throw error;
         const existing = await this.findPullRequest(input);
         if (existing) return existing;
         // A 422 with no pull request behind it is a real refusal — an empty
         // diff, a base that does not exist — and saying "already open" would
         // be a lie that sends someone looking for a link that is not there.
         throw error;
      }
   }

   /** The open pull request from a branch, or null. */
   async findPullRequest(input: {
      owner: string;
      name: string;
      head: string;
   }): Promise<PullRequest | null> {
      const query = new URLSearchParams({
         head: `${input.owner}:${input.head}`,
         state: 'open',
         per_page: '1',
      });
      const found = await this.#json<PullRequestBody[]>(
         'GET',
         `/repos/${encode(input.owner)}/${encode(input.name)}/pulls?${query}`
      );
      const first = Array.isArray(found) ? found[0] : undefined;
      return first ? toPullRequest(first, false) : null;
   }

   async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
      let response: Response;
      try {
         response = await this.#fetch(`${this.#baseUrl}${path}`, {
            method,
            signal: AbortSignal.timeout(this.#timeoutMs),
            headers: {
               // Bearer, not `token`: it is what GitHub Apps and fine-grained
               // tokens both accept.
               authorization: `Bearer ${this.#token}`,
               accept: 'application/vnd.github+json',
               'x-github-api-version': '2022-11-28',
               // GitHub refuses a request without one.
               'user-agent': 'berry',
               ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
         });
      } catch (cause) {
         throw new GitHubError(`GitHub is unreachable: ${method} ${path}`, 0, 'none');
      }

      if (!response.ok) throw await this.#failure(response, method, path);
      return (await response.json()) as T;
   }

   async #failure(response: Response, method: string, path: string): Promise<GitHubError> {
      // Read for the message GitHub wrote, which is usually the useful part.
      const detail = await response
         .json()
         .then((body: unknown) =>
            typeof body === 'object' && body !== null && 'message' in body
               ? String((body as { message: unknown }).message)
               : ''
         )
         .catch(() => '');

      switch (response.status) {
         case 401:
            return new GitHubError('the GitHub credential was rejected', 401, 'reconnect');
         case 403:
            // Rate limiting and permission both land here; the message tells
            // them apart and an operator needs to know which.
            return new GitHubError(
               `GitHub refused the request: ${detail || 'forbidden'}`,
               403,
               /rate limit/i.test(detail) ? 'none' : 'grant-access'
            );
         case 404:
            // A token that cannot see a repository gets 404, not 403, so this
            // is as likely to be access as a typo.
            return new GitHubError(
               'the repository does not exist, or this connection cannot see it',
               404,
               'grant-access'
            );
         default:
            return new GitHubError(
               `GitHub ${method} ${path} failed: ${response.status}${detail ? ` ${detail}` : ''}`,
               response.status
            );
      }
   }
}

interface PullRequestBody {
   number?: unknown;
   html_url?: unknown;
   state?: unknown;
}

function toPullRequest(body: PullRequestBody, created: boolean): PullRequest {
   if (typeof body.number !== 'number' || typeof body.html_url !== 'string') {
      throw new GitHubError('GitHub returned a pull request with no number or url', 0);
   }
   return {
      number: body.number,
      url: body.html_url,
      state: typeof body.state === 'string' ? body.state : 'open',
      created,
   };
}

/** Path segments are interpolated, so an owner containing a slash cannot escape. */
function encode(segment: string): string {
   return encodeURIComponent(segment);
}
