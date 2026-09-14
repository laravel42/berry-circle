/** A small client for Berry's public API (`/v1`). */

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class BerryApiError extends Error {
   override readonly name = 'BerryApiError';
   readonly status: number;
   readonly code: string;
   constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
   }
}

export interface IssuePatch {
   title?: string;
   description?: string | null;
   status?: 'backlog' | 'todo' | 'inProgress' | 'inReview' | 'done' | 'blocked' | 'cancelled';
   priority?: 'none' | 'urgent' | 'high' | 'medium' | 'low';
}

export class BerryClient {
   readonly #base: string;
   readonly #token: string;
   readonly #fetch: FetchLike;

   constructor(options: { apiUrl: string; token: string; fetchImpl?: FetchLike }) {
      this.#base = options.apiUrl.replace(/\/+$/, '');
      this.#token = options.token;
      this.#fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
   }

   context(): Promise<unknown> {
      return this.#json('GET', '/v1/context');
   }

   getIssue(ref: string): Promise<unknown> {
      return this.#json('GET', `/v1/issues/${encodeURIComponent(ref)}`);
   }

   updateIssue(ref: string, patch: IssuePatch): Promise<unknown> {
      return this.#json('PATCH', `/v1/issues/${encodeURIComponent(ref)}`, patch);
   }

   listComments(ref: string): Promise<unknown> {
      return this.#json('GET', `/v1/issues/${encodeURIComponent(ref)}/comments`);
   }

   createComment(ref: string, body: string, parentId?: string): Promise<unknown> {
      return this.#json('POST', `/v1/issues/${encodeURIComponent(ref)}/comments`, parentId ? { body, parentId } : { body });
   }

   readonly storage = {
      get: async (key: string): Promise<unknown> => {
         try {
            return ((await this.#json('GET', `/v1/storage/${storagePath(key)}`)) as { value: unknown }).value;
         } catch (error) {
            if (error instanceof BerryApiError && error.status === 404) return null;
            throw error;
         }
      },
      put: (key: string, value: unknown): Promise<unknown> =>
         this.#json('PUT', `/v1/storage/${storagePath(key)}`, { value }),
      delete: async (key: string): Promise<void> => {
         await this.#json('DELETE', `/v1/storage/${storagePath(key)}`);
      },
      list: (prefix = '', after?: string): Promise<unknown> => {
         const query = new URLSearchParams({ prefix });
         if (after) query.set('after', after);
         return this.#json('GET', `/v1/storage?${query.toString()}`);
      },
   };

   async #json(method: string, path: string, body?: unknown): Promise<unknown> {
      const headers: Record<string, string> = { authorization: `Bearer ${this.#token}`, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await this.#fetch(`${this.#base}${path}`, {
         method,
         headers,
         ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 204) return undefined;
      const parsed: unknown = await response.json().catch(() => null);
      if (!response.ok) {
         const error = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
         throw new BerryApiError(response.status, error?.code ?? 'REQUEST_FAILED', error?.message ?? `Berry answered ${response.status}`);
      }
      return parsed;
   }
}

/** Keys may contain '/', which the route keeps; each segment is escaped on its own. */
function storagePath(key: string): string {
   return key.split('/').map(encodeURIComponent).join('/');
}
