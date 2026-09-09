import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { BoardRepository } from '../core/boards.ts';
import type { ReviewQueue, ReviewState } from '../core/review-queue.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import { GitHubClient, GitHubError } from '../integrations/github.ts';
import { parseRepository } from '../agents/checkout.ts';

/**
 * `/api/v1/reviews`: the human review gate.
 *
 * Reads only. A decision is the issue changing status through its own route,
 * so nothing here can move a task in a way the board would not.
 */

export interface ReviewMountOptions {
   sessions: SessionService;
   boards: BoardRepository;
   queue: ReviewQueue;
   /** A credential for the workspace's repository, when the deployment has one. */
   gitCredential: ((workspaceId: string) => Promise<{ password: string }>) | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A diff a person can still read in a browser. The tail is cut, and says so. */
const MAX_DIFF_BYTES = 1024 * 1024;

export function reviewMounts(options: ReviewMountOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   route.get('/', async (context) => {
      const url = new URL(context.req.url);
      const workspaceId = url.searchParams.get('workspaceId') ?? '';
      if (!UUID.test(workspaceId)) {
         throw new ApiError(422, 'VALIDATION_FAILED', 'workspaceId must be a canonical UUID.');
      }
      const state = url.searchParams.get('state') ?? 'open';
      if (state !== 'open' && state !== 'completed') {
         throw new ApiError(422, 'VALIDATION_FAILED', 'state is open or completed.');
      }
      await authorize(options, context.get('user').id, workspaceId);
      return json({ nodes: await options.queue.list(workspaceId, state as ReviewState) });
   });

   route.get('/:runId/diff', async (context) => {
      const runId = context.req.param('runId');
      if (!UUID.test(runId)) throw ApiError.notFound('Run');
      const target = await options.queue.pullRequestOf(runId);
      if (!target) throw ApiError.notFound('Pull request');
      await authorize(options, context.get('user').id, target.workspaceId);
      if (!options.gitCredential) {
         throw new ApiError(412, 'GITHUB_UNAVAILABLE', 'This deployment has no GitHub credential to read the diff with.');
      }
      const { owner, name } = parseRepository(target.repository);
      const client = new GitHubClient({ token: (await options.gitCredential(target.workspaceId)).password });
      const diff = await client.pullRequestDiff(owner, name, target.number).catch((error: unknown) => {
         if (error instanceof GitHubError) {
            throw new ApiError(502, 'GITHUB_UNAVAILABLE', `GitHub could not serve the diff: ${error.message}`);
         }
         throw error;
      });
      const bounded =
         Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES
            ? `${Buffer.from(diff, 'utf8').subarray(0, MAX_DIFF_BYTES).toString('utf8')}\n… the diff was cut at 1 MiB; open the pull request for the rest.\n`
            : diff;
      return new Response(bounded, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
   });

   return [{ prefix: '/api/v1/reviews', handler: route }];
}

async function authorize(options: ReviewMountOptions, userId: string, workspaceId: string): Promise<void> {
   await options.boards.authorizeWorkspace(userId, workspaceId, 'product.read').catch((error: unknown) => {
      if (error instanceof NotFound) throw ApiError.notFound('Workspace');
      if (error instanceof Forbidden) {
         throw new ApiError(403, 'REVIEW_FORBIDDEN', 'You cannot read reviews in this workspace.');
      }
      throw error;
   });
}
