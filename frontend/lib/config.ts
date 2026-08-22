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
 * Prefix of issue identifiers created by this frontend (e.g. `BERRY-123`).
 */
export const ISSUE_IDENTIFIER_PREFIX = process.env.NEXT_PUBLIC_ISSUE_PREFIX || 'BERRY';

/**
 * Base URL of the Berry gateway (BFF). Empty string = not configured yet;
 * the app boots with empty data until the gateway is wired (BERR-29/30).
 */
export const API_BASE_URL = (process.env.NEXT_PUBLIC_BERRY_API_URL || '').replace(/\/$/, '');

/** True once a gateway base URL has been configured. */
export const isApiConfigured = API_BASE_URL.length > 0;
