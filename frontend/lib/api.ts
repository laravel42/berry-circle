import { API_BASE_URL } from './config';

/**
 * Berry API client.
 *
 * The Circle template was fully client-side against in-memory mock data.
 * Issue loading (BERR-29) and later mutations call through this seam instead
 * of touching `fetch` directly.
 */

export interface ApiSession {
   /** Returns a raw bearer token. Implementations must not include the `Bearer` prefix. */
   getBearerToken(): string | null | Promise<string | null>;
}

export interface MutableApiSession extends ApiSession {
   setBearerToken(token: string | null): void;
   clear(): void;
}

export interface ApiFetchOptions {
   signal?: AbortSignal;
   session?: ApiSession;
   onRequestId?: (requestId: string) => void;
}

export interface BerryErrorPayload {
   code: string;
   message: string;
   requestId?: string;
   details: unknown;
}

export class BerryApiError extends Error {
   readonly status: number;
   readonly code: string;
   readonly requestId?: string;
   readonly details: unknown;

   constructor(status: number, payload: BerryErrorPayload) {
      super(payload.message);
      this.name = 'BerryApiError';
      this.status = status;
      this.code = payload.code;
      this.requestId = payload.requestId;
      this.details = payload.details;
   }
}

function normalizedBearerToken(token: string | null): string | null {
   if (token === null) return null;

   const normalized = token.trim();
   if (!normalized) return null;
   if (/\s/.test(normalized)) {
      throw new Error('Berry session token contains invalid whitespace');
   }
   return normalized;
}

/**
 * Creates a session whose token only lives in this JavaScript closure.
 *
 * Auth wiring can replace or clear it without putting credentials in build
 * variables, logs, URLs, or persistent browser storage.
 */
export function createMemoryApiSession(initialToken: string | null = null): MutableApiSession {
   let bearerToken = normalizedBearerToken(initialToken);

   return {
      getBearerToken: () => bearerToken,
      setBearerToken(token) {
         bearerToken = normalizedBearerToken(token);
      },
      clear() {
         bearerToken = null;
      },
   };
}

let activeSession: ApiSession | undefined;

/** Installs the current runtime session; pass undefined when signing out. */
export function setApiSession(session: ApiSession | undefined): void {
   if (typeof window === 'undefined') {
      throw new Error('Global Berry API sessions are browser-only; pass a session per request');
   }
   activeSession = session;
}

function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses the stable Berry error envelope without trusting arbitrary JSON. */
export function parseBerryErrorEnvelope(value: unknown): BerryErrorPayload | undefined {
   if (!isRecord(value) || !isRecord(value.error)) return undefined;

   const { code, message, requestId, details = null } = value.error;
   if (typeof code !== 'string' || !code || typeof message !== 'string' || !message) {
      return undefined;
   }

   return {
      code,
      message,
      requestId: typeof requestId === 'string' && requestId ? requestId : undefined,
      details,
   };
}

/** Resolves a Berry path against same-origin or the explicit dev override. */
export function apiUrl(path: string): string {
   if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//') || path.includes('\\')) {
      throw new Error('apiUrl accepts Berry API paths, not absolute URLs');
   }

   const normalizedPath = path.startsWith('/') ? path : `/${path}`;
   return `${API_BASE_URL}${normalizedPath}`;
}

/**
 * The same path as a URL another system can be given: absolute when the
 * API base is, else on this page's origin. On the server there is no origin,
 * so the relative form is returned as it is.
 */
export function absoluteApiUrl(path: string): string {
   const resolved = apiUrl(path);
   if (/^https?:/i.test(resolved)) return resolved;
   return typeof window !== 'undefined' ? `${window.location.origin}${resolved}` : resolved;
}

async function errorPayload(
   response: Response,
   headerRequestId?: string
): Promise<BerryErrorPayload> {
   let body: unknown;
   try {
      body = await response.json();
   } catch {
      body = undefined;
   }

   const parsed = parseBerryErrorEnvelope(body);
   if (parsed) {
      return {
         ...parsed,
         requestId: headerRequestId ?? parsed.requestId,
      };
   }

   return {
      code: 'REQUEST_FAILED',
      message: `Berry API request failed with status ${response.status}`,
      requestId: headerRequestId,
      details: null,
   };
}

async function applySessionHeaders(headers: Headers, options: ApiFetchOptions): Promise<void> {
   if (headers.has('authorization')) return;
   const session = options.session ?? activeSession;
   const bearerToken = session ? normalizedBearerToken(await session.getBearerToken()) : null;
   if (bearerToken) {
      headers.set('authorization', `Bearer ${bearerToken}`);
   }
}

async function berryResponse(
   path: string,
   init: RequestInit | undefined,
   options: ApiFetchOptions
): Promise<Response> {
   const headers = new Headers(init?.headers);
   await applySessionHeaders(headers, options);
   const response = await fetch(apiUrl(path), {
      ...init,
      credentials: init?.credentials ?? 'include',
      signal: options.signal ?? init?.signal,
      headers,
   });
   const requestId = response.headers.get('x-request-id')?.trim() || undefined;
   if (requestId) {
      options.onRequestId?.(requestId);
   }
   if (!response.ok) {
      throw new BerryApiError(response.status, await errorPayload(response, requestId));
   }
   return response;
}

/** JSON fetch against Berry; throws a structured `BerryApiError` on HTTP errors. */
export async function apiFetch<T>(
   path: string,
   init?: RequestInit,
   options: ApiFetchOptions = {}
): Promise<T> {
   const headers = new Headers(init?.headers);
   if (!headers.has('accept')) {
      headers.set('accept', 'application/json');
   }
   if (typeof init?.body === 'string' && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
   }
   const response = await berryResponse(path, { ...init, headers }, options);
   if (response.status === 204) {
      return undefined as T;
   }
   return (await response.json()) as T;
}

/** Text fetch against Berry, for a body that is not JSON — a diff. */
export async function apiText(
   path: string,
   init?: RequestInit,
   options: ApiFetchOptions = {}
): Promise<string> {
   const headers = new Headers(init?.headers);
   if (!headers.has('accept')) {
      headers.set('accept', 'text/plain');
   }
   const response = await berryResponse(path, { ...init, headers }, options);
   return response.text();
}

/** Binary fetch against Berry, for a body that is a file — an uploaded avatar. */
export async function apiBlob(
   path: string,
   init?: RequestInit,
   options: ApiFetchOptions = {}
): Promise<Blob> {
   const response = await berryResponse(path, init, options);
   return response.blob();
}

/** Authenticated streaming fetch for SSE endpoints. */
export async function apiStream(
   path: string,
   init?: RequestInit,
   options: ApiFetchOptions = {}
): Promise<Response> {
   const headers = new Headers(init?.headers);
   if (!headers.has('accept')) {
      headers.set('accept', 'text/event-stream');
   }
   return berryResponse(path, { ...init, headers }, options);
}
