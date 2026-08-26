import {
   approvePlan,
   describePlanFailure,
   getPlan,
   rejectPlan as rejectPlanRequest,
   compilePlan as compilePlanRequest,
   type PlanRecord,
} from '@/lib/plans';
import { create } from 'zustand';

/** What the store is doing to a plan right now, for buttons to reflect. */
export type PlanBusyStage = 'loading' | 'starting' | 'rejecting' | 'compiling';

interface PlanState {
   /** Records by plan id, so a drawer and a page over the same plan share one. */
   records: Record<string, PlanRecord>;
   /** Why a plan could not be loaded, by id. */
   errors: Record<string, string | null>;
   busy: Record<string, PlanBusyStage | null>;
   /** The version an edit must name to be accepted (`expectedVersion` for patches). */
   expectedVersion: (planId: string) => number | undefined;
   upsertRecord: (record: PlanRecord) => void;
   /**
    * Fetch a plan. A refresh of a plan already held is quiet — no busy
    * stage, no error on a dropped poll — so a live preview never flickers.
    */
   loadPlan: (
      planId: string,
      options?: { signal?: AbortSignal }
   ) => Promise<PlanRecord | undefined>;
   startPlan: (planId: string) => Promise<PlanRecord>;
   rejectPlan: (planId: string) => Promise<PlanRecord>;
   compilePlan: (planId: string) => Promise<PlanRecord>;
}

function isAbort(error: unknown): boolean {
   return error instanceof DOMException && error.name === 'AbortError';
}

export const usePlanStore = create<PlanState>((set, get) => ({
   records: {},
   errors: {},
   busy: {},

   expectedVersion: (planId) => get().records[planId]?.version,

   upsertRecord: (record) =>
      set((state) => {
         // Polls can land out of order; an older snapshot must not undo a
         // newer one. Equal timestamps still replace, so a re-read after an
         // action always wins.
         const existing = state.records[record.id];
         if (existing && existing.updatedAt > record.updatedAt) return state;
         return {
            records: { ...state.records, [record.id]: record },
            errors: { ...state.errors, [record.id]: null },
         };
      }),

   loadPlan: async (planId, options = {}) => {
      const quiet = Boolean(get().records[planId]);
      if (!quiet) {
         set((state) => ({ busy: { ...state.busy, [planId]: 'loading' } }));
      }
      try {
         const record = await getPlan(planId, options.signal);
         get().upsertRecord(record);
         return record;
      } catch (error) {
         if (isAbort(error) || options.signal?.aborted) return undefined;
         if (!quiet) {
            set((state) => ({
               errors: { ...state.errors, [planId]: describePlanFailure(error) },
            }));
         }
         return undefined;
      } finally {
         if (!quiet) {
            set((state) => ({ busy: { ...state.busy, [planId]: null } }));
         }
      }
   },

   startPlan: async (planId) => {
      set((state) => ({ busy: { ...state.busy, [planId]: 'starting' } }));
      try {
         const record = await approvePlan(planId);
         get().upsertRecord(record);
         return record;
      } finally {
         set((state) => ({ busy: { ...state.busy, [planId]: null } }));
      }
   },

   rejectPlan: async (planId) => {
      set((state) => ({ busy: { ...state.busy, [planId]: 'rejecting' } }));
      try {
         const record = await rejectPlanRequest(planId);
         get().upsertRecord(record);
         return record;
      } finally {
         set((state) => ({ busy: { ...state.busy, [planId]: null } }));
      }
   },

   compilePlan: async (planId) => {
      set((state) => ({ busy: { ...state.busy, [planId]: 'compiling' } }));
      try {
         const record = await compilePlanRequest(planId);
         get().upsertRecord(record);
         return record;
      } finally {
         set((state) => ({ busy: { ...state.busy, [planId]: null } }));
      }
   },
}));
