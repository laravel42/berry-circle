import { z } from 'zod';
import { BerryApiError, apiFetch } from './api';
import { connectionSchema, newIdempotencyKey } from './api-schemas';
import type { User } from '@/data/users';

/**
 * Approvals: the human decisions that gate a plan, a task's start, a
 * workflow's activation or one of its steps. Who may decide is the server's
 * rule — the addressee, or anyone holding the addressed role or a stronger
 * one — so the client only words the refusal.
 */

export const approvalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired']);
export const approvalRiskSchema = z.enum(['low', 'medium', 'high']);

export const approvalSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   kind: z.string(),
   risk: approvalRiskSchema,
   title: z.string(),
   description: z.string().nullish(),
   goalId: z.string().nullish(),
   planId: z.string().nullish(),
   issueId: z.string().nullish(),
   workflowId: z.string().nullish(),
   workflowRunId: z.string().nullish(),
   workflowStepRunId: z.string().nullish(),
   issue: z.object({ id: z.string(), identifier: z.string(), title: z.string() }).nullish(),
   requestedFrom: z
      .object({ userId: z.string().nullish(), role: z.string().nullish() })
      .default({ userId: null, role: null }),
   requestedBy: z.object({ type: z.string(), id: z.string() }).nullish(),
   status: approvalStatusSchema,
   decisionNote: z.string().nullish(),
   resolvedBy: z.string().nullish(),
   requestedAt: z.string(),
   expiresAt: z.string().nullish(),
   resolvedAt: z.string().nullish(),
});

const approvalConnectionSchema = connectionSchema(approvalSchema);

export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
export type ApprovalRisk = z.infer<typeof approvalRiskSchema>;
export type Approval = z.infer<typeof approvalSchema>;

function parseApproval(json: unknown): Approval {
   const parsed = approvalSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Approval response was not recognized');
   }
   return parsed.data;
}

export interface ApprovalsQuery {
   status?: ApprovalStatus;
   kind?: string;
   goalId?: string;
   issueId?: string;
   workflowId?: string;
   /** Only the pending approvals the caller may resolve. */
   mine?: boolean;
   first?: number;
}

export async function listWorkspaceApprovals(
   workspaceId: string,
   query: ApprovalsQuery = {}
): Promise<Approval[]> {
   const collected: Approval[] = [];
   const limit = query.first ?? 200;
   let after: string | undefined;
   for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ workspaceId, first: String(Math.min(limit, 100)) });
      if (query.status) params.set('status', query.status);
      if (query.kind) params.set('kind', query.kind);
      if (query.goalId) params.set('goalId', query.goalId);
      if (query.issueId) params.set('issueId', query.issueId);
      if (query.workflowId) params.set('workflowId', query.workflowId);
      if (query.mine) params.set('mine', 'true');
      if (after) params.set('after', after);
      const json: unknown = await apiFetch(`/api/v1/approvals?${params.toString()}`);
      const parsed = approvalConnectionSchema.safeParse(json);
      if (!parsed.success) {
         throw new Error('Approval list was not recognized');
      }
      collected.push(...parsed.data.nodes);
      const { hasNextPage, endCursor } = parsed.data.pageInfo;
      if (!hasNextPage || !endCursor || parsed.data.nodes.length === 0) break;
      if (collected.length >= limit) break;
      after = endCursor;
   }
   return collected.slice(0, limit);
}

/** Approvals for the store; a failed read leaves the list empty. */
export async function loadWorkspaceApprovals(
   workspaceId: string,
   query: ApprovalsQuery = {}
): Promise<Approval[]> {
   if (!workspaceId) return [];
   try {
      return await listWorkspaceApprovals(workspaceId, query);
   } catch {
      return [];
   }
}

export async function getApproval(approvalId: string, signal?: AbortSignal): Promise<Approval> {
   const json: unknown = await apiFetch(
      `/api/v1/approvals/${encodeURIComponent(approvalId)}`,
      undefined,
      { signal }
   );
   return parseApproval(json);
}

async function decide(
   approvalId: string,
   decision: 'approve' | 'reject',
   note?: string
): Promise<Approval> {
   const json: unknown = await apiFetch(
      `/api/v1/approvals/${encodeURIComponent(approvalId)}/${decision}`,
      {
         method: 'POST',
         headers: { 'Idempotency-Key': newIdempotencyKey() },
         body: JSON.stringify(note?.trim() ? { note: note.trim() } : {}),
      }
   );
   return parseApproval(json);
}

/** Throws `FORBIDDEN` (`details.reason`), `APPROVAL_RESOLVED`, `APPROVAL_REQUIRED`. */
export function approveApproval(approvalId: string, note?: string): Promise<Approval> {
   return decide(approvalId, 'approve', note);
}

export function rejectApproval(approvalId: string, note?: string): Promise<Approval> {
   return decide(approvalId, 'reject', note);
}

export interface CreateIssueStartApprovalInput {
   workspaceId: string;
   issueId: string;
   title: string;
   description?: string;
   requestedFromUserId?: string;
   requestedFromRole?: 'owner' | 'admin' | 'member';
   risk?: ApprovalRisk;
   expiresAt?: string;
}

/** Opens a manual gate on a task; without an addressee it goes to admins. */
export async function createIssueStartApproval(
   input: CreateIssueStartApprovalInput
): Promise<Approval> {
   const body: Record<string, string> = {
      workspaceId: input.workspaceId,
      kind: 'issueStart',
      issueId: input.issueId,
      title: input.title,
   };
   if (input.description) body.description = input.description;
   if (input.requestedFromUserId) body.requestedFromUserId = input.requestedFromUserId;
   else if (input.requestedFromRole) body.requestedFromRole = input.requestedFromRole;
   if (input.risk) body.risk = input.risk;
   if (input.expiresAt) body.expiresAt = input.expiresAt;
   const json: unknown = await apiFetch('/api/v1/approvals', {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      body: JSON.stringify(body),
   });
   return parseApproval(json);
}

// ---------------------------------------------------------------------------
// Reading an approval

export function isApprovalPending(approval: Pick<Approval, 'status'>): boolean {
   return approval.status === 'pending';
}

export function describeApprovalKind(kind: string): string {
   switch (kind) {
      case 'plan':
         return 'Start a plan';
      case 'issueStart':
         return 'Start a task';
      case 'workflowActivation':
         return 'Activate a workflow';
      case 'workflowStep':
         return 'Workflow step';
      case 'integrationAction':
         return 'External action';
      default:
         return kind;
   }
}

export function describeApprovalStatus(status: string): string {
   switch (status) {
      case 'pending':
         return 'Pending';
      case 'approved':
         return 'Approved';
      case 'rejected':
         return 'Rejected';
      case 'expired':
         return 'Expired';
      default:
         return status;
   }
}

/** "Andrea", "any admin", "anyone". */
export function describeRequestedFrom(
   requestedFrom: Approval['requestedFrom'],
   members: User[]
): string {
   if (requestedFrom.userId) {
      const member = members.find((candidate) => candidate.id === requestedFrom.userId);
      return member?.name ?? 'one person';
   }
   if (requestedFrom.role) return `any ${requestedFrom.role}`;
   return 'anyone';
}

/** "expires in 2 days", "expired", or null when open-ended. */
export function describeApprovalExpiry(
   expiresAt: string | null | undefined,
   now = Date.now()
): string | null {
   if (!expiresAt) return null;
   const then = new Date(expiresAt).getTime();
   if (Number.isNaN(then)) return null;
   const ms = then - now;
   if (ms <= 0) return 'expired';
   const minutes = Math.round(ms / 60_000);
   if (minutes < 60) return `expires in ${minutes}m`;
   const hours = Math.round(minutes / 60);
   if (hours < 48) return `expires in ${hours}h`;
   return `expires in ${Math.round(hours / 24)} days`;
}

/** Why a decision was refused, for the person who tried. */
export function describeApprovalFailure(error: unknown): string {
   if (error instanceof BerryApiError) {
      switch (error.code) {
         case 'FORBIDDEN': {
            const details = error.details as { reason?: string } | null;
            if (details?.reason === 'not_addressee') {
               return 'This approval is addressed to someone else.';
            }
            if (details?.reason === 'admin_required') {
               return 'An admin has to decide this one.';
            }
            return 'You are not allowed to decide this approval.';
         }
         case 'APPROVAL_RESOLVED':
            return 'This approval was already decided.';
         case 'APPROVAL_REQUIRED':
            return 'Another approval still holds this task.';
         case 'CONFLICT':
            return error.message;
         case 'NOT_FOUND':
            return 'The approval could not be found.';
         default:
            return error.message;
      }
   }
   return 'The approval request failed.';
}

/** The `details.reason` of a refused decision, when it was a permission refusal. */
export function approvalRefusalReason(error: unknown): 'not_addressee' | 'admin_required' | null {
   if (!(error instanceof BerryApiError) || error.code !== 'FORBIDDEN') return null;
   const details = error.details as { reason?: string } | null;
   if (details?.reason === 'not_addressee' || details?.reason === 'admin_required') {
      return details.reason;
   }
   return null;
}
