import { Hono } from 'hono';
import type { AuthVariables } from '../auth/middleware.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import { assertValid, fieldError } from '../http/body.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import type { IssueRepository } from '../core/issues.ts';
import { DependencyCycle, type DependencyRepository } from '../core/dependencies.ts';
import type { ReviewRepository } from '../core/reviews.ts';
import type { GateOutcome } from '../agents/review-gate.ts';

/**
 * `/api/v1/issues/:issueRef/dependencies` and `/reviews`.
 *
 * Both hang under an issue and belong to it, so like comments they are a
 * router the issues mount owns rather than a mount of their own.
 */

export interface IssueRelationOptions {
   issues: IssueRepository;
   dependencies: DependencyRepository;
   reviews: ReviewRepository;
   /** Null when the deployment has no model credential to review with. */
   gate?: { reviewLatest(issueId: string, options?: { force?: boolean }): Promise<GateOutcome> } | null;
   clock?: () => Date;
}

export function issueRelationRoutes(options: IssueRelationOptions) {
   const { issues, dependencies, reviews } = options;
   const clock = options.clock ?? (() => new Date());
   const route = new Hono<{ Variables: AuthVariables }>();

   route.get('/:issueRef/dependencies', async (context) => {
      const issue = await resolve(issues, context.req.param('issueRef'), context.get('user').id, 'product.read');
      return json(await dependencies.list(issue.id));
   });

   route.post('/:issueRef/dependencies', async (context) => {
      const issue = await resolve(issues, context.req.param('issueRef'), context.get('user').id, 'product.write');
      const scope = await issues
         .authorize(context.get('user').id, issue.id, 'product.write')
         .catch(rethrowIssue);

      const body = await readBody(context.req.raw);
      const reference = typeof body.dependsOn === 'string' ? body.dependsOn.trim() : '';
      if (reference === '') {
         assertValid([
            fieldError('/dependsOn', 'invalid_type', 'dependsOn names the blocking issue by id or identifier.'),
         ]);
      }

      // The blocker is resolved and workspace-checked here rather than left to
      // the foreign key, because "not in your workspace" and "does not exist"
      // must read the same — otherwise the error tells a caller which issue
      // identifiers exist elsewhere.
      const blocker = await issues.get(reference).catch(() => null);
      if (!blocker || blocker.workspaceId !== scope.workspaceId) throw blockerNotFound();

      await dependencies
         .add({
            workspaceId: scope.workspaceId,
            issueId: issue.id,
            dependsOnIssueId: blocker.id,
            createdBy: context.get('user').id,
            createdAt: clock().toISOString(),
         })
         .catch(rethrowEdge);

      // The whole graph, not just the edge added: the caller is rendering both
      // lists and would otherwise have to ask again.
      return json(await dependencies.list(issue.id), 201);
   });

   route.delete('/:issueRef/dependencies/:dependsOnRef', async (context) => {
      const issue = await resolve(issues, context.req.param('issueRef'), context.get('user').id, 'product.write');
      const scope = await issues
         .authorize(context.get('user').id, issue.id, 'product.write')
         .catch(rethrowIssue);

      const blocker = await issues.get(context.req.param('dependsOnRef') ?? '').catch(() => null);
      if (!blocker || blocker.workspaceId !== scope.workspaceId) throw blockerNotFound();

      await dependencies.remove(issue.id, blocker.id).catch((error: unknown) => {
         if (error instanceof NotFound) {
            throw new ApiError(404, 'NOT_FOUND', 'That dependency does not exist.');
         }
         throw error;
      });
      return new Response(null, { status: 204 });
   });

   /**
    * The AutoGate verdicts on an issue.
    *
    * A failure here answers with an empty list rather than an error: the issue
    * and its activity are what the page is for, and a missing verdict list
    * must not take the page down with it.
    */
   route.get('/:issueRef/reviews', async (context) => {
      const issue = await resolve(issues, context.req.param('issueRef'), context.get('user').id, 'product.read');
      const found = await reviews.list(issue.id).catch(() => []);
      return json({ reviews: found });
   });

   /**
    * Asks a peer agent to review the task's latest delivered run now, whether
    * or not its plan opted into AutoGate. The verdict lands where `GET` reads
    * it, and the task moves as the verdict says.
    */
   route.post('/:issueRef/reviews', async (context) => {
      const issue = await resolve(issues, context.req.param('issueRef'), context.get('user').id, 'product.write');
      if (!options.gate) {
         throw new ApiError(412, 'REVIEWER_UNAVAILABLE', 'This deployment has no model credential, so no agent can review.');
      }
      const outcome = await options.gate.reviewLatest(issue.id, { force: true });
      if (outcome.kind === 'skipped') {
         throw new ApiError(409, 'REVIEW_SKIPPED', describeSkip(outcome.because), { because: outcome.because });
      }
      return json({ outcome, reviews: await reviews.list(issue.id).catch(() => []) }, 201);
   });

   return route;
}

function describeSkip(because: string): string {
   switch (because) {
      case 'no_pull_request':
         return 'This task has no delivered pull request to review.';
      case 'no_reviewer':
         return 'No peer agent could review this task.';
      case 'not_in_review':
         return 'Only a task in review can be reviewed.';
      case 'attempts_exhausted':
         return 'This task has been sent back as many times as the gate allows; a person decides now.';
      default:
         return 'The task was not reviewed.';
   }
}

/** Resolves the issue in the path and checks the caller may act on it. */
async function resolve(
   issues: IssueRepository,
   reference: string | undefined,
   userId: string,
   permission: 'product.read' | 'product.write'
) {
   // Fetched before authorization because the reference may be an identifier,
   // and the issue's own id is what the check needs.
   const issue = await issues.get(reference ?? '').catch(rethrowIssue);
   await issues.authorize(userId, issue.id, permission).catch(rethrowIssue);
   return issue;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
   const raw = await request.text();
   let parsed: unknown;
   try {
      parsed = JSON.parse(raw === '' ? '{}' : raw);
   } catch {
      throw new ApiError(400, 'INVALID_REQUEST', 'The request body is not valid JSON.');
   }
   if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ApiError(400, 'INVALID_REQUEST', 'The request body is not valid JSON.');
   }
   for (const key of Object.keys(parsed)) {
      if (key !== 'dependsOn') {
         assertValid([
            fieldError('/', 'invalid_type', 'The request body contains an unknown field or invalid value.'),
         ]);
      }
   }
   return parsed as Record<string, unknown>;
}

function blockerNotFound(): ApiError {
   return new ApiError(404, 'ISSUE_NOT_FOUND', 'The blocking issue was not found.');
}

function rethrowEdge(error: unknown): never {
   if (error instanceof DependencyCycle) {
      throw new ApiError(409, 'DEPENDENCY_CYCLE', 'That dependency would make the issue wait on itself.');
   }
   if (error instanceof NotFound) throw blockerNotFound();
   throw error;
}

function rethrowIssue(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Issue');
   if (error instanceof Forbidden) {
      throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
   }
   throw error;
}
