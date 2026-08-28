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
   // Sessions. Both servers read one session table, so a token minted by
   // either is accepted by either — which is what makes moving this safe
   // mid-migration rather than a cutover.
   '/api/v1/auth',
   '/api/v1/auth/:path*',

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

   // Issues: the collection, one issue, and its comments. Reviews,
   // dependencies, attachments and runs still hang below and stay on Go.
   '/api/v1/issues',
   '/api/v1/issues/:issueRef',
   '/api/v1/issues/:issueRef/comments',
   '/api/v1/issues/:issueRef/dependencies',
   '/api/v1/issues/:issueRef/dependencies/:dependsOnRef',
   '/api/v1/issues/:issueRef/reviews',

   // One comment, by id — a link to a comment has to work without knowing
   // which issue it is on.
   '/api/v1/comments/:commentId',

   // The realtime streams, one per board and one per workspace. They replay
   // from PostgreSQL, so either server answers the same question the same way.
   '/api/v1/events',

   // Goals, including the sub-lists that read AUTOMATE's and the planner's
   // tables. Those move because they depend on the tables, not on the code
   // whose mounts stay on Go.
   '/api/v1/goals',
   '/api/v1/goals/:goalId',
   '/api/v1/goals/:goalId/issues',
   '/api/v1/goals/:goalId/issues/:issueRef',
   '/api/v1/goals/:goalId/workflows',
   '/api/v1/goals/:goalId/approvals',
   '/api/v1/goals/:goalId/plans',

   // Attachments reached by their own id — what a listing's downloadUrl
   // points at. `/api/v1/issues/:ref/attachments` stays on Go, because
   // routing that path would move the upload with it. See SCOPE.md.
   '/api/v1/attachments/:attachmentId',
   '/api/v1/attachments/:attachmentId/download',
   '/api/v1/attachments/:attachmentId/download-url',

   // Projects: the collection, one project, and its resources.
   // `/:projectId/generated-issues` is absent — it decomposes a project with
   // an agent, which this server has no runtime for.
   '/api/v1/projects',
   '/api/v1/projects/:projectId',
   '/api/v1/projects/:projectId/resources',
   '/api/v1/projects/:projectId/resources/:resourceId',

   // Agents: the collection, the two literal sub-paths, one agent and its
   // configuration. The literals come first because `/:agentId` would
   // otherwise swallow them — Next matches these in order.
   //
   // `/:agentId/ask` is absent and stays on Go: it is a chat completion
   // through OpenFang, nothing in the product calls it, and what it should
   // mean under ADK is a separate decision from moving the mount.
   '/api/v1/agents',
   '/api/v1/agents/capabilities',
   '/api/v1/agents/models',
   '/api/v1/agents/:agentId',
   '/api/v1/agents/:agentId/config',
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
