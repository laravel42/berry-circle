import { isApprovalPending, type Approval } from '@/lib/approvals';
import { create } from 'zustand';

interface ApprovalsState {
   approvals: Approval[];
   error: string | null;
   loaded: boolean;
   hydrateApprovals: (approvals: Approval[], error?: string | null) => void;
   upsertApproval: (approval: Approval) => void;
   getApprovalById: (approvalId: string) => Approval | undefined;
}

function sortApprovals(approvals: Approval[]): Approval[] {
   return approvals
      .slice()
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
}

export const useApprovalsStore = create<ApprovalsState>((set, get) => ({
   approvals: [],
   error: null,
   loaded: false,
   hydrateApprovals: (approvals, error = null) =>
      set({ approvals: sortApprovals(approvals), error, loaded: true }),
   upsertApproval: (approval) =>
      set((state) => {
         const next = state.approvals.filter((candidate) => candidate.id !== approval.id);
         next.push(approval);
         return { approvals: sortApprovals(next), error: null };
      }),
   getApprovalById: (approvalId) => get().approvals.find((approval) => approval.id === approvalId),
}));

/** How many decisions are waiting in the workspace; the goal page and inbox header read it. */
export function selectPendingCount(state: ApprovalsState): number {
   return state.approvals.filter(isApprovalPending).length;
}

export function selectPendingApprovals(state: ApprovalsState): Approval[] {
   return state.approvals.filter(isApprovalPending);
}
