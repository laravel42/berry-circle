/**
 * Workspace configuration.
 *
 * Berry is a self-hosted, single-workspace app; the values below are the
 * env-driven knobs for this frontend. All of them are `NEXT_PUBLIC_*` so
 * they are inlined at build time and usable in client components.
 */

/**
 * URL segment used for workspace-scoped routes (`/{WORKSPACE_SLUG}/…`).
 * Replaces the hardcoded org slug from the Circle template.
 */
export const WORKSPACE_SLUG = process.env.NEXT_PUBLIC_WORKSPACE_SLUG || 'berry';

/**
 * Display name of the workspace.
 */
export const WORKSPACE_NAME = process.env.NEXT_PUBLIC_WORKSPACE_NAME || 'Berry';

/**
 * Optional browser-visible API origin for cross-origin development.
 *
 * Empty is the secure default: browser requests stay on the frontend origin
 * and Next.js proxies them to the server-only `BERRY_API_ORIGIN`. No secret
 * or upstream runtime URL belongs in this value.
 */
function apiBaseUrl(value: string | undefined): string {
   const candidate = value?.trim() ?? '';
   if (!candidate) return '';

   let parsed: URL;
   try {
      parsed = new URL(candidate);
   } catch {
      throw new Error('NEXT_PUBLIC_BERRY_API_URL must be an absolute HTTP(S) URL');
   }

   if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('NEXT_PUBLIC_BERRY_API_URL must be an HTTP(S) URL without credentials');
   }
   if (parsed.search || parsed.hash) {
      throw new Error('NEXT_PUBLIC_BERRY_API_URL must not include a query string or fragment');
   }

   return candidate.replace(/\/+$/, '');
}

export const API_BASE_URL = apiBaseUrl(process.env.NEXT_PUBLIC_BERRY_API_URL);

/** The same-origin proxy means the Berry API transport is configured by default. */
export const isApiConfigured = true;

/**
 * Board whose issues fill the list/board UI when discovery should be skipped.
 * Empty lets session bootstrap pick the first board the user can see.
 */
export const BOARD_ID = (process.env.NEXT_PUBLIC_BOARD_ID || '').trim();

/** True when an env board override is present. */
export const isBoardConfigured = BOARD_ID.length > 0;

/**
 * Development-only auto-login email.
 *
 * When set, the session store signs in as this account through
 * `POST /api/v1/auth/dev-login` when no session cookie is present, skipping the
 * sign-in screen. The server registers that route only in `development` and
 * `test` (it 404s anywhere else), so a stray value here cannot establish a
 * session against a production API. Leave empty to require GitHub sign-in.
 */
export const AUTO_LOGIN_EMAIL = (process.env.NEXT_PUBLIC_AUTO_LOGIN_EMAIL || '').trim();
