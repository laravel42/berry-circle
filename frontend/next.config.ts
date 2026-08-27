import type { NextConfig } from 'next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = path.dirname(fileURLToPath(import.meta.url));
/** pnpm workspace root — Turbopack must resolve `next` from here, not `frontend/`. */
const repoRoot = path.join(frontendDir, '..');

function berryApiOrigin(): string {
   const candidate = (process.env.BERRY_API_ORIGIN || 'http://127.0.0.1:4000').trim();

   let parsed: URL;
   try {
      parsed = new URL(candidate);
   } catch {
      throw new Error('BERRY_API_ORIGIN must be an absolute HTTP(S) URL');
   }

   if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('BERRY_API_ORIGIN must be an HTTP(S) URL without credentials');
   }
   if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('BERRY_API_ORIGIN must be an origin without a path, query, or fragment');
   }

   return parsed.origin;
}

/**
 * The TypeScript server, when one is running.
 *
 * Unset means every request goes to Go, which is the current production shape
 * — so this file changes nothing until a deployment opts in. Setting it moves
 * only the prefixes listed in `TYPESCRIPT_ROUTES` below.
 */
function berryTypeScriptOrigin(): string | null {
   const candidate = (process.env.BERRY_TS_API_ORIGIN || '').trim();
   if (!candidate) return null;

   let parsed: URL;
   try {
      parsed = new URL(candidate);
   } catch {
      throw new Error('BERRY_TS_API_ORIGIN must be an absolute HTTP(S) URL');
   }
   if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('BERRY_TS_API_ORIGIN must be an HTTP(S) URL without credentials');
   }
   if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('BERRY_TS_API_ORIGIN must be an origin without a path, query, or fragment');
   }
   return parsed.origin;
}

/**
 * Prefixes the TypeScript server answers, in match order.
 *
 * Only routes verified against Go appear here. The patterns are deliberately
 * narrow: `/api/v1/issues/:issueRef` matches one segment, so
 * `/api/v1/issues/BER-1/comments` falls through to Go, which is the only
 * server that has comments. A `:path*` here would 404 every nested route.
 *
 * Both servers read one database, so a request landing on either is correct —
 * the risk is a route that exists on Go and not on TypeScript, not a route
 * answered by the wrong one.
 */
const TYPESCRIPT_ROUTES: readonly string[] = [
   // Fully ported mounts, including everything nested beneath them.
   '/api/v1/me',
   '/api/v1/me/:path*',
   '/api/v1/workspaces',
   '/api/v1/workspaces/:path*',
   '/api/v1/tokens',
   '/api/v1/tokens/:path*',
   '/api/v1/invitations',
   '/api/v1/invitations/:path*',

   // Boards: the collection and one board. `/:boardId/runs` stays on Go.
   '/api/v1/boards',
   '/api/v1/boards/:boardId',

   // Issues: the collection and one issue. Comments, reviews, dependencies,
   // attachments and runs all hang below and stay on Go.
   '/api/v1/issues',
   '/api/v1/issues/:issueRef',
];

const apiOrigin = berryApiOrigin();
const typeScriptOrigin = berryTypeScriptOrigin();

const nextConfig: NextConfig = {
   distDir: process.env.NEXT_DIST_DIR ?? '.next',
   devIndicators: false,
   experimental: {
      turbo: {
         root: repoRoot,
      },
   },
   async rewrites() {
      return [
         // Specific first: the catch-all below sends everything else to Go.
         ...(typeScriptOrigin
            ? TYPESCRIPT_ROUTES.map((source) => ({
                 source,
                 destination: `${typeScriptOrigin}${source}`,
              }))
            : []),
         {
            source: '/api/:path*',
            destination: `${apiOrigin}/api/:path*`,
         },
         {
            source: '/health',
            destination: `${apiOrigin}/health`,
         },
         {
            source: '/ready',
            destination: `${apiOrigin}/ready`,
         },
         {
            source: '/uploads/:path*',
            destination: `${apiOrigin}/uploads/:path*`,
         },
      ];
   },
};

export default nextConfig;
