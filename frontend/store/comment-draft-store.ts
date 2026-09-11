import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Half-written comments, kept per task.
 *
 * A comment on a task is often written across two sittings — you start a
 * reply, go and read the thing you are replying about, and come back. Before
 * this, closing the task threw the text away, which teaches people to write
 * comments somewhere else and paste them in.
 *
 * Persisted because "I closed the tab" is the case that hurts; keyed by task
 * identifier because that is what the URL carries.
 */

interface CommentDraftState {
   drafts: Record<string, string>;
   setDraft: (issueRef: string, text: string) => void;
   clearDraft: (issueRef: string) => void;
}

export const useCommentDraftStore = create<CommentDraftState>()(
   persist(
      (set) => ({
         drafts: {},
         setDraft: (issueRef, text) =>
            set((state) => ({ drafts: { ...state.drafts, [issueRef]: text } })),
         clearDraft: (issueRef) =>
            set((state) => {
               const drafts = { ...state.drafts };
               delete drafts[issueRef];
               return { drafts };
            }),
      }),
      { name: 'comment-drafts-v1' }
   )
);
