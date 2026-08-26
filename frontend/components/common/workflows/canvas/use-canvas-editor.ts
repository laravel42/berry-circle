'use client';

import { BerryApiError } from '@/lib/api';
import type { FieldError } from '@/lib/plans';
import {
   TRIGGER_NODE_ID,
   applyDefinitionOperation,
   definitionProblems,
   lastOpenStep,
   nextStepId,
   sourceHandles,
   type DefinitionOperation,
   type LinkHandle,
} from '@/lib/workflow-definition';
import {
   definitionFieldErrors,
   describeDefinitionPath,
   describeWorkflowFailure,
   getWorkflow,
   isWorkflowEditable,
   patchWorkflow,
   type Workflow,
   type WorkflowDefinitionInput,
   type WorkflowStepInput,
   type WorkflowTriggerInput,
} from '@/lib/workflows';
import { useWorkflowsStore } from '@/store/workflows-store';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
   draftFromStep,
   newStepDraft,
   stepDraftProblem,
   toStepInput,
   type StepKind,
} from '../create-workflow-steps';
import {
   autoLayout,
   completeLayout,
   layoutFromStored,
   type CanvasLayout,
   type Point,
} from './layout';
import type { CanvasFinding } from './to-flow';

/** How long a dragged node may rest before its position is saved. */
const LAYOUT_SAVE_DELAY_MS = 600;

export interface CanvasEditor {
   working: WorkflowDefinitionInput;
   layout: CanvasLayout;
   editable: boolean;
   dirty: boolean;
   saving: boolean;
   /** The revision the working copy was read at; what every `PATCH` sends. */
   baseRevision: number;
   /** Bumps whenever the working copy is replaced from the server, so editors reset. */
   resetKey: number;
   /** Findings by step id; `null` holds the trigger's and the whole definition's. */
   findings: Map<string | null, CanvasFinding[]>;
   /** True while a finding blocks saving. */
   blocked: boolean;
   /** A newer revision on the server while there are unsaved changes here. */
   conflict: Workflow | null;
   selectedNodeId: string | null;
   selectedEdgeId: string | null;
   select: (nodeId: string | null) => void;
   selectEdge: (edgeId: string | null) => void;
   apply: (operation: DefinitionOperation) => boolean;
   addStep: (type: StepKind, from?: { source: string; handle: LinkHandle }) => void;
   updateStep: (step: WorkflowStepInput) => void;
   setTrigger: (trigger: WorkflowTriggerInput) => void;
   moveNode: (nodeId: string, point: Point, settled: boolean) => void;
   tidy: () => void;
   save: () => Promise<boolean>;
   discard: () => void;
   /** Resolve a conflict by saving this copy over the newer revision. */
   keepMine: () => Promise<boolean>;
   /** Resolve a conflict by taking the newer revision and dropping this copy. */
   takeTheirs: () => void;
}

interface Adopted {
   working: WorkflowDefinitionInput;
   layout: CanvasLayout;
   baseRevision: number;
}

function adopt(workflow: Workflow): Adopted {
   const working = workflow.definitionSource;
   return {
      working,
      layout: completeLayout(working, layoutFromStored(workflow.layout)),
      baseRevision: workflow.revision,
   };
}

function pushFinding(
   map: Map<string | null, CanvasFinding[]>,
   key: string | null,
   finding: CanvasFinding
): void {
   const list = map.get(key) ?? [];
   list.push(finding);
   map.set(key, list);
}

/** Field errors keyed by the step they name, given the step order they were computed against. */
function placeFieldErrors(
   map: Map<string | null, CanvasFinding[]>,
   errors: FieldError[],
   stepIds: string[]
): void {
   for (const error of errors) {
      const where = describeDefinitionPath(error.path);
      const stepId =
         where.scope === 'step' && where.stepIndex !== null ? stepIds[where.stepIndex] : undefined;
      pushFinding(map, stepId ?? null, {
         message: where.field ? `${where.field}: ${error.message}` : error.message,
         severity: error.severity,
         hint: error.hint,
      });
   }
}

/**
 * The canvas's working copy of a workflow: edits land here first, one
 * `Save` sends the definition and layout together with the revision they
 * were read at, and dragging alone saves the layout on its own. Whatever
 * the server answers — a newer revision, invalid fields — is turned into
 * something a person can act on beside the node it concerns.
 */
export function useCanvasEditor(workflow: Workflow): CanvasEditor {
   const upsertWorkflow = useWorkflowsStore((state) => state.upsertWorkflow);
   const editable = isWorkflowEditable(workflow);

   const [state, setState] = useState<Adopted>(() => adopt(workflow));
   const [dirty, setDirty] = useState(false);
   const [saving, setSaving] = useState(false);
   const [resetKey, setResetKey] = useState(0);
   const [conflict, setConflict] = useState<Workflow | null>(null);
   const [serverErrors, setServerErrors] = useState<{ fields: FieldError[]; stepIds: string[] }>({
      fields: [],
      stepIds: [],
   });
   const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
   const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

   // Refs mirror the state a queued save has to read after it was scheduled.
   const stateRef = useRef(state);
   stateRef.current = state;
   const dirtyRef = useRef(dirty);
   dirtyRef.current = dirty;
   const queueRef = useRef<Promise<unknown>>(Promise.resolve());
   const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

   /** One request at a time, in order, so a later save never carries an older revision. */
   const enqueue = useCallback(<T>(task: () => Promise<T>): Promise<T> => {
      const run = queueRef.current.then(task, task);
      queueRef.current = run.then(
         () => undefined,
         () => undefined
      );
      return run;
   }, []);

   const replaceFrom = useCallback((next: Workflow) => {
      setState(adopt(next));
      setDirty(false);
      setConflict(null);
      setServerErrors({ fields: [], stepIds: [] });
      setResetKey((key) => key + 1);
   }, []);

   // A revision the store learnt about that this copy has not seen: take it
   // when nothing is pending here, otherwise hold it up as a conflict.
   useEffect(() => {
      if (workflow.revision === stateRef.current.baseRevision) return;
      if (workflow.revision < stateRef.current.baseRevision) return;
      if (dirtyRef.current) {
         setConflict(workflow);
      } else if (!saving) {
         replaceFrom(workflow);
      }
   }, [workflow, saving, replaceFrom]);

   useEffect(
      () => () => {
         if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
      },
      []
   );

   const saveLayout = useCallback(() => {
      if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
      layoutTimerRef.current = setTimeout(() => {
         if (dirtyRef.current) return; // the definition save carries it
         const { layout, baseRevision } = stateRef.current;
         void enqueue(() => patchWorkflow(workflow.id, { layout, revision: baseRevision }))
            .then((updated) => {
               upsertWorkflow(updated);
               setState((current) => ({ ...current, baseRevision: updated.revision }));
            })
            .catch(async (error: unknown) => {
               if (error instanceof BerryApiError && error.code === 'REVISION_CONFLICT') {
                  try {
                     const latest = await getWorkflow(workflow.id);
                     upsertWorkflow(latest);
                     if (!dirtyRef.current) replaceFrom(latest);
                     toast.error('Someone else changed this workflow; the canvas was reloaded.');
                  } catch {
                     toast.error(describeWorkflowFailure(error));
                  }
                  return;
               }
               toast.error(describeWorkflowFailure(error));
            });
      }, LAYOUT_SAVE_DELAY_MS);
   }, [enqueue, workflow.id, upsertWorkflow, replaceFrom]);

   const apply = useCallback(
      (operation: DefinitionOperation): boolean => {
         if (!editable) return false;
         const result = applyDefinitionOperation(stateRef.current.working, operation);
         if (!result.ok) {
            toast.error(result.error);
            return false;
         }
         setState((current) => ({
            ...current,
            working: result.definition,
            layout: completeLayout(result.definition, current.layout),
         }));
         setDirty(true);
         setServerErrors({ fields: [], stepIds: [] });
         if (operation.type === 'remove_step') {
            setSelectedNodeId((selected) => (selected === operation.stepId ? null : selected));
         }
         return true;
      },
      [editable]
   );

   const addStep = useCallback(
      (type: StepKind, from?: { source: string; handle: LinkHandle }) => {
         const working = stateRef.current.working;
         const id = nextStepId(working, type);
         const step = toStepInput(newStepDraft(type), id);
         let attach = from;
         if (!attach) {
            const selected = selectedNodeId
               ? working.steps.find((candidate) => candidate.id === selectedNodeId)
               : undefined;
            if (selectedNodeId === TRIGGER_NODE_ID) {
               attach = { source: TRIGGER_NODE_ID, handle: 'next' };
            } else if (selected) {
               attach = { source: selected.id, handle: sourceHandles(selected)[0] };
            } else {
               const open = lastOpenStep(working);
               attach = open ? { source: open.id, handle: 'next' } : undefined;
            }
         }
         if (apply({ type: 'add_step', step, from: attach })) {
            setSelectedNodeId(id);
            setSelectedEdgeId(null);
         }
      },
      [apply, selectedNodeId]
   );

   const updateStep = useCallback(
      (step: WorkflowStepInput) => {
         apply({ type: 'update_step', stepId: step.id, step });
      },
      [apply]
   );

   const setTrigger = useCallback(
      (trigger: WorkflowTriggerInput) => {
         apply({ type: 'set_trigger', trigger });
      },
      [apply]
   );

   const moveNode = useCallback(
      (nodeId: string, point: Point, settled: boolean) => {
         if (!editable) return;
         setState((current) => ({
            ...current,
            layout: {
               ...current.layout,
               [nodeId]: { x: Math.round(point.x), y: Math.round(point.y) },
            },
         }));
         if (settled) saveLayout();
      },
      [editable, saveLayout]
   );

   const tidy = useCallback(() => {
      if (!editable) return;
      setState((current) => ({ ...current, layout: autoLayout(current.working) }));
      saveLayout();
   }, [editable, saveLayout]);

   const problems = useMemo(() => definitionProblems(state.working), [state.working]);

   const findings = useMemo(() => {
      const map = new Map<string | null, CanvasFinding[]>();
      for (const problem of problems) {
         pushFinding(map, problem.stepId, {
            message: problem.message,
            severity: problem.severity,
         });
      }
      for (const step of state.working.steps) {
         const draft = draftFromStep(step);
         const problem = draft ? stepDraftProblem(draft) : null;
         if (problem) pushFinding(map, step.id, { message: problem, severity: 'error' });
      }
      if (serverErrors.fields.length > 0) {
         placeFieldErrors(map, serverErrors.fields, serverErrors.stepIds);
      } else if (!dirty) {
         const stored = workflow.definition.steps.map((step) => step.id);
         placeFieldErrors(map, workflow.validation.errors, stored);
         placeFieldErrors(map, workflow.validation.warnings, stored);
      }
      return map;
   }, [problems, state.working, serverErrors, dirty, workflow]);

   const blocked = useMemo(() => {
      if (problems.some((problem) => problem.severity === 'error')) return true;
      return state.working.steps.some((step) => {
         const draft = draftFromStep(step);
         return draft ? stepDraftProblem(draft) !== null : false;
      });
   }, [problems, state.working]);

   const send = useCallback(
      async (revision: number): Promise<boolean> => {
         if (!editable) return false;
         if (blocked) {
            toast.error('Fix the marked steps before saving.');
            return false;
         }
         if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
         const { working, layout } = stateRef.current;
         setSaving(true);
         try {
            const updated = await enqueue(() =>
               patchWorkflow(workflow.id, { definition: working, layout, revision })
            );
            upsertWorkflow(updated);
            replaceFrom(updated);
            toast.success(`Saved as v${updated.version}`);
            return true;
         } catch (error) {
            if (error instanceof BerryApiError && error.code === 'REVISION_CONFLICT') {
               try {
                  const latest = await getWorkflow(workflow.id);
                  upsertWorkflow(latest);
                  setConflict(latest);
               } catch {
                  toast.error(describeWorkflowFailure(error));
               }
               return false;
            }
            const fields = definitionFieldErrors(error);
            if (fields.length > 0) {
               setServerErrors({ fields, stepIds: working.steps.map((step) => step.id) });
            }
            toast.error(describeWorkflowFailure(error));
            return false;
         } finally {
            setSaving(false);
         }
      },
      [editable, blocked, enqueue, workflow.id, upsertWorkflow, replaceFrom]
   );

   const save = useCallback(() => send(stateRef.current.baseRevision), [send]);

   const keepMine = useCallback(async () => {
      const latest = conflict ?? (await getWorkflow(workflow.id));
      return send(latest.revision);
   }, [conflict, send, workflow.id]);

   const takeTheirs = useCallback(() => {
      const latest = conflict ?? workflow;
      replaceFrom(latest);
   }, [conflict, workflow, replaceFrom]);

   const discard = useCallback(() => {
      replaceFrom(useWorkflowsStore.getState().getWorkflowById(workflow.id) ?? workflow);
   }, [workflow, replaceFrom]);

   const select = useCallback((nodeId: string | null) => {
      setSelectedNodeId(nodeId);
      if (nodeId) setSelectedEdgeId(null);
   }, []);

   const selectEdge = useCallback((edgeId: string | null) => {
      setSelectedEdgeId(edgeId);
      if (edgeId) setSelectedNodeId(null);
   }, []);

   return {
      working: state.working,
      layout: state.layout,
      editable,
      dirty,
      saving,
      baseRevision: state.baseRevision,
      resetKey,
      findings,
      blocked,
      conflict,
      selectedNodeId,
      selectedEdgeId,
      select,
      selectEdge,
      apply,
      addStep,
      updateStep,
      setTrigger,
      moveNode,
      tidy,
      save,
      discard,
      keepMine,
      takeTheirs,
   };
}
