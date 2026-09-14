import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * The fields the task composer can offer beside the title and description.
 *
 * Every one of them is optional at creation — the server fills a default for
 * any that is absent — so hiding one costs nothing but the click it saves.
 */
export type CreateField = 'status' | 'priority' | 'assignee' | 'project';

export const CREATE_FIELDS: readonly CreateField[] = ['status', 'priority', 'assignee', 'project'];

interface UiPrefsState {
   /**
    * Keep the comment box pinned to the bottom of a task, rather than letting
    * it sit at the end of the activity feed and scroll away with it.
    */
   stickyCommentBar: boolean;
   /** Offer chat as a panel that follows you, rather than only its own page. */
   floatingChat: boolean;
   /** Which selectors the task composer shows. */
   createFields: Record<CreateField, boolean>;
   setStickyCommentBar: (sticky: boolean) => void;
   setFloatingChat: (floating: boolean) => void;
   setCreateField: (field: CreateField, shown: boolean) => void;
}

/**
 * Preferences about how Berry looks on *this* machine.
 *
 * These are deliberately not on the account. Each one answers a question about
 * the screen in front of you — a wide monitor wants the composer's whole row
 * of selectors, a laptop rarely does — and syncing that across devices would
 * mean one device's answer overriding another's. The account keeps what is
 * genuinely about the person: their language, timezone and theme.
 *
 * Everything is on by default. A preference that starts hidden is a feature
 * nobody discovers.
 */
export const useUiPrefsStore = create<UiPrefsState>()(
   persist(
      (set) => ({
         stickyCommentBar: true,
         floatingChat: true,
         createFields: { status: true, priority: true, assignee: true, project: true },
         setStickyCommentBar: (stickyCommentBar) => set({ stickyCommentBar }),
         setFloatingChat: (floatingChat) => set({ floatingChat }),
         setCreateField: (field, shown) =>
            set((state) => ({ createFields: { ...state.createFields, [field]: shown } })),
      }),
      {
         name: 'berry-ui-prefs',
         // A field added after someone's preferences were stored has no answer
         // in them, and the honest reading of a missing answer is the default:
         // shown. Merging per key rather than replacing is what keeps that
         // true.
         merge: (persisted, current) => {
            const stored = persisted as Partial<UiPrefsState> | undefined;
            return {
               ...current,
               ...stored,
               createFields: { ...current.createFields, ...stored?.createFields },
            };
         },
      }
   )
);
