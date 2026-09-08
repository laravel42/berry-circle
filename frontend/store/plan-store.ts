import {
   answerPlan as answerPlanRequest,
   approvePlan,
   describePlanFailure,
   getPlan,
   rejectPlan as rejectPlanRequest,
   compilePlan as compilePlanRequest,
   type PlanAnswerInput,
   type PlanRecord,
} from '@/lib/plans';
import { create } from 'zustand';

/** What the store is doing to a plan right now, for buttons to reflect. */
export type PlanBusyStage = 'loading' | 'starting' | 'rejecting' | 'compiling' | 'answering';

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
   /**
    * Plans that should start themselves the moment they are startable.
    *
    * Set when a project led by the AI workflow created the plan: choosing that
    * lead is the consent, so nobody is asked to press Start Plan a second time.
    */
   autoStart: Record<string, boolean>;
   markAutoStart: (planId: string) => void;
   /** Reads the flag and clears it, so a plan is started at most once. */
   takeAutoStart: (planId: string) => boolean;
   startPlan: (planId: string) => Promise<PlanRecord>;
   /**
    * Answers a blocked plan's questions.
    *
    * Everything after this runs on the server — regenerate, compile, route —
    * so the returned record is the plan back in generation, not the finished
    * one. The page follows the rest through the workspace stream.
    */
   answerPlan: (planId: string, answers: PlanAnswerInput[]) => Promise<PlanRecord>;
   rejectPlan: (planId: string) => Promise<PlanRecord>;
   compilePlan: (planId: string) => Promise<PlanRecord>;
}

/**
 * Plan ids waiting to start themselves, kept in `sessionStorage`.
 *
 * Generating takes a minute or two, and a reload in that window would
 * otherwise drop the intent and leave the plan sitting at a proposal nobody
 * asked for. Session-scoped rather than local: it describes what this tab is
 * in the middle of, not a lasting preference.
 */
const AUTO_START_KEY = 'berry.plan.auto-start';

function readAutoStart(): Record<string, boolean> {
   if (typeof window === 'undefined') return {};
   try {
      const raw = window.sessionStorage.getItem(AUTO_START_KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, boolean> = {};
      for (const [id, value] of Object.entries(parsed)) if (value === true) out[id] = true;
      return out;
   } catch {
      return {};
   }
}

function writeAutoStart(value: Record<string, boolean>): void {
   if (typeof window === 'undefined') return;
   try {
      window.sessionStorage.setItem(AUTO_START_KEY, JSON.stringify(value));
   } catch {
      // A tab with storage blocked still starts plans, just not across reloads.
   }
}

function isAbort(error: unknown): boolean {
   return error instanceof DOMException && error.name === 'AbortError';
}

export const usePlanStore = create<PlanState>((set, get) => ({
   records: {},
   errors: {},
   busy: {},
   autoStart: readAutoStart(),

   markAutoStart: (planId) =>
      set((state) => {
         const next = { ...state.autoStart, [planId]: true };
         writeAutoStart(next);
         return { autoStart: next };
      }),

   takeAutoStart: (planId) => {
      // Read through storage as well: another tab, or this one before a
      // reload, may hold the intent this store instance never saw.
      if (!get().autoStart[planId] && !readAutoStart()[planId]) return false;
      set((state) => {
         const next = { ...state.autoStart, ...readAutoStart() };
         delete next[planId];
         writeAutoStart(next);
         return { autoStart: next };
      });
      return true;
   },

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

   answerPlan: async (planId, answers) => {
      set((state) => ({ busy: { ...state.busy, [planId]: 'answering' } }));
      try {
         const record = await answerPlanRequest(planId, answers);
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
