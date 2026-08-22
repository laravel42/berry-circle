import { API_BASE_URL, isApiConfigured } from './config';

/**
 * Minimal gateway client.
 *
 * The Circle template was fully client-side against in-memory mock data.
 * This module is the seam where the gateway (BFF) lands: board, issue and
 * mutation wiring (BERR-29/30) calls through here instead of touching
 * `fetch` directly.
 */

/** Resolves an API path against the configured gateway base URL. */
export function apiUrl(path: string): string {
   if (!isApiConfigured) {
      throw new Error('Berry gateway is not configured (set NEXT_PUBLIC_BERRY_API_URL)');
   }
   return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

/** JSON fetch against the gateway; throws on HTTP errors. */
export async function apiFetch<T>(
   path: string,
   init?: RequestInit,
   options: { signal?: AbortSignal } = {}
): Promise<T> {
   const response = await fetch(apiUrl(path), {
      ...init,
      signal: options.signal,
      headers: {
         accept: 'application/json',
         ...(init?.body ? { 'content-type': 'application/json' } : {}),
         ...init?.headers,
      },
   });

   if (!response.ok) {
      throw new Error(`Gateway request failed: ${response.status} ${response.statusText}`);
   }

   return (await response.json()) as T;
}
