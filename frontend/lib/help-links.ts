/**
 * Where the help menu points.
 *
 * Berry is self-hosted, so there is no address these can be hardcoded to: one
 * deployment's documentation is an internal wiki, another's is a fork's README,
 * and a third has none. Each is therefore a build-time setting, and an unset
 * one renders as a disabled row rather than a link to somebody else's site.
 */

function externalUrl(value: string | undefined): string | null {
   const candidate = (value ?? '').trim();
   if (!candidate) return null;
   // Only absolute http(s): a `javascript:` or relative value here would be a
   // link the deployment did not mean to publish.
   try {
      const parsed = new URL(candidate);
      return ['http:', 'https:'].includes(parsed.protocol) ? candidate : null;
   } catch {
      return null;
   }
}

export const DOCS_URL = externalUrl(process.env.NEXT_PUBLIC_DOCS_URL);
export const CHANGELOG_URL = externalUrl(process.env.NEXT_PUBLIC_CHANGELOG_URL);
export const FEEDBACK_URL = externalUrl(process.env.NEXT_PUBLIC_FEEDBACK_URL);
