/**
 * Workspace configuration for the Berry frontend.
 *
 * All values are `NEXT_PUBLIC_*` so they are inlined at build time and
 * usable in both server and client components.
 */

/** URL segment used for workspace-scoped routes (`/{WORKSPACE_SLUG}/…`). */
export const WORKSPACE_SLUG = process.env.NEXT_PUBLIC_WORKSPACE_SLUG || 'berry';

/** Display name of the workspace. */
export const WORKSPACE_NAME = process.env.NEXT_PUBLIC_WORKSPACE_NAME || 'Berry';

/** Prefix of issue identifiers created by this frontend (e.g. `BERRY-123`). */
export const ISSUE_IDENTIFIER_PREFIX = process.env.NEXT_PUBLIC_ISSUE_PREFIX || 'BERRY';
