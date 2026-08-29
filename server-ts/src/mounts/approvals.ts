import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { assertValid, decodeBody, fieldError } from '../http/body.ts';
import { decodeTimeCursor, encodeCursor, parsePageQuery } from '../http/cursor.ts';
import { ApiError } from '../http/errors.ts';
import { idempotent } from '../http/idempotent.ts';
import type { IdempotencyStore } from '../http/idempotency.ts';
import type { Mount } from '../http/registry.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import type { Role } from '../identity/roles.ts';
import type { BoardRepository } from '../core/boards.ts';
import type { IssueRepository } from '../core/issues.ts';
import {
   ApprovalResolved,
   GateExists,
   NotAddressee,
   toColumnKind,
   type Approval,
   type ApprovalRepository,
   type ApprovalRisk,
} from '../approvals/repository.ts';
import { pathId } from './shared.ts';

/**
 * `/api/v1/approvals`.
 *
 * The gate is the product: Berry's claim is that an agent's work reaches a
 * person before it reaches anything else. This is where a person answers.
 *
 * Nothing here decides who may answer — the repository does, in the same
 * transaction as the decision, because a check performed here and enforced
 * there is two rules that can disagree. This mount's job is the wire: parse,
 * page, and turn each refusal into the shape the contract promises.
 */

const RISKS = new Set(['low', 'medium', 'high']);
const STATUSES = new Set(['pending', 'approved', 'rejected', 'expired']);
const KINDS = new Set(['plan', 'issueStart', 'integrationAction']);
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 10_000;
const MAX_NOTE = 2_000;

const FILTERS = ['workspaceId', 'status', 'kind', 'goalId', 'issueId', 'mine'] as const;

export interface ApprovalOptions {
   sessions: SessionService;
   approvals: ApprovalRepository;
   boards: BoardRepository;
   issues: IssueRepository;
   idempotency: IdempotencyStore;
}

export function approvalMounts(options: ApprovalOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { approvals, boards, issues } = options;

   route.get('/', async (context) => {
      const url = new URL(context.req.url);
      const workspaceId = url.searchParams.get('workspaceId');
      if (!workspaceId) {
         assertValid([fieldError('/workspaceId', 'required', 'workspaceId is required.')]);
      }
      const scope = await authorizeWorkspace(context, boards, workspaceId!, 'product.read');

      const page = parsePageQuery(url, FILTERS);
      const filter = parseFilter(url, { userId: context.get('user').id, role: scope.role as Role });
      const cursorScope = filterScope(workspaceId!, url);
      const after = page.after === '' ? null : decodeTimeCursor(page.after, cursorScope);

      const rows = await approvals.list(workspaceId!, filter, after, page.first + 1);
      const hasNextPage = rows.length > page.first;
      const nodes = hasNextPage ? rows.slice(0, page.first) : rows;
      const last = nodes.at(-1);
      return json({
         nodes: nodes.map(serializeApproval),
         pageInfo: {
            hasNextPage,
            endCursor: last
               ? encodeCursor(cursorScope, { createdAt: last.requestedAt, id: last.id })
               : null,
         },
      });
   });

   /**
    * Opens a gate by hand.
    *
    * Only `issueStart`: a `plan` gate belongs to the plan that raised it and
    * an `integrationAction` gate to the agent that asked, and neither is a
    * thing a person opens from a page.
    */
   route.post('/', idempotent(options.idempotency), async (context) => {
      const { value: body } = await decodeBody<{
         workspaceId?: string;
         kind?: string;
         issueId?: string;
         title?: string;
         description?: string;
         requestedFromUserId?: string;
         requestedFromRole?: string;
         risk?: string;
         expiresAt?: string;
      }>(context, {
         workspaceId: 'string',
         kind: 'string',
         issueId: 'string',
         title: 'string',
         description: 'string',
         requestedFromUserId: 'string',
         requestedFromRole: 'string',
         risk: 'string',
         expiresAt: 'string',
      });

      const problems = [];
      if (!body.workspaceId) problems.push(fieldError('/workspaceId', 'required', 'workspaceId is required.'));
      if (body.kind !== undefined && body.kind !== 'issueStart') {
         problems.push(fieldError('/kind', 'invalid_value', 'Only issueStart gates are opened by hand.'));
      }
      if (!body.issueId) problems.push(fieldError('/issueId', 'required', 'issueId is required.'));
      const title = (body.title ?? '').trim();
      if (title === '') problems.push(fieldError('/title', 'required', 'title is required.'));
      if (title.length > MAX_TITLE) {
         problems.push(fieldError('/title', 'too_long', `title is at most ${MAX_TITLE} characters.`));
      }
      if ((body.description ?? '').length > MAX_DESCRIPTION) {
         problems.push(
            fieldError('/description', 'too_long', `description is at most ${MAX_DESCRIPTION} characters.`)
         );
      }
      if (body.risk !== undefined && !RISKS.has(body.risk)) {
         problems.push(fieldError('/risk', 'invalid_value', 'risk is low, medium or high.'));
      }
      if (body.requestedFromRole !== undefined && !['owner', 'admin', 'member'].includes(body.requestedFromRole)) {
         problems.push(
            fieldError('/requestedFromRole', 'invalid_value', 'requestedFromRole is owner, admin or member.')
         );
      }
      if (problems.length > 0) assertValid(problems);

      await authorizeWorkspace(context, boards, body.workspaceId!, 'product.write');
      // The task has to be one the caller can reach, and in this workspace.
      await issues.authorize(context.get('user').id, body.issueId!, 'product.write').catch(rethrow('Issue'));

      try {
         const approval = await approvals.open({
            workspaceId: body.workspaceId!,
            issueId: body.issueId!,
            title,
            description: (body.description ?? '').trim() || null,
            risk: (body.risk as ApprovalRisk | undefined) ?? 'medium',
            requestedFromUserId: body.requestedFromUserId ?? null,
            requestedFromRole: body.requestedFromRole ?? null,
            requestedBy: context.get('user').id,
            expiresAt: body.expiresAt ?? null,
         });
         const response = json(serializeApproval(approval), 201);
         response.headers.set('Location', `/api/v1/approvals/${approval.id}`);
         return response;
      } catch (error) {
         if (error instanceof GateExists) {
            throw new ApiError(409, 'CONFLICT', 'This task already has a gate waiting on it.', {
               approvalId: error.approvalId,
            });
         }
         if (error instanceof NotFound) throw ApiError.notFound('Issue');
         throw error;
      }
   });

   route.get('/:approvalId', async (context) => {
      const approval = await load(context.req.param('approvalId'));
      await authorizeWorkspace(context, boards, approval.workspaceId, 'product.read');
      return json(serializeApproval(approval));
   });

   for (const [path, decision] of [
      ['/:approvalId/approve', 'approved'],
      ['/:approvalId/reject', 'rejected'],
   ] as const) {
      route.post(path, idempotent(options.idempotency), async (context) => {
         const approval = await load(context.req.param('approvalId'));
         const scope = await authorizeWorkspace(context, boards, approval.workspaceId, 'product.write');
         const { value: body } = await decodeBody<{ note?: string }>(context, { note: 'string' });
         const note = (body.note ?? '').trim();
         if (note.length > MAX_NOTE) {
            assertValid([fieldError('/note', 'too_long', `note is at most ${MAX_NOTE} characters.`)]);
         }

         try {
            const resolved = await approvals.resolve({
               approvalId: approval.id,
               decision,
               userId: context.get('user').id,
               role: scope.role as Role,
               note: note || null,
            });
            return json(serializeApproval(resolved));
         } catch (error) {
            if (error instanceof NotAddressee) {
               // `details.reason` is what the page words: "an admin has to
               // decide this one" reads differently from "this one is
               // addressed to someone else".
               throw new ApiError(403, 'FORBIDDEN', error.message, { reason: error.reason });
            }
            if (error instanceof ApprovalResolved) {
               throw new ApiError(409, 'APPROVAL_RESOLVED', 'This approval has already been decided.');
            }
            if (error instanceof NotFound) throw ApiError.notFound('Approval');
            throw error;
         }
      });
   }

   return [{ prefix: '/api/v1/approvals', handler: route }];

   async function load(raw: string | undefined): Promise<Approval> {
      return approvals.get(pathId(raw, 'Approval')).catch(() => {
         throw ApiError.notFound('Approval');
      });
   }
}

// ------------------------------------------------------------------ helpers

export function serializeApproval(approval: Approval): Record<string, unknown> {
   return {
      id: approval.id,
      workspaceId: approval.workspaceId,
      kind: approval.kind,
      risk: approval.risk,
      title: approval.title,
      description: approval.description,
      goalId: approval.goalId,
      planId: approval.planId,
      issueId: approval.issueId,
      issue: approval.issue,
      requestedFrom: approval.requestedFrom,
      requestedBy: approval.requestedBy,
      status: approval.status,
      decisionNote: approval.decisionNote,
      resolvedBy: approval.resolvedBy,
      requestedAt: approval.requestedAt,
      expiresAt: approval.expiresAt,
      resolvedAt: approval.resolvedAt,
   };
}

function parseFilter(url: URL, caller: { userId: string; role: Role }) {
   const status = url.searchParams.get('status');
   if (status !== null && !STATUSES.has(status)) {
      assertValid([fieldError('/status', 'invalid_value', 'status is not an approval status.')]);
   }
   const kind = url.searchParams.get('kind');
   if (kind !== null && !KINDS.has(kind)) {
      assertValid([fieldError('/kind', 'invalid_value', 'kind is not an approval kind.')]);
   }
   const goalId = uuidParam(url, 'goalId');
   const issueId = uuidParam(url, 'issueId');
   return {
      ...(status === null ? {} : { status }),
      ...(kind === null ? {} : { kind: toColumnKind(kind) }),
      ...(goalId === null ? {} : { goalId }),
      ...(issueId === null ? {} : { issueId }),
      ...(url.searchParams.get('mine') === 'true' ? { mine: caller } : {}),
   };
}

function uuidParam(url: URL, name: string): string | null {
   const value = url.searchParams.get(name);
   if (value === null) return null;
   if (!/^[0-9a-f-]{36}$/i.test(value)) {
      assertValid([fieldError(`/${name}`, 'invalid_value', `${name} is not an identifier.`)]);
   }
   return value;
}

/** A cursor is only valid for the query that produced it. */
function filterScope(workspaceId: string, url: URL): string {
   const parts = ['status', 'kind', 'goalId', 'issueId', 'mine'].map(
      (name) => url.searchParams.get(name) ?? 'any'
   );
   return `approvals.${workspaceId}.${parts.join('.')}`;
}

async function authorizeWorkspace(
   context: { get: (key: 'user') => { id: string } },
   boards: BoardRepository,
   workspaceId: string,
   permission: 'product.read' | 'product.write'
) {
   return boards.authorizeWorkspace(context.get('user').id, workspaceId, permission).catch((error) => {
      // "Not yours" and "does not exist" read the same, so an error cannot be
      // used to discover which workspace ids are real.
      if (error instanceof NotFound || error instanceof Forbidden) throw ApiError.notFound('Workspace');
      throw error;
   });
}

function rethrow(resource: string) {
   return (error: unknown): never => {
      if (error instanceof NotFound || error instanceof Forbidden) throw ApiError.notFound(resource);
      throw error;
   };
}
