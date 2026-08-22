/**
 * API client configuration for the Berry gateway.
 *
 * The base URL is provided via `NEXT_PUBLIC_API_URL` at build time.
 * Defaults to `http://localhost:3001` for local development.
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export { API_BASE_URL };

/**
 * Thin fetch wrapper that prepends the API base URL.
 */
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
   const url = `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;

   const res = await fetch(url, {
      headers: {
         'Content-Type': 'application/json',
         ...init?.headers,
      },
      ...init,
   });

   if (!res.ok) {
      throw new ApiError(res.status, await res.text());
   }

   return res.json() as Promise<T>;
}

export class ApiError extends Error {
   constructor(
      public status: number,
      message: string
   ) {
      super(message);
      this.name = 'ApiError';
   }
}

/* ------------------------------------------------------------------ */
/*  Resource endpoints (stubs — to be wired in M3)                    */
/* ------------------------------------------------------------------ */

export const apiPaths = {
   issues: '/api/issues',
   projects: '/api/projects',
   teams: '/api/teams',
   users: '/api/users',
   labels: '/api/labels',
   cycles: '/api/cycles',
   views: '/api/views',
   inbox: '/api/inbox',
   initiatives: '/api/initiatives',
   documents: '/api/documents',
   reviews: '/api/reviews',
} as const;

export interface PaginatedResponse<T> {
   data: T[];
   has_more: boolean;
}
