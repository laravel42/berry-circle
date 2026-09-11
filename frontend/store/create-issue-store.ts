import { Status } from '@/data/status';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * The new-task dialog: what it was opened with, and what has been typed.
 *
 * Two different things, kept apart on purpose. The *context* is where the
 * dialog was opened from — a board column, a parent task, a project — and it
 * is thrown away when the dialog closes. The *draft* is what a person wrote,
 * and it survives, because closing a dialog by accident is not a decision to
 * discard a description someone spent five minutes on.
 */

export interface CreateIssueContext {
   /** Pre-selected column, when opened from a board. */
   defaultStatus: Status | null;
   /** Pre-selected project, when opened from inside one. */
   projectId: string | null;
   /** Pre-filled parent; `parentLocked` when the caller means it as a rule. */
   parentRef: string | null;
   parentLocked: boolean;
}

export interface CreateIssueDraft {
   title: string;
   description: string;
   statusId: string | null;
   priorityId: string | null;
   assignee: { type: 'user' | 'agent'; id: string; name: string } | null;
   squadId: string | null;
   projectId: string | null;
   dueDate: string;
   stage: string;
   labelIds: string[];
   /** Custom property values, applied once the task exists. */
   properties: Record<string, unknown>;
   /** Tasks to re-parent under the new one. */
   subIssueRefs: string[];
   /** The one-line prompt of the agent mode. */
   prompt: string;
}

export const EMPTY_DRAFT: CreateIssueDraft = {
   title: '',
   description: '',
   statusId: null,
   priorityId: null,
   assignee: null,
   squadId: null,
   projectId: null,
   dueDate: '',
   stage: '',
   labelIds: [],
   properties: {},
   subIssueRefs: [],
   prompt: '',
};

const EMPTY_CONTEXT: CreateIssueContext = {
   defaultStatus: null,
   projectId: null,
   parentRef: null,
   parentLocked: false,
};

interface CreateIssueState {
   isOpen: boolean;
   /** Kept as its own field for the callers that only set a column. */
   defaultStatus: Status | null;
   context: CreateIssueContext;
   draft: CreateIssueDraft;
   createAnother: boolean;

   openModal: (status?: Status) => void;
   openModalWith: (context: Partial<CreateIssueContext>) => void;
   closeModal: () => void;
   setDefaultStatus: (status: Status | null) => void;
   setDraft: (patch: Partial<CreateIssueDraft>) => void;
   resetDraft: () => void;
   setCreateAnother: (value: boolean) => void;
}

export const useCreateIssueStore = create<CreateIssueState>()(
   persist(
      (set) => ({
         isOpen: false,
         defaultStatus: null,
         context: EMPTY_CONTEXT,
         draft: EMPTY_DRAFT,
         createAnother: false,

         openModal: (status) =>
            set({
               isOpen: true,
               defaultStatus: status ?? null,
               context: { ...EMPTY_CONTEXT, defaultStatus: status ?? null },
            }),

         openModalWith: (context) =>
            set((state) => ({
               isOpen: true,
               defaultStatus: context.defaultStatus ?? state.defaultStatus,
               context: { ...EMPTY_CONTEXT, ...context },
            })),

         closeModal: () => set({ isOpen: false, context: EMPTY_CONTEXT }),
         setDefaultStatus: (defaultStatus) => set({ defaultStatus }),
         setDraft: (patch) => set((state) => ({ draft: { ...state.draft, ...patch } })),
         resetDraft: () => set({ draft: EMPTY_DRAFT }),
         setCreateAnother: (createAnother) => set({ createAnother }),
      }),
      {
         name: 'create-issue-v1',
         // Only what was typed. Whether the dialog is open, and what opened it,
         // belong to this visit.
         partialize: (state) => ({ draft: state.draft, createAnother: state.createAnother }),
      }
   )
);
