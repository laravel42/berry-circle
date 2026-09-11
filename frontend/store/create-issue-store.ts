import { Status } from '@/data/status';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** What someone typed into the create-task modal and did not send. */
export interface IssueDraft {
   title: string;
   description: string;
}

interface CreateIssueState {
   isOpen: boolean;
   defaultStatus: Status | null;
   /**
    * The unsent draft, kept across closes and reloads.
    *
    * Closing the modal used to throw the words away, which is why the rail can
    * now show a dot: there is something to come back to. Only the text is
    * kept — status, assignee and project are one click each, and restoring a
    * stale project would put a task somewhere nobody asked for.
    */
   draft: IssueDraft | null;

   // Actions
   openModal: (status?: Status) => void;
   closeModal: () => void;
   setDefaultStatus: (status: Status | null) => void;
   /** Remember the words; an empty draft is no draft. */
   setDraft: (draft: IssueDraft) => void;
   clearDraft: () => void;
}

export const useCreateIssueStore = create<CreateIssueState>()(
   persist(
      (set) => ({
         // Initial state
         isOpen: false,
         defaultStatus: null,
         draft: null,

         // Actions
         openModal: (status) => set({ isOpen: true, defaultStatus: status || null }),
         closeModal: () => set({ isOpen: false }),
         setDefaultStatus: (status) => set({ defaultStatus: status }),
         setDraft: (draft) =>
            set({
               draft: draft.title.trim() || draft.description.trim() ? draft : null,
            }),
         clearDraft: () => set({ draft: null }),
      }),
      {
         name: 'berry.create-issue',
         version: 1,
         // Only the draft survives a reload. Whether the modal was open is a
         // fact about the last session, and reopening it on load would greet
         // everyone who ever pressed C with a dialog they did not ask for.
         partialize: (state) => ({ draft: state.draft }),
      }
   )
);

/** True when there is unsent text waiting, which is what the rail's dot means. */
export function hasIssueDraft(draft: IssueDraft | null): boolean {
   return Boolean(draft && (draft.title.trim() || draft.description.trim()));
}
